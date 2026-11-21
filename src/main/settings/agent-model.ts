import { Readable } from "node:stream";
import type { Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";
import type { SettingsRegistry } from "./registry.ts";
import { cleanModelStream } from "./stream.ts";

export type AgentBinding = ReturnType<SettingsRegistry["binding"]>;

export function modelApi(profile: AgentBinding["profile"]) {
  return profile.channel.api === "chat_completions" ? "openai-completions" : "openai-responses";
}

export async function openAgentStream(
  { profile, secret, openResponse }: AgentBinding,
  payload: Record<string, unknown>,
  redactor: ReturnType<SettingsRegistry["redactor"]>,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const responses = modelApi(profile) === "openai-responses";
  const configured = String(profile.channel.pathPrefix ?? "").trim() || "/v1";
  const prefix = `/${configured.replace(/^\/+|\/+$/g, "")}`;
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*$/.test(prefix))
    throw new ProviderError("PROVIDER_CONFIG_INVALID");
  const url = `${profile.endpoint}${prefix.replace(/\/$/, "")}${responses ? "/responses" : "/chat/completions"}`;
  const body = JSON.stringify(
    { ...payload, model: profile.model, stream: true, ...(responses && { store: false }) },
    (_key, value) => (typeof value === "string" ? redactor.redact(value) : value),
  );
  const remote = await openResponse(
    {
      method: "POST",
      url,
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: Buffer.from(body),
      timeoutMs,
      responseType: "text",
    },
    signal,
  );
  const status = remote.statusCode;
  if (status !== 200 || !remote.headers["content-type"]?.includes("text/event-stream")) {
    remote.destroy();
    throw new ProviderError(
      status === 401 || status === 403
        ? "AGENT_TEST_AUTH_FAILED"
        : status === 429
          ? "AGENT_TEST_RATE_LIMITED"
          : status === 200
            ? "AGENT_TEST_INVALID_STREAM"
            : "AGENT_TEST_HTTP_FAILED",
    );
  }

  async function* frames() {
    const clean = cleanModelStream(redactor, responses);
    remote.setEncoding("utf8");
    let bytes = 0;
    let buffer = "";
    for await (const chunk of remote) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 4 * 1024 * 1024) throw new ProviderError("PROVIDER_RESPONSE_LIMIT");
      buffer += chunk;
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) {
        const frame = clean(event);
        if (frame) yield Buffer.from(frame);
      }
    }
  }
  return Readable.from(frames(), { objectMode: false });
}

export async function probeAgentStream(
  binding: AgentBinding,
  redactor: ReturnType<SettingsRegistry["redactor"]>,
  timeoutMs = 25000,
  trial?: { prompt: string },
) {
  const api = modelApi(binding.profile);
  const protocol = api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi();
  const signal = AbortSignal.timeout(timeoutMs);
  const model: Model<typeof api> = {
    api,
    id: "connection-test",
    name: "Connection test",
    provider: "platform",
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: trial ? (binding.profile.config?.contextWindow ?? 32768) : 32768,
    maxTokens: trial ? (binding.profile.config?.maxOutputTokens ?? 64) : 64,
    ...(api === "openai-completions" && {
      compat: { maxTokensField: "max_tokens", supportsStore: false, supportsDeveloperRole: false },
    }),
  };
  let transportError: unknown;
  const started = performance.now();
  const result = await protocol
    .streamSimple(
      model,
      normalizeContext({
        messages: [
          { role: "user", content: trial?.prompt ?? "Reply with OK.", timestamp: Date.now() },
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
            const stream = await openAgentStream(binding, payload, redactor, timeoutMs, signal);
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
  if (
    result.stopReason !== "stop" ||
    !result.content.some((part) => part.type === "text" && part.text.trim())
  )
    throw new ProviderError("AGENT_TEST_INVALID_STREAM");
  return {
    tested: true,
    durationMs: Math.round(performance.now() - started),
    ...(trial && {
      text: result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
    }),
  } as const;
}
