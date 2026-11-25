import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { requirePresent } from "@link-studio/core";
import {
  DramaOutputTruncatedError,
  ProviderError,
} from "../../../packages/provider-runtime/src/runner.ts";
import { readTokenUsage, type TokenUsage } from "../generation-credits.ts";
import { type GatewayPurpose, gatewayDiagnostic } from "./gateway-diagnostic.ts";
import { geminiEndpoint, geminiRequest, geminiStream } from "./gemini-agent.ts";
import type { SettingsRegistry } from "./registry.ts";
import { cleanModelStream } from "./stream.ts";

type Gateway = Extract<ReturnType<SettingsRegistry["agentBinding"]>, { origin: "gateway" }>;
export type AgentBinding = Pick<
  ReturnType<SettingsRegistry["binding"]>,
  "profile" | "secret" | "openResponse"
> &
  Partial<Pick<Gateway, "acquireStream" | "observeAttempt">> & {
    observeUsage?: (usage: TokenUsage) => void;
  };

export function modelApi(profile: AgentBinding["profile"]) {
  return profile.channel.api === "chat_completions" || profile.channel.api === "gemini"
    ? "openai-completions"
    : "openai-responses";
}

export function agentDeadlineMs(profile: AgentBinding["profile"]) {
  return (
    (profile.config?.kind === "agent"
      ? (profile.config.agentDeadlineSeconds ?? 1800)
      : (profile.config?.timeoutSeconds ?? 90)) * 1000
  );
}

export async function openAgentStream(
  binding: AgentBinding,
  payload: Record<string, unknown>,
  redactor: ReturnType<SettingsRegistry["redactor"]>,
  timeoutMs: number,
  signal: AbortSignal,
  purpose: GatewayPurpose = "agent",
) {
  if (!binding.acquireStream) return agentAttempt(binding, payload, redactor, timeoutMs, signal);
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(timeoutMs))]);
  const lease = await binding.acquireStream(lifetime);
  let delivered = false;
  let retried = false;
  const canRetry = (error: unknown) =>
    !retried &&
    !delivered &&
    !lifetime.aborted &&
    error instanceof ProviderError &&
    error.code === "AGENT_TEST_TIMEOUT";
  const callId = randomUUID();
  let sequence = 0;
  const attempt = () =>
    agentAttempt(
      { ...binding, openResponse: lease.openResponse },
      payload,
      redactor,
      timeoutMs,
      lifetime,
      () => {
        delivered = true;
      },
      { call_id: callId, net_attempt: ++sequence, purpose },
    );
  let current: Readable;
  try {
    current = await attempt().catch((error) => {
      if (!canRetry(error)) throw error;
      retried = true;
      return attempt();
    });
  } catch (error) {
    lease.release();
    throw error;
  }
  async function* consume() {
    try {
      yield* current;
    } catch (error) {
      if (!canRetry(error)) throw error;
      retried = true;
      current = await attempt();
      yield* current;
    }
  }
  const stream = Readable.from(consume(), { objectMode: false, signal: lifetime });
  stream.once("close", () => {
    current.destroy();
    lease.release();
  });
  return stream;
}

