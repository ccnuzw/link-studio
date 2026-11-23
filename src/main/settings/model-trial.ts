import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  configuredGenerationInput,
  isPublicReferenceURL,
  mediaReferenceBytes,
  modelGenerationModes,
  modelGenerationOptions,
} from "../../../packages/link-studio-core/src/media-generation.ts";
import { validCustomInput } from "../../../packages/link-studio-core/src/model-config.ts";
import { providerInput } from "../../../packages/link-studio-core/src/provider-input.ts";
import type {
  SettingsInput,
  SettingsValues,
} from "../../../packages/link-studio-core/src/settings-api.ts";
import type { HostRequest, ReferenceMedia } from "../../../packages/provider-runtime/src/host.ts";
import { ProviderError, record } from "../../../packages/provider-runtime/src/runner.ts";
import { probeAgentStream } from "./agent-model.ts";
import { openProviderResponse, providerTransport } from "./network.ts";
import { providerPollDelay } from "./provider-poll.ts";
import type { SettingsRegistry } from "./registry.ts";
import { inlineTrialImage, trialMediaLimit, trialOutputMime } from "./trial-media.ts";
import { traceBody } from "./trial-trace-body.ts";

type Trial = SettingsInput<"modelTrial">;
type Result = SettingsValues["modelTrial"];
export type TrialCheckpoint = {
  providerTaskId?: string;
  state?: unknown;
  downloads?: {
    items: Record<string, unknown>[];
    completed: Result["outputs"];
    assets?: Record<string, string>;
    failures?: number;
    nextAttemptAt?: number;
  };
  input: Record<string, unknown>;
  endpoint: string;
  pluginHash: string;
  deadline: number;
};
const mimes = { image: "image/png", video: "video/mp4", audio: "audio/mpeg" };
const trialMimes = {
  image: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  video: ["video/mp4", "video/webm", "video/quicktime"],
  audio: [
    "audio/mpeg",
    "audio/mp4",
    "audio/wav",
    "audio/x-wav",
    "audio/ogg",
    "audio/opus",
    "audio/webm",
    "audio/flac",
  ],
};
const previewStop = "MODEL_TRIAL_PREVIEW";

