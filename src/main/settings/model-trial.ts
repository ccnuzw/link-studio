import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  configuredGenerationInput,
  isPublicReferenceURL,
  mediaReferenceBytes,
  modelGenerationModes,
  modelGenerationOptions,
} from "../../../packages/link-studio-core/src/media-generation.ts";
import { providerInput } from "../../../packages/link-studio-core/src/provider-input.ts";
import type {
  SettingsInput,
  SettingsValues,
} from "../../../packages/link-studio-core/src/settings-api.ts";
import type {
  HostRequest,
  ReferenceMedia,
  Transport,
} from "../../../packages/provider-runtime/src/host.ts";
import { ProviderError, record } from "../../../packages/provider-runtime/src/runner.ts";
import { probeAgentStream } from "./agent-model.ts";
import { openProviderResponse, providerTransport } from "./network.ts";
import type { SettingsRegistry } from "./registry.ts";

type Trial = SettingsInput<"modelTrial">;
type Result = SettingsValues["modelTrial"];
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

export async function runModelTrial(registry: SettingsRegistry, trial: Trial): Promise<Result> {
  const saved = registry.trialBinding(trial.id, trial.expectedRevision);
  const { profile, plugin, origin, secret, secretKey } = saved;
  const { input, refs, media } = prepare(saved, trial);
  const result: Result = { status: "failed", trace: [], logs: [], outputs: [] };
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
      endpoint: redact(url.origin + url.pathname),
      responseType: request.responseType,
      ...(body && { body }),
    };
  };
  const signal = AbortSignal.timeout(Math.min(180, profile.config?.timeoutSeconds ?? 120) * 1000);
  const release =
    trial.dry || !profile.channelId ? () => {} : registry.acquireGeneration(profile.channelId);
  if (!release) throw new ProviderError("MODEL_TRIAL_BUSY");
  const images: string[] = [];
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
      item.asset_index = images.length;
      const mime = encoded.startsWith("iVBORw0KGgo")
        ? "image/png"
        : encoded.startsWith("/9j/")
          ? "image/jpeg"
          : "";
      images.push(
        mime &&
          images.length < 4 &&
          encoded.length <= 4 * 1024 * 1024 &&
          /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
          ? `data:${mime};base64,${encoded}`
          : "",
      );
    }
    return body;
  };
  const binary: Transport = async (request, requestSignal) => {
    const response = await openProviderResponse(
      profile.endpoint,
      profile.allowLocal,
      request,
      requestSignal,
    );
    try {
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) throw new ProviderError("PROVIDER_RESPONSE_LIMIT");
      }
      return {
        status: response.statusCode ?? 502,
        headers: {},
        text: "",
        body: {},
        ...(size > 0 && { asset: { id: "0" } }),
      };
    } finally {
      response.destroy();
    }
  };
  let phase = "submit";
  let submitted = false;
  const beforeSend = (request: HostRequest) => {
    registry.trialBinding(trial.id, trial.expectedRevision);
    const description = describeRequest(request);
    result.request ??= description;
    if (trial.dry) throw new ProviderError(previewStop);
    const entry: Result["trace"][number] = {
      id: randomUUID(),
      phase,
      method: description.method,
      endpoint: description.endpoint,
    };
    if (result.trace.length < 40) result.trace.push(entry);
    submitted = true;
    return entry;
  };
  const send = registry.wrapChannelTransport(
    profile.channelId,
    providerTransport(profile.endpoint, profile.allowLocal, normalize, binary),
  );
  const host = registry.createHost(async (request, requestSignal) => {
    const entry = beforeSend(request);
    const response = await send(request, requestSignal);
    entry.status = response.status;
    return response;
  });
  try {
    if (profile.agentEnabled) {
      const probe = await probeAgentStream(
        {
          ...saved,
          openResponse: async (request, requestSignal) => {
            const entry = beforeSend(request);
            const response = await saved.openResponse(request, requestSignal);
            entry.status = response.statusCode;
            return response;
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
        input: providerInput(plugin.kind, plugin.key, input, profile.config, refs),
      };
      const initial = await host.invoke(binding, "submit", context, signal);
      let final = initial.immediate ? record(initial.immediate) : undefined;
      if (!final && typeof initial.providerTaskId === "string") {
        phase = "query";
        let state = initial.state;
        const poll = registry.list().plugins.find(({ hash }) => hash === profile.pluginHash)?.poll;
        await delay((poll?.firstDelay ?? 10) * 1000, undefined, { signal });
        while (!final) {
          const current = await host.invoke(
            binding,
            "query",
            { ...context, task: { providerTaskId: initial.providerTaskId, state } },
            signal,
          );
          if (["succeeded", "failed", "cancelled"].includes(String(current.status)))
            final = current;
          else {
            state = current.state ?? state;
            await delay((poll?.interval ?? 5) * 1000, undefined, { signal });
          }
        }
      }
      if (final?.status !== "succeeded" || !Array.isArray(final.outputs)) {
        result.error = "PROVIDER_TEST_FAILED";
        if (final?.error) result.logs.push(redact(String(record(final.error).message ?? "")));
      } else {
        result.outputs = final.outputs.slice(0, 8).map((output) => {
          const item = record(output);
          const id = randomUUID();
          if (typeof item.text === "string") return { id, text: redact(item.text) };
          const image =
            plugin.kind === "image" && typeof item.asset_index === "number"
              ? images[item.asset_index]
              : undefined;
          return { id, mediaType: plugin.kind, ...(image && { image }) };
        });
        result.status = "succeeded";
      }
    }
    registry.trialBinding(trial.id, trial.expectedRevision);
  } catch (error) {
    if (trial.dry && result.request) result.status = "preview";
    else {
      const code = error instanceof ProviderError ? error.code : "PROVIDER_TEST_FAILED";
      result.status =
        submitted && (phase === "query" || signal.aborted || code === "PROVIDER_OUTCOME_UNKNOWN")
          ? "unknown"
          : "failed";
      result.error = signal.aborted ? "MODEL_TRIAL_TIMEOUT" : code;
    }
  } finally {
    release();
  }
  result.logs.push(
    result.status === "preview"
      ? "已生成首个请求描述。"
      : `试跑结束，记录 ${result.trace.length} 条请求。`,
  );
  return result;
}