async function agentAttempt(
  { profile, secret, openResponse, observeAttempt, observeUsage }: AgentBinding,
  payload: Record<string, unknown>,
  redactor: ReturnType<SettingsRegistry["redactor"]>,
  timeoutMs: number,
  signal: AbortSignal,
  markDelivered?: () => void,
  attempt?: { call_id: string; net_attempt: number; purpose: GatewayPurpose },
) {
  const responses = modelApi(profile) === "openai-responses";
  const gemini = profile.channel.api === "gemini";
  const configured = String(profile.channel.pathPrefix ?? "").trim() || "/v1";
  const prefix = `/${configured.replace(/^\/+|\/+$/g, "")}`;
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*$/.test(prefix))
    throw new ProviderError("PROVIDER_CONFIG_INVALID");
  const url = gemini
    ? geminiEndpoint(profile.endpoint, profile.model)
    : `${profile.endpoint}${prefix.replace(/\/$/, "")}${responses ? "/responses" : "/chat/completions"}`;
  const body = JSON.stringify(
    gemini
      ? geminiRequest(payload, profile.config?.video === true)
      : { ...payload, model: profile.model, stream: true, ...(responses && { store: false }) },
    (_key, value) => (typeof value === "string" ? redactor.redact(value) : value),
  );
  const idle = new AbortController();
  const requestSignal = AbortSignal.any([signal, idle.signal]);
  const bodyBytes = Buffer.from(body);
  const diagnostic =
    attempt &&
    observeAttempt &&
    gatewayDiagnostic(
      {
        ...attempt,
        channel: requirePresent(profile.channelId, "profile.channelId"),
        upstream_model: redactor.redact(profile.model),
        format: gemini ? "gemini" : responses ? "responses" : "openai",
        request_bytes: bodyBytes.length,
      },
      observeAttempt,
    );
  const idleTimer = setTimeout(
    () => idle.abort(new ProviderError("AGENT_TEST_TIMEOUT")),
    (profile.config?.timeoutSeconds ?? 90) * 1000,
  );
  idleTimer.unref();
  const remote = await openResponse(
    {
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${secret}`,
        ...(gemini && { "x-goog-api-key": secret ?? "" }),
      },
      body: bodyBytes,
      timeoutMs,
      responseType: "text",
    },
    requestSignal,
  ).catch((error) => {
    clearTimeout(idleTimer);
    diagnostic?.finish(requestSignal, "error", error);
    throw idle.signal.aborted ? idle.signal.reason : error;
  });
  idleTimer.refresh();
  remote.once("close", () => {
    clearTimeout(idleTimer);
    if (requestSignal.aborted) diagnostic?.finish(requestSignal, "close");
  });
  const status = remote.statusCode;
  diagnostic?.status(status);
  const hosted = profile.config?.kind === "agent" && !responses;
  const accepted = hosted ? status !== undefined && status >= 200 && status < 300 : status === 200;
  const whole = hosted && remote.headers["content-type"]?.includes("application/json");
  if (!accepted || (!hosted && !remote.headers["content-type"]?.includes("text/event-stream"))) {
    diagnostic?.finish(requestSignal, "error");
    remote.destroy();
    throw new ProviderError(
      status === 401 || status === 403
        ? "AGENT_TEST_AUTH_FAILED"
        : status === 429
          ? "AGENT_TEST_RATE_LIMITED"
          : status === 200
            ? "AGENT_TEST_INVALID_STREAM"
            : "AGENT_TEST_HTTP_FAILED",
      status && status >= 500 ? [{ path: "status", message: String(status) }] : undefined,
    );
  }

  async function* frames() {
    let finished = false;
    const offeredTools = new Set<string>();
    if (Array.isArray(payload.tools))
      for (const tool of payload.tools)
        if (typeof tool?.function?.name === "string") offeredTools.add(tool.function.name);
    const clean = cleanModelStream(
      redactor,
      responses,
      (data) => {
        diagnostic?.frame(data);
        if (observeUsage && data && typeof data === "object") {
          const frame = data as { usage?: unknown; response?: { usage?: unknown } };
          const usage = readTokenUsage(frame.usage ?? frame.response?.usage);
          if (usage) observeUsage(usage);
        }
        if (!hosted || gemini || !data || typeof data !== "object") return;
        if ("error" in data && data.error) throw new ProviderError("AGENT_TEST_HTTP_FAILED");
        if (
          "choices" in data &&
          Array.isArray(data.choices) &&
          data.choices.some(
            (choice) => typeof choice?.finish_reason === "string" && choice.finish_reason,
          )
        )
          finished = true;
      },
      offeredTools,
    );
    const translator = gemini ? geminiStream() : undefined;
    remote.setEncoding("utf8");
    let bytes = 0;
    let buffer = "";
    for await (const chunk of remote) {
      if (gemini || chunk.includes("\n")) idleTimer.refresh();
      if (!whole && !gemini && chunk.includes("\n")) markDelivered?.();
      bytes += Buffer.byteLength(chunk);
      if (bytes > (hosted ? 32 : 4) * 1024 * 1024)
        throw new ProviderError("PROVIDER_RESPONSE_LIMIT");
      buffer += chunk;
      if (whole) continue;
      const events = buffer.split(hosted || translator ? /\r?\n/ : /\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) {
        for (const wire of translator?.translate(event) ?? [event]) {
          let frame: string;
          try {
            frame = clean(wire);
          } catch (error) {
            if (hosted && error instanceof SyntaxError) continue;
            throw error;
          }
          if (frame) {
            markDelivered?.();
            yield Buffer.from(frame);
          }
          if (frame.endsWith("data: [DONE]\n\n")) return;
        }
      }
    }
    if (whole && !translator) {
      let result: {
        choices?: { message?: { role?: string; tool_calls?: object[] }; finish_reason?: string }[];
        usage?: unknown;
      } | null;
      try {
        result = JSON.parse(buffer);
      } catch {
        throw new ProviderError("AGENT_TEST_INVALID_STREAM");
      }
      const choice = result?.choices?.[0];
      if (!choice?.message || typeof choice.message !== "object")
        throw new ProviderError("AGENT_TEST_INVALID_STREAM");
      const delta = { ...choice.message, role: "assistant" };
      if (Array.isArray(delta.tool_calls))
        delta.tool_calls = delta.tool_calls.map((call: object, index: number) => ({
          ...call,
          index,
        }));
      yield Buffer.from(
        clean(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: choice.finish_reason || "stop" }] })}`,
        ),
      );
      if (result?.usage)
        yield Buffer.from(clean(`data: ${JSON.stringify({ choices: [], usage: result.usage })}`));
      yield Buffer.from("data: [DONE]\n\n");
    } else if (translator) {
      if (whole) {
        try {
          buffer = `data: ${JSON.stringify(JSON.parse(buffer))}`;
        } catch {
          throw new ProviderError("AGENT_TEST_INVALID_STREAM");
        }
      }
      for (const wire of [...translator.translate(buffer), ...translator.complete()])
        yield Buffer.from(clean(wire));
    } else if (hosted && buffer.trim()) {
      let frame: string | undefined;
      try {
        frame = clean(buffer);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      if (frame) yield Buffer.from(frame);
      if (frame?.endsWith("data: [DONE]\n\n")) return;
    }
    if (hosted && !translator && !whole && !finished)
      throw new ProviderError("AGENT_TEST_INVALID_STREAM");
  }
  async function* guardedFrames() {
    try {
      for await (const frame of frames()) {
        if (diagnostic && frame.subarray(-doneFrame.length).equals(doneFrame))
          diagnostic.finish(requestSignal, "done");
        yield frame;
      }
      diagnostic?.finish(requestSignal, "end");
    } catch (error) {
      diagnostic?.finish(requestSignal, "error", error);
      throw idle.signal.aborted ? idle.signal.reason : error;
    } finally {
      clearTimeout(idleTimer);
      remote.destroy();
    }
  }
  return Readable.from(guardedFrames(), { objectMode: false }).once("close", () => {
    diagnostic?.finish(requestSignal, "close");
    remote.destroy();
  });
}