function prepare(saved: ReturnType<SettingsRegistry["trialBinding"]>, trial: Trial) {
  const { profile, plugin, origin } = saved;
  const options = modelGenerationOptions(
    plugin.kind,
    origin === "builtin" ? plugin.key : undefined,
    profile.model,
    profile.channel,
    profile.config,
  );
  const refs = { images: [] as string[], videos: [] as string[], audios: [] as string[] };
  const media: Record<string, ReferenceMedia> = {};
  const invalid = () => new ProviderError("MODEL_TRIAL_INPUT_INVALID");
  if (!validCustomInput(profile.config, trial.params.customParams)) throw invalid();
  let totalBytes = 0;
  for (const { kind, url, file } of trial.references ?? []) {
    const list = refs[`${kind}s`];
    if (
      Boolean(url) === Boolean(file) ||
      (url && !isPublicReferenceURL(url)) ||
      list.length >= (options.references[kind] ?? 0)
    )
      throw invalid();
    const maximum = options.referenceBytes[kind] ?? mediaReferenceBytes;
    if (
      file &&
      (!trialMimes[kind].includes(file.mime) ||
        file.base64.length > Math.ceil(maximum / 3) * 4 ||
        file.base64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(file.base64))
    )
      throw invalid();
    const bytes = file ? Buffer.from(file.base64, "base64") : new Uint8Array();
    totalBytes += bytes.byteLength;
    if (
      (file && (!bytes.byteLength || bytes.byteLength > maximum)) ||
      totalBytes > mediaReferenceBytes
    )
      throw invalid();
    const key = `input:${kind}s.${list.length}`;
    list.push(key);
    media[key] = {
      url,
      ...(url && { urlOnly: true as const }),
      bytes,
      mime: file?.mime ?? mimes[kind],
      filename: `reference-${kind}.${(file?.mime ?? mimes[kind]).split("/")[1]}`,
    };
  }
  const total = Object.keys(media).length;
  const op =
    plugin.kind === "video"
      ? (trial.op ?? (total ? (refs.images.length === total ? "i2v" : "omni") : "t2v"))
      : undefined;
  const mode = plugin.kind === "image" ? (total ? "i2i" : "t2i") : op;
  const input = configuredGenerationInput(profile.config, {
    ...trial.params,
    op,
    prompt: trial.prompt.trim(),
  });
  if (
    !input.prompt ||
    Array.from(input.prompt).length > options.promptLimit ||
    total > options.referenceLimit ||
    (mode &&
      (!modelGenerationModes(plugin.kind, options).includes(mode) ||
        options.modes?.includes(mode) === false)) ||
    (op === "t2v" && total > 0) ||
    (op === "omni" && !total) ||
    (op === "i2v" && (!total || refs.images.length !== total || total > options.frameLimit)) ||
    (options.requiresReference && !total) ||
    (options.requiresImage && !refs.images.length) ||
    (options.requiresAudio && !refs.audios.length)
  )
    throw invalid();
  if (
    (input.size &&
      ((!options.manualSize && ![...options.sizes, ...options.largeSizes].includes(input.size)) ||
        input.aspectRatio ||
        input.resolution)) ||
    (input.aspectRatio && !options.ratios.includes(input.aspectRatio)) ||
    (input.resolution && !options.resolutions.includes(input.resolution)) ||
    (input.quality && !options.qualities.includes(input.quality)) ||
    (input.audioFormat && !options.audioFormats.includes(input.audioFormat)) ||
    (input.count !== undefined && !options.counts.includes(input.count)) ||
    (input.duration !== undefined &&
      (plugin.kind !== "video" ||
        (input.duration === -1
          ? !options.autoDuration
          : ((options.durations.length > 0 || profile.config?.params?.duration) &&
              !options.durations.includes(input.duration)) ||
            (!!options.durationRange &&
              (input.duration < options.durationRange.min ||
                input.duration > options.durationRange.max))))) ||
    (input.seed !== undefined && !options.seed) ||
    (input.negativePrompt && !options.negativePrompt) ||
    (input.generateAudio !== undefined && !options.audio) ||
    (input.makeInstrumental !== undefined && !options.instrumental) ||
    (input.speaker && (!options.speaker || total > 0)) ||
    (!options.speaker &&
      [input.sampleRate, input.speechRate, input.loudnessRate, input.pitchRate].some(
        (value) => value !== undefined,
      ))
  )
    throw invalid();
  return { input, refs, media };
}

export async function runModelTrial(
  registry: SettingsRegistry,
  trial: Trial,
  grant: (blob: Blob) => string | Promise<string>,
  progress?: (value: NonNullable<SettingsValues["modelTrialProgress"]>) => void,
  recovery?: {
    checkpoint?: TrialCheckpoint;
    progress?: NonNullable<SettingsValues["modelTrialProgress"]>;
    save: (checkpoint: TrialCheckpoint) => void;
  },
): Promise<Result> {
  const saved = registry.trialBinding(trial.id, trial.expectedRevision);
  const { profile, plugin, origin, secret, secretKey } = saved;
  const checkpoint = recovery?.checkpoint;
  if (
    checkpoint &&
    (checkpoint.endpoint !== profile.endpoint ||
      checkpoint.pluginHash !== profile.pluginHash ||
      checkpoint.deadline <= Date.now() ||
      profile.agentEnabled)
  )
    throw new ProviderError("MODEL_TRIAL_TIMEOUT");
  const { input, refs, media } = checkpoint
    ? {
        input: { prompt: "" },
        refs: { images: [], audios: [], videos: [] },
        media: {} as Record<string, ReferenceMedia>,
      }
    : prepare(saved, trial);
  if (origin === "builtin" && plugin.key === "doubao-video")
    for (const reference of Object.values(media))
      if (reference.mime.startsWith("image/"))
        reference.filedAssetId = await registry.resolveFiledReference(
          profile.channelId,
          reference.url,
        );
  const result: Result = {
    status: "failed",
    trace: recovery?.progress?.trace ?? [],
    logs: [],
    outputs: [],
  };
  const redactor = registry.redactor();
  const redact = (value: string) => redactor.redact(value).slice(0, 24000);
  const describeRequest = (request: HostRequest) => {
    const url = new URL(request.url);
    const body =
      request.body &&
      request.headers["content-type"]?.startsWith("application/json") &&
      plugin.auth.type !== "custom"
        ? redact(Buffer.from(request.body).toString("utf8"))
        : undefined;
    return {
      method: request.method,
      endpoint: redact(plugin.auth.type === "custom" ? url.origin : url.origin + url.pathname),
      responseType: request.responseType,
      ...(body && { body }),
    };
  };
  let deadline =
    checkpoint?.deadline ??
    Date.now() +
      Math.ceil(
        Math.min(900, profile.config?.timeoutSeconds ?? (plugin.mode === "async" ? 900 : 120)) *
          1000,
      );
  let signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const slot = trial.runId ?? randomUUID();
  let release =
    trial.dry || checkpoint?.downloads || !profile.channelId
      ? () => {}
      : registry.acquireGeneration(profile.channelId, "model-trial", slot, deadline);
  if (!release) throw new ProviderError("MODEL_TRIAL_BUSY");
  const captured: Blob[] = [];
  const binaryTrace = (asset: { id: string }) => {
    const blob = captured[Number(asset.id)];
    if (!blob) throw new ProviderError("JOB_OUTPUT_INVALID");
    return { text: `<binary ${blob.type} ${blob.size} bytes>`, truncated: false };
  };
  let capturedBytes = 0;
  const normalize = async (body: unknown) => {
    const list = record(body).data;
    if (!Array.isArray(list)) return body;
    for (const raw of list) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const item = record(raw);
      delete item.asset_index;
      if (typeof item.b64_json !== "string") continue;
      const encoded = item.b64_json;
      delete item.b64_json;
      item.asset_index = captured.length;
      if (plugin.kind !== "image" || captured.length >= 8)
        throw new ProviderError("JOB_OUTPUT_INVALID");
      const blob = inlineTrialImage(encoded);
      capturedBytes += blob.size;
      if (capturedBytes > trialMediaLimit) throw new ProviderError("PROVIDER_RESPONSE_LIMIT");
      captured.push(blob);
    }
    return body;
  };
  const binary = async (
    request: HostRequest,
    requestSignal?: AbortSignal,
    fallbackMime?: string,
  ) => {
    const response = await openProviderResponse(
      profile.endpoint,
      profile.allowLocal,
      request,
      requestSignal,
    );
    try {
      const status = response.statusCode ?? 502;
      if (status < 200 || status >= 300) return { status, headers: {}, text: "", body: {} };
      const mime = trialOutputMime(plugin.kind, response.headers["content-type"], fallbackMime);
      if (captured.length >= 8) throw new ProviderError("JOB_OUTPUT_INVALID");
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      for await (const chunk of response) {
        capturedBytes += chunk.length;
        if (capturedBytes > trialMediaLimit) throw new ProviderError("PROVIDER_RESPONSE_LIMIT");
        chunks.push(Uint8Array.from(chunk));
      }
      const index = captured.length;
      const blob = new Blob(chunks, { type: mime });
      if (!blob.size) throw new ProviderError("JOB_OUTPUT_INVALID");
      captured.push(blob);
      return {
        status,
        headers: {},
        text: "",
        body: {},
        asset: { id: String(index) },
      };
    } finally {
      response.destroy();
    }
  };
  let phase = checkpoint?.downloads ? "finalizing" : checkpoint ? "query" : "submit";
  let percent = recovery?.progress?.percent;
  const notify = () => progress?.({ phase, percent, trace: result.trace });
  let submitted = Boolean(checkpoint);
  let seq = result.trace.at(-1)?.seq ?? 0;
  type Step = Result["trace"][number];
  const startStep = (fields: Pick<Step, "kind" | "hook" | "method" | "endpoint">) => {
    const entry: Step = { id: randomUUID(), phase, seq: ++seq, ...fields };
    if (result.trace.length >= 40) result.trace.splice(1, 1);
    result.trace.push(entry);
    notify();
    return entry;
  };
  const beforeSend = (request: HostRequest) => {
    registry.trialBinding(trial.id, trial.expectedRevision);
    const description = describeRequest(request);
    result.request ??= description;
    if (trial.dry) throw new ProviderError(previewStop);
    submitted = true;
    const entry = startStep({
      kind: "http",
      method: description.method,
      endpoint: description.endpoint,
    });
    if (plugin.auth.type !== "custom") {
      entry.requestHeaders = traceBody(request.headers, redact);
      if (request.body && request.headers["content-type"]?.startsWith("application/json")) {
        if (request.body.byteLength <= 256 * 1024) {
          try {
            entry.requestBody = traceBody(
              JSON.parse(Buffer.from(request.body).toString("utf8")),
              redact,
            );
          } catch {
            entry.requestBody = { text: `[${request.body.byteLength} 字节]`, truncated: true };
          }
        } else entry.requestBody = { text: `[${request.body.byteLength} 字节]`, truncated: true };
      }
    }
    return entry;
  };
  const send = registry.wrapChannelTransport(
    profile.channelId,
    providerTransport(profile.endpoint, profile.allowLocal, normalize, (request, signal) =>
      binary(request, signal, mimes[plugin.kind as keyof typeof mimes]),
    ),
  );
  const host = registry.createHost(
    async (request, requestSignal) => {
      const entry = beforeSend(request);
      const start = performance.now();
      try {
        const response = await send(request, requestSignal);
        entry.status = response.status;
        if (response.asset) entry.responseBody = binaryTrace(response.asset);
        else if (
          request.responseType !== "binary" &&
          response.body != null &&
          plugin.auth.type !== "custom"
        ) {
          entry.responseBody = traceBody(response.body, redact);
        }
        return response;
      } catch (error) {
        entry.error = error instanceof ProviderError ? error.code : "PROVIDER_TEST_FAILED";
        throw error;
      } finally {
        entry.durationMs = Math.round(performance.now() - start);
        notify();
      }
    },
    trial.dry
      ? undefined
      : (hook, args) => {
          const entry = startStep({ kind: "hook", hook });
          if (plugin.auth.type !== "custom") entry.hookInput = traceBody(args, redact);
          const start = performance.now();
          return (error, output, logs) => {
            entry.durationMs = Math.round(performance.now() - start);
            if (error) entry.error = error;
            if (output !== undefined && plugin.auth.type !== "custom")
              entry.hookOutput = traceBody(output, redact);
            if (logs?.length) {
              if (plugin.auth.type === "custom") entry.hookLogs = traceBody(logs, redact);
              else {
                const prompt = checkpoint?.input.prompt ?? input.prompt;
                const text = logs
                  .map((line) => {
                    let clean = redact(line);
                    if (typeof prompt === "string" && prompt)
                      clean = clean.replaceAll(prompt, "[提示词已隐藏]");
                    return clean.replace(/https?:\/\/[^\s]+/gi, "[地址已隐藏]");
                  })
                  .join("\n");
                entry.hookLogs = { text: text.slice(0, 4096), truncated: text.length > 4096 };
              }
            }
            notify();
          };
        },
  );
  try {
    if (profile.agentEnabled) {
      const probe = await probeAgentStream(
        {
          ...saved,
          openResponse: async (request, requestSignal) => {
            const entry = beforeSend(request);
            const start = performance.now();
            try {
              const response = await saved.openResponse(request, requestSignal);
              entry.status = response.statusCode;
              return response;
            } catch (error) {
              entry.error = error instanceof ProviderError ? error.code : "PROVIDER_TEST_FAILED";
              throw error;
            } finally {
              entry.durationMs = Math.round(performance.now() - start);
              notify();
            }
          },
        },
        redactor,
        Math.min(120, profile.config?.timeoutSeconds ?? 25) * 1000,
        { prompt: input.prompt },
      );
      result.outputs = [{ id: randomUUID(), text: redact(probe.text ?? "") }];
      result.status = "succeeded";
    } else {
      const binding = {
        source: plugin.source,
        approvedHash: profile.pluginHash,
        baseUrl: profile.endpoint,
        builtin: origin === "builtin",
        secret,
        secretKey,
        media,
      };
      const context = {
        kind: plugin.kind,
        channel: { baseUrl: profile.endpoint, settings: profile.channel },
        model: { upstreamModel: profile.model },
        input:
          checkpoint?.input ?? providerInput(plugin.kind, plugin.key, input, profile.config, refs),
      };
      const initial: Record<string, unknown> =
        checkpoint ?? (await host.invoke(binding, "submit", context, signal));
      const providerTaskId =
        typeof initial.providerTaskId === "string" ? initial.providerTaskId : undefined;
      let state = initial.state;
      let final: Record<string, unknown> | undefined = initial.immediate
        ? record(initial.immediate)
        : undefined;
      if (checkpoint?.downloads)
        final = { status: "succeeded", outputs: checkpoint.downloads.items };
      if (!final && providerTaskId) {
        phase = "query";
        const save = () =>
          recovery?.save({
            providerTaskId,
            state,
            input: context.input,
            endpoint: profile.endpoint,
            pluginHash: profile.pluginHash,
            deadline,
          });
        save();
        notify();
        const poll = plugin.meta.poll;
        let attempts = 0;
        if (!checkpoint) await delay(providerPollDelay(poll, true, 0), undefined, { signal });
        while (!final) {
          const current = await host.invoke(
            binding,
            "query",
            { ...context, task: { providerTaskId: initial.providerTaskId, state } },
            signal,
          );
          state = current.state ?? state;
          if (["succeeded", "failed", "cancelled"].includes(String(current.status)))
            final = current;
          else {
            save();
            if (typeof current.progress === "number") percent = Math.round(current.progress);
            notify();
            await delay(providerPollDelay(poll, false, ++attempts), undefined, { signal });
          }
        }
      }
      if (final?.status !== "succeeded" || !Array.isArray(final.outputs)) {
        result.error = "PROVIDER_TEST_FAILED";
        const reason =
          final?.status === "failed" &&
          registry.failureMessage(
            plugin.auth.type,
            record(final.error).message,
            [...Object.values(context.input), ...Object.values(profile.channel)],
            profile.channelId,
          );
        if (reason) {
          result.errorMessage = reason;
          result.logs.push(reason);
        }
      } else {
        phase = "finalizing";
        if (!checkpoint?.downloads) {
          deadline += 2 * 60 * 60_000;
          signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
          release?.();
          release = undefined;
        }
        percent = 100;
        notify();
        const items = final.outputs.slice(0, 8).map(record);
        const staged = new Map(Object.entries(checkpoint?.downloads?.assets ?? {}));
        if (!checkpoint?.downloads) {
          for (const item of items) {
            if (item.type !== "asset") continue;
            const index = Number(item.asset_index ?? 0);
            const blob = captured[index];
            if (!blob) throw new ProviderError("JOB_OUTPUT_INVALID");
            if (!staged.has(String(index))) staged.set(String(index), await grant(blob));
          }
        }
        const counted = new Set<string>();
        const exists = (token: string) => {
          if (counted.has(token)) return true;
          const blob = trial.runId && registry.trialOutput(trial.runId, token);
          if (!blob) return false;
          counted.add(token);
          capturedBytes += blob.size;
          if (capturedBytes > trialMediaLimit) throw new ProviderError("PROVIDER_RESPONSE_LIMIT");
          return true;
        };
        if (checkpoint?.downloads && [...staged.values()].some((token) => !exists(token)))
          throw new ProviderError("JOB_OUTPUT_INVALID");
        const outputs: Result["outputs"] = [];
        for (const completed of checkpoint?.downloads?.completed ?? []) {
          if (completed.previewUrl && !exists(completed.previewUrl)) break;
          outputs.push(completed);
        }
        let failures = checkpoint?.downloads?.failures ?? 0;
        let nextAttemptAt = checkpoint?.downloads?.nextAttemptAt;
        const saveDownloads = () => {
          recovery?.save({
            providerTaskId,
            state,
            input: providerTaskId ? context.input : {},
            endpoint: profile.endpoint,
            pluginHash: profile.pluginHash,
            deadline,
            downloads: {
              items,
              completed: outputs,
              assets: Object.fromEntries(staged),
              failures,
              nextAttemptAt,
            },
          });
        };
        saveDownloads();
        for (let index = outputs.length; index < items.length; index++) {
          let item = record(items[index]);
          const id = randomUUID();
          if (item.type === "text" && typeof item.text === "string") {
            outputs.push({ id, text: redact(item.text) });
            saveDownloads();
            continue;
          }
          let assetIndex = Number(item.asset_index ?? 0);
          if (item.type === "asset") {
            const token = staged.get(String(assetIndex));
            if (!token) throw new ProviderError("JOB_OUTPUT_INVALID");
            outputs.push({ id, mediaType: plugin.kind, previewUrl: token });
            saveDownloads();
            continue;
          }
          for (;;) {
            if (nextAttemptAt !== undefined) {
              await delay(Math.max(0, nextAttemptAt - Date.now()), undefined, { signal });
              if (providerTaskId) {
                const current = await host.invoke(
                  binding,
                  "query",
                  { ...context, task: { providerTaskId, state } },
                  signal,
                );
                if (
                  current.status !== "succeeded" ||
                  !Array.isArray(current.outputs) ||
                  current.outputs.length !== items.length
                )
                  throw new ProviderError("MODEL_TRIAL_DOWNLOAD_FAILED");
                state = current.state ?? state;
                for (let remaining = index; remaining < items.length; remaining++) {
                  const replacement = record(current.outputs[remaining]);
                  if (items[remaining]?.type === "url" && replacement.type === "url")
                    items[remaining] = replacement;
                }
                item = record(items[index]);
              }
              nextAttemptAt = undefined;
              saveDownloads();
            }
            if (item.type !== "url" || typeof item.url !== "string")
              throw new ProviderError("JOB_OUTPUT_INVALID");
            registry.trialBinding(trial.id, trial.expectedRevision);
            const entry = startStep({
              kind: "http",
              method: "GET",
              endpoint: redact(new URL(item.url).origin),
            });
            const start = performance.now();
            try {
              const response = await binary(
                {
                  url: item.url,
                  method: "GET",
                  headers: {},
                  responseType: "binary",
                  timeoutMs: 120000,
                },
                signal,
                typeof item.mime === "string"
                  ? item.mime
                  : mimes[plugin.kind as keyof typeof mimes],
              );
              entry.status = response.status;
              if (response.asset) {
                entry.responseBody = binaryTrace(response.asset);
                assetIndex = Number(response.asset.id);
                break;
              }
              const transient = [429, 500, 502, 503, 504].includes(response.status);
              const staleLink = providerTaskId && [401, 403, 404, 410].includes(response.status);
              if ((!transient && !staleLink) || ++failures >= 10)
                throw new ProviderError("MODEL_TRIAL_DOWNLOAD_FAILED");
            } catch (error) {
              entry.error =
                error instanceof ProviderError ? error.code : "MODEL_TRIAL_DOWNLOAD_FAILED";
              throw error;
            } finally {
              entry.durationMs = Math.round(performance.now() - start);
              notify();
            }
            const wait = Math.min(600_000, 10_000 * 2 ** (failures - 1));
            nextAttemptAt = Date.now() + Math.round(wait * (0.8 + 0.4 * Math.random()));
            saveDownloads();
          }
          const blob = captured[assetIndex];
          if (!blob) throw new ProviderError("JOB_OUTPUT_INVALID");
          outputs.push({ id, mediaType: plugin.kind, previewUrl: await grant(blob) });
          saveDownloads();
        }
        result.outputs = outputs;
        result.status = "succeeded";
      }
    }
    registry.trialBinding(trial.id, trial.expectedRevision);
  } catch (error) {
    if (trial.dry && result.request) result.status = "preview";
    else {
      const code = error instanceof ProviderError ? error.code : "PROVIDER_TEST_FAILED";
      result.status =
        submitted &&
        phase !== "finalizing" &&
        (phase === "query" || signal.aborted || code === "PROVIDER_OUTCOME_UNKNOWN")
          ? "unknown"
          : "failed";
      result.error =
        phase === "finalizing" && (signal.aborted || code === "PROVIDER_TEST_FAILED")
          ? "MODEL_TRIAL_DOWNLOAD_FAILED"
          : signal.aborted
            ? "MODEL_TRIAL_TIMEOUT"
            : code;
    }
  } finally {
    release?.();
  }
  result.logs.push(
    result.status === "preview" ? "已生成首个请求描述。" : `试跑结束，共 ${seq} 步。`,
  );
  return result;
}