const doneFrame = Buffer.from("data: [DONE]\n\n");

export async function probeAgentStream(
  binding: AgentBinding,
  redactor: ReturnType<SettingsRegistry["redactor"]>,
  timeoutMs = 25000,
  trial?: {
    prompt: string;
    images?: string[];
    video?: { mime_type: string; data: string };
    signal?: AbortSignal;
    generation?: boolean;
    drama?: boolean;
  },
) {
  const api = modelApi(binding.profile);
  const protocol = api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi();
  const timeout = AbortSignal.timeout(Math.ceil(timeoutMs));
  const signal = trial?.signal ? AbortSignal.any([timeout, trial.signal]) : timeout;
  const model: Model<typeof api> = {
    api,
    id: "connection-test",
    name: "Connection test",
    provider: "platform",
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: trial?.images?.length ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: trial ? (binding.profile.config?.contextWindow ?? 32768) : 32768,
    maxTokens: trial
      ? (binding.profile.config?.maxOutputTokens ?? (trial.generation ? 2048 : 64))
      : 64,
    ...(api === "openai-completions" && {
      compat: { maxTokensField: "max_tokens", supportsStore: false, supportsDeveloperRole: false },
    }),
  };
  let transportError: unknown;
  let usage: TokenUsage | undefined;
  const started = performance.now();
  const result = await protocol
    .streamSimple(
      model,
      normalizeContext({
        ...(trial?.generation &&
          !trial.drama && { systemPrompt: binding.profile.config?.systemPrompt }),
        messages: [
          {
            role: "user",
            content: trial?.images?.length
              ? [
                  { type: "text", text: trial.prompt },
                  ...trial.images.map((url) => {
                    const match =
                      /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(url);
                    if (!match) throw new ProviderError("无效的本机图片输入");
                    return {
                      type: "image" as const,
                      mimeType: requirePresent(match[1], "match[1]"),
                      data: requirePresent(match[2], "match[2]"),
                    };
                  }),
                ]
              : (trial?.prompt ?? "Reply with OK."),
            timestamp: Date.now(),
          },
        ],
      }),
      {
        apiKey: "unused",
        cacheRetention: "none",
        maxTokens: model.maxTokens,
        maxRetries: 0,
        signal,
        fetch: async (_input, init) => {
          try {
            const payload = JSON.parse(String(init?.body));
            if (trial?.drama && !binding.profile.config?.maxOutputTokens) {
              delete payload.max_tokens;
              delete payload.max_output_tokens;
              delete payload.max_completion_tokens;
            }
            if (trial?.video) {
              payload.messages = [
                {
                  role: "user",
                  content: [
                    { type: "text", text: trial.prompt },
                    { type: "video", video: trial.video },
                  ],
                },
              ];
            }
            const purpose = trial?.generation
              ? "generation"
              : trial?.video
                ? "video_inspect"
                : trial
                  ? "model_trial"
                  : "connection_test";
            const open = () =>
              openAgentStream(
                trial?.generation
                  ? {
                      ...binding,
                      observeUsage: (value) => {
                        usage = value;
                      },
                    }
                  : binding,
                payload,
                redactor,
                timeoutMs,
                signal,
                purpose,
              );
            let stream: Readable;
            for (let attempt = 0; ; attempt++) {
              try {
                stream = await open();
                break;
              } catch (error) {
                if (
                  !trial?.drama ||
                  attempt >= 3 ||
                  !(error instanceof ProviderError) ||
                  !(
                    error.code === "AGENT_TEST_RATE_LIMITED" ||
                    error.issues?.some(
                      (issue) => issue.path === "status" && /^5\d\d$/.test(issue.message),
                    )
                  )
                )
                  throw error;
                await delay([2000, 5000, 10000][attempt], undefined, { signal });
              }
            }
            stream.once("error", (error) => {
              transportError = error;
            });
            return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
              headers: { "content-type": "text/event-stream" },
            });
          } catch (error) {
            transportError = error;
            throw error;
          }
        },
      },
    )
    .result();
  if (signal.aborted) throw new ProviderError("AGENT_TEST_TIMEOUT");
  if (transportError instanceof ProviderError) throw transportError;
  if (transportError) throw new ProviderError("AGENT_TEST_NETWORK_FAILED");
  if (trial?.drama && result.stopReason === "length") throw new DramaOutputTruncatedError();
  if (
    result.stopReason !== "stop" ||
    !result.content.some((part) => part.type === "text" && part.text.trim())
  )
    throw new ProviderError("AGENT_TEST_INVALID_STREAM");
  return {
    tested: true,
    ...(usage && { usage }),
    durationMs: Math.round(performance.now() - started),
    ...(trial && {
      text: result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
    }),
  } as const;
}
