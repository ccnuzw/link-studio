import { request as httpRequest } from "node:http";
import { authNameIssue, reservedHeaders } from "./auth-name.ts";
import {
  inspectPlugin,
  type PluginInfo,
  requireGenerationPlugin,
  validateContext,
  validateResult,
} from "./plugin.ts";
import { encoded, LIMITS, type PluginRunner, ProviderError, record, sourceHash } from "./runner.ts";

export interface HostRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  timeoutMs: number;
  responseType: string;
}
export interface HostResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  text: string;
  asset?: { id: string };
}
export type Transport = (request: HostRequest, signal?: AbortSignal) => Promise<HostResponse>;
export interface ReferenceMedia {
  bytes: Uint8Array;
  mime: string;
  filename: string;
  url?: string;
  urlOnly?: true;
  filedAssetId?: string;
}
export interface Binding {
  source: string;
  approvedHash: string;
  baseUrl: string;
  builtin?: boolean;
  secret?: string;
  secretKey?: string;
  media?: Record<string, ReferenceMedia>;
  savePrepared?: (prepared: unknown) => void;
}

const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const errorClasses = ["retryable", "terminal", "moderation", "provider_balance"];
const maxRequestBytes = 16 * 1024 * 1024;

function redact(value: unknown, secret?: string): unknown {
  if (!secret) return value;
  if (typeof value === "string") return value.split(secret).join("[redacted]");
  if (Array.isArray(value)) return value.map((entry) => redact(entry, secret));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redact(entry, secret)]),
    );
  }
  return value;
}

function targetURL(descriptor: Record<string, unknown>, baseUrl: string): URL {
  const base = new URL(baseUrl);
  if (Boolean(descriptor.path) === Boolean(descriptor.url))
    throw new ProviderError("PLUGIN_REQUEST_INVALID");
  let url: URL;
  if (typeof descriptor.path === "string") {
    const path = descriptor.path;
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      /[\\?#\s\p{Cc}]/u.test(path) ||
      /(?:^|\/)\.\.(?:\/|$)/.test(decodeURIComponent(path))
    )
      throw new ProviderError("PLUGIN_REQUEST_INVALID");
    url = new URL(`${base.origin}${base.pathname.replace(/\/$/, "")}${path}`);
    if (url.origin !== base.origin) throw new ProviderError("PLUGIN_REQUEST_INVALID");
  } else {
    url = new URL(String(descriptor.url));
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.hostname === "169.254.169.254" ||
    url.hostname.endsWith(".internal")
  )
    throw new ProviderError("PROVIDER_ENDPOINT_BLOCKED");
  return url;
}

function vertex(binding: Binding, plugin: PluginInfo) {
  return binding.builtin === true && plugin.key === "vertex-ai" && plugin.auth.type === "custom";
}

function vertexTarget(
  url: URL,
  descriptor: Record<string, unknown>,
  context: Record<string, unknown>,
) {
  const settings = record(context.channel).settings;
  const { tokenUrl, gcsBaseUrl } = settings === undefined ? {} : record(settings);
  if (url.protocol !== "https:") return undefined;
  if (
    descriptor.method === "POST" &&
    url.href === new URL(String(tokenUrl || "https://oauth2.googleapis.com/token")).href
  )
    return "token";
  const gcs = new URL(String(gcsBaseUrl || "https://storage.googleapis.com"));
  if (
    descriptor.method === "GET" &&
    descriptor.responseType === "binary" &&
    url.origin === gcs.origin &&
    url.pathname.startsWith(`${gcs.pathname.replace(/\/$/, "")}/`)
  )
    return "storage";
  return undefined;
}

function goJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(goJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = record(value);
    const keys = Object.keys(object).sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    return `{${keys.map((key) => `${goJSON(key)}:${goJSON(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function resolveMedia(
  reference: unknown,
  binding: Binding,
  context: Record<string, unknown>,
): ReferenceMedia {
  if (typeof reference !== "string") throw new ProviderError("MEDIA_REFERENCE_INVALID");
  const match = /^input:(images|audios|videos)\.(\d+)$/.exec(reference);
  if (!match) throw new ProviderError("MEDIA_REFERENCE_INVALID");
  const input = record(context.input);
  const list = input[match[1] ?? ""];
  if (!Array.isArray(list) || list[Number(match[2])] !== reference)
    throw new ProviderError("MEDIA_REFERENCE_INVALID");
  const media = binding.media?.[reference];
  if (!media) throw new ProviderError("MEDIA_REFERENCE_INVALID");
  if (media.bytes.byteLength > 10 * 1024 * 1024 || !/^[\w.+-]+\/[\w.+-]+$/.test(media.mime))
    throw new ProviderError("MEDIA_INLINE_LIMIT");
  return media;
}

function replaceReferences(
  value: unknown,
  binding: Binding,
  context: Record<string, unknown>,
  budget = { bytes: maxRequestBytes - LIMITS.payload },
): unknown {
  if (Array.isArray(value))
    return value.map((item) => replaceReferences(item, binding, context, budget));
  if (value === null || typeof value !== "object") return value;
  const object = record(value);
  if ("__fileRef" in object) {
    if (
      Object.keys(object).some((key) => !["__fileRef", "as", "filed"].includes(key)) ||
      (object.filed !== undefined && typeof object.filed !== "boolean")
    )
      throw new ProviderError("MEDIA_REFERENCE_INVALID");
    const media = resolveMedia(object.__fileRef, binding, context);
    if (object.as === undefined || object.as === "url") {
      if (
        object.filed === true &&
        binding.builtin &&
        media.mime.startsWith("image/") &&
        media.filedAssetId &&
        /^[\w.:-]{1,128}$/.test(media.filedAssetId)
      )
        return `asset://${media.filedAssetId}`;
      if (!media.url || !URL.canParse(media.url))
        throw new ProviderError("MEDIA_TRANSPORT_UNAVAILABLE");
      const url = new URL(media.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new ProviderError("MEDIA_TRANSPORT_UNAVAILABLE");
      return media.url;
    }
    if (object.as !== "base64" && object.as !== "dataUrl")
      throw new ProviderError("MEDIA_REFERENCE_INVALID");
    if (media.urlOnly) throw new ProviderError("MEDIA_TRANSPORT_UNAVAILABLE");
    budget.bytes -= Math.ceil(media.bytes.byteLength / 3) * 4;
    if (budget.bytes < 0) throw new ProviderError("MEDIA_INLINE_LIMIT");
    const base64 = Buffer.from(media.bytes).toString("base64");
    return object.as === "base64" ? base64 : `data:${media.mime};base64,${base64}`;
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [
      key,
      replaceReferences(item, binding, context, budget),
    ]),
  );
}

export async function buildHostRequest(
  value: unknown,
  plugin: PluginInfo,
  binding: Binding,
  context: Record<string, unknown>,
): Promise<HostRequest> {
  requireGenerationPlugin(plugin);
  const descriptor = record(value);
  if (!methods.includes(String(descriptor.method)))
    throw new ProviderError("PLUGIN_REQUEST_INVALID");
  const url = targetURL(descriptor, binding.baseUrl);
  const sameOrigin = url.origin === new URL(binding.baseUrl).origin;
  const custom = plugin.auth.type === "custom";
  const vertexEndpoint =
    !sameOrigin && vertex(binding, plugin) ? vertexTarget(url, descriptor, context) : undefined;
  if (custom && !sameOrigin && !vertexEndpoint)
    throw new ProviderError("PROVIDER_ENDPOINT_BLOCKED");
  const headers: Record<string, string> = Object.create(null);
  for (const [name, entry] of Object.entries(
    descriptor.headers === undefined ? {} : record(descriptor.headers),
  )) {
    const lower = name.toLowerCase();
    const customAuthorization =
      lower === "authorization" && custom && (sameOrigin || vertexEndpoint === "storage");
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      (reservedHeaders.has(lower) && !customAuthorization) ||
      (plugin.auth.type === "header" && name.toLowerCase() === plugin.auth.name?.toLowerCase()) ||
      typeof entry !== "string" ||
      /[^\t\x20-\x7e\x80-\xff]/.test(entry) ||
      Object.hasOwn(headers, lower)
    )
      throw new ProviderError("PLUGIN_REQUEST_INVALID");
    Object.defineProperty(headers, lower, {
      value: entry,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const [key, entry] of Object.entries(
    descriptor.query === undefined ? {} : record(descriptor.query),
  )) {
    if (entry === null) continue;
    if (!["string", "boolean", "number"].includes(typeof entry))
      throw new ProviderError("PLUGIN_REQUEST_INVALID");
    url.searchParams.set(key, String(entry));
  }
  if (["json", "form", "multipart"].filter((key) => descriptor[key] !== undefined).length > 1)
    throw new ProviderError("PLUGIN_REQUEST_INVALID");
  let body: Uint8Array | undefined;
  if (descriptor.json !== undefined) {
    const json = replaceReferences(descriptor.json, binding, context);
    if (binding.builtin && (plugin.key === "google" || plugin.key === "vertex-ai")) {
      const images = record(context.input).images;
      const media =
        Array.isArray(images) && typeof images[0] === "string"
          ? binding.media?.[images[0]]
          : undefined;
      const instances = record(json).instances;
      if (media && Array.isArray(instances) && instances[0]?.image) {
        const image = instances[0].image;
        if (plugin.key === "google" && image.inlineData) image.inlineData.mimeType = media.mime;
        if (plugin.key === "vertex-ai") image.mimeType = media.mime;
      }
    }
    body = Buffer.from(
      custom && plugin.key === "jimeng" ? goJSON(json) : encoded(json, maxRequestBytes),
    );
    headers["content-type"] = "application/json";
  } else if (descriptor.form !== undefined) {
    const fields = record(replaceReferences(descriptor.form, binding, context));
    body = Buffer.from(
      new URLSearchParams(
        Object.entries(fields).map(([key, entry]) => [key, String(entry)]),
      ).toString(),
    );
    headers["content-type"] = "application/x-www-form-urlencoded";
  } else if (descriptor.multipart !== undefined) {
    const multipart = record(descriptor.multipart);
    const form = new FormData();
    const fields = record(replaceReferences(multipart.fields ?? {}, binding, context));
    encoded(fields, LIMITS.payload);
    for (const [key, entry] of Object.entries(fields)) form.append(key, String(entry));
    if (!Array.isArray(multipart.parts) || multipart.parts.length > 8)
      throw new ProviderError("PLUGIN_REQUEST_INVALID");
    for (const entry of multipart.parts) {
      const part = record(entry);
      const media = resolveMedia(part.fileRef, binding, context);
      if (media.urlOnly) throw new ProviderError("MEDIA_TRANSPORT_UNAVAILABLE");
      const filename = part.filename ?? media.filename;
      if (
        typeof part.name !== "string" ||
        !part.name ||
        /[\r\n]/.test(part.name) ||
        typeof filename !== "string" ||
        !filename ||
        /[/\\\p{Cc}]/u.test(filename)
      )
        throw new ProviderError("PLUGIN_REQUEST_INVALID");
      form.append(
        part.name,
        new Blob([Uint8Array.from(media.bytes)], { type: media.mime }),
        filename,
      );
    }
    const request = new Request(url, { method: "POST", body: form });
    body = new Uint8Array(await request.arrayBuffer());
    headers["content-type"] = request.headers.get("content-type") ?? "";
  }
  const responseType = String(descriptor.responseType ?? "json");
  if (!["json", "text", "binary", "image_json"].includes(responseType))
    throw new ProviderError("PLUGIN_REQUEST_INVALID");
  if (responseType === "image_json" && plugin.kind !== "image")
    throw new ProviderError("PLUGIN_REQUEST_INVALID");
  const timeout = descriptor.timeout ?? 30;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)
    throw new ProviderError("PLUGIN_REQUEST_INVALID");
  const auth = descriptor.auth === undefined ? plugin.auth : record(descriptor.auth);
  if (!["none", "bearer", "header", "query", "custom"].includes(String(auth.type)))
    throw new ProviderError("PLUGIN_REQUEST_INVALID");
  if (authNameIssue(auth.type, auth.name)) throw new ProviderError("PLUGIN_REQUEST_INVALID");
  if (sameOrigin && !["none", "custom"].includes(String(auth.type))) {
    if (!binding.secret) throw new ProviderError("PROVIDER_SECRET_UNAVAILABLE");
    if (auth.type === "bearer") headers.authorization = `Bearer ${binding.secret}`;
    if (auth.type === "header") headers[String(auth.name).toLowerCase()] = binding.secret;
    if (auth.type === "query") url.searchParams.set(String(auth.name), binding.secret);
  }
  if (body && descriptor.multipart === undefined && body.byteLength > maxRequestBytes)
    throw new ProviderError("PLUGIN_INPUT_LIMIT");
  return {
    method: String(descriptor.method),
    url: url.href,
    headers,
    body,
    timeoutMs: Math.min(timeout, 120) * 1000,
    responseType,
  };
}

export class ProviderHost {
  constructor(
    private readonly runner: PluginRunner,
    private readonly transport: Transport,
    private readonly observeHook?: (
      name: string,
      args: readonly unknown[],
    ) => (errorCode?: string, output?: unknown, logs?: string[]) => void,
  ) {}

  async invoke(
    binding: Binding,
    phase: "submit" | "query" | "cancel",
    value: unknown,
    signal?: AbortSignal,
  ) {
    if (binding.approvedHash !== sourceHash(binding.source))
      throw new ProviderError("PLUGIN_APPROVAL_REQUIRED");
    const plugin = await inspectPlugin(this.runner, binding.source);
    requireGenerationPlugin(plugin);
    if (Object.hasOwn(record(value), "credentials"))
      throw new ProviderError("PLUGIN_CONTEXT_INVALID");
    const context = validateContext(value);
    context.now ??= Math.floor(Date.now() / 1000);
    if (record(context.channel).baseUrl !== binding.baseUrl)
      throw new ProviderError("PLUGIN_CONTEXT_INVALID");
    if (plugin.auth.type === "custom") {
      if (!binding.secret) throw new ProviderError("PROVIDER_SECRET_UNAVAILABLE");
      context.credentials = {
        apiKey: binding.secret,
        ...(binding.secretKey && { secretKey: binding.secretKey }),
      };
    }
    const call = async (hook: string, args: unknown[]) => {
      const finish = this.observeHook?.(hook, args);
      try {
        if (!finish) return await this.runner.call(binding.source, hook, args, signal);
        const { result, logs } = await this.runner.trace(binding.source, hook, args, signal);
        finish(undefined, result, logs);
        return result;
      } catch (error) {
        finish?.(error instanceof ProviderError ? error.code : "PLUGIN_OUTPUT_INVALID");
        throw error;
      }
    };
    const send = async (descriptor: unknown, submitting = false) => {
      const request = await buildHostRequest(descriptor, plugin, binding, context);
      if (signal?.aborted) throw new ProviderError("PLUGIN_CANCELLED");
      let response: HostResponse;
      try {
        response = await this.transport(request, signal);
      } catch (error) {
        if (
          error instanceof ProviderError &&
          [
            "PROVIDER_ENDPOINT_BLOCKED",
            "PROVIDER_REQUEST_NOT_SENT",
            "MOCK_RESPONSE_TYPE_UNSUPPORTED",
            "JOB_OUTPUT_INVALID",
          ].includes(error.code)
        )
          throw error;
        if (submitting) throw new ProviderError("PROVIDER_OUTCOME_UNKNOWN");
        throw error;
      }
      response = redact(redact(response, binding.secret), binding.secretKey) as HostResponse;
      if (plugin.auth.type === "custom" && request.headers.authorization) {
        const [scheme, credential = ""] = request.headers.authorization.split(/\s+/, 2);
        response = redact(
          response,
          scheme === "Bearer" || scheme === "Token" ? credential : request.headers.authorization,
        ) as HostResponse;
      }
      if (response.status >= 300 && response.status < 400)
        throw new ProviderError("PROVIDER_REDIRECT_BLOCKED");
      encoded(response, LIMITS.payload);
      if (response.status < 200 || response.status >= 300) {
        let classification = /balance|insufficient|quota|credit|余额|额度/i.test(response.text)
          ? "provider_balance"
          : response.status === 429 || response.status >= 500
            ? "retryable"
            : "terminal";
        if (plugin.hooks.includes("classifyError")) {
          try {
            const result = await call("classifyError", [context, response]);
            const proposed = result == null ? undefined : record(result).class;
            if (typeof proposed === "string" && errorClasses.includes(proposed))
              classification = proposed;
          } catch (error) {
            if (signal?.aborted) throw error;
          }
        }
        throw new ProviderError(`PROVIDER_${classification.toUpperCase()}`);
      }
      return response;
    };
    if (
      (phase === "submit" || (phase === "query" && vertex(binding, plugin))) &&
      context.prepared == null &&
      plugin.hooks.includes("buildPrepareRequests")
    ) {
      const requests = await call("buildPrepareRequests", [context]);
      if (!Array.isArray(requests) || requests.length > 8)
        throw new ProviderError("PLUGIN_REQUEST_INVALID");
      const responses = [];
      for (const request of requests) responses.push(await send(request));
      context.prepared = await call("parsePrepareResponses", [context, responses]);
      encoded(context.prepared, LIMITS.state);
      if (phase === "submit" && context.prepared != null && binding.savePrepared) {
        try {
          binding.savePrepared(context.prepared);
        } catch {
          throw new ProviderError("PROVIDER_RETRYABLE");
        }
      }
    }
    const suffix = phase === "submit" ? "Submit" : phase === "query" ? "Query" : "Cancel";
    if (!plugin.hooks.includes(`build${suffix}Request`)) {
      if (phase === "cancel") return { cancellation: "local_only" };
      throw new ProviderError("PLUGIN_HOOK_MISSING");
    }
    const descriptor = await call(`build${suffix}Request`, [context]);
    const response = await send(descriptor, phase === "submit");
    if (phase === "cancel") return { cancellation: "requested" };
    try {
      const result = await call(`parse${suffix}Response`, [context, response]);
      return this.parseResult(result, plugin, binding, phase);
    } catch (error) {
      if (phase === "submit") throw new ProviderError("PROVIDER_OUTCOME_UNKNOWN");
      throw error;
    }
  }

  private parseResult(
    result: unknown,
    plugin: PluginInfo,
    binding: Binding,
    phase: "submit" | "query",
  ) {
    const parsed = record(redact(redact(result, binding.secret), binding.secretKey));
    if (vertex(binding, plugin) && parsed.state != null) {
      const state = record(parsed.state);
      parsed.state = state.ready === true ? { ready: true, url: state.url } : {};
    }
    if (parsed.state !== undefined) encoded(parsed.state, LIMITS.state);
    requireGenerationPlugin(plugin);
    if (phase === "query") return validateResult(parsed, plugin.kind);
    if (parsed.immediate !== undefined) {
      const immediate = validateResult(parsed.immediate, plugin.kind);
      if (!["succeeded", "failed"].includes(String(immediate.status)))
        throw new ProviderError("PLUGIN_RESULT_INVALID");
      return { ...parsed, immediate };
    }
    if (typeof parsed.providerTaskId === "number" && Number.isFinite(parsed.providerTaskId))
      parsed.providerTaskId = String(parsed.providerTaskId);
    if (
      plugin.mode === "sync" ||
      typeof parsed.providerTaskId !== "string" ||
      !parsed.providerTaskId ||
      parsed.providerTaskId.length > 4096
    )
      throw new ProviderError("PLUGIN_RESULT_INVALID");
    return parsed;
  }
}

export function mockLoopbackTransport(origins: string[], timeoutOverrideMs?: number): Transport {
  const permitted = new Set(origins.map((origin) => new URL(origin).origin));
  return (request, signal) =>
    new Promise((accept, reject) => {
      const url = new URL(request.url);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !permitted.has(url.origin)) {
        reject(new ProviderError("PROVIDER_ENDPOINT_BLOCKED"));
        return;
      }
      if (!["json", "text", "image_json", "binary"].includes(request.responseType)) {
        reject(new ProviderError("MOCK_RESPONSE_TYPE_UNSUPPORTED"));
        return;
      }
      const connection = httpRequest(
        url,
        { method: request.method, headers: request.headers, signal },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > LIMITS.payload)
              connection.destroy(new ProviderError("PROVIDER_RESPONSE_LIMIT"));
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            const bytes = Buffer.concat(chunks);
            const binary = request.responseType === "binary";
            const text = binary ? "" : bytes.toString("utf8");
            try {
              accept({
                status: response.statusCode ?? 500,
                headers: Object.fromEntries(
                  Object.entries(response.headers).map(([key, entry]) => [key, String(entry)]),
                ),
                body: request.responseType === "text" ? null : text ? JSON.parse(text) : null,
                text,
                ...(binary
                  ? { asset: { id: `mock-binary-${sourceHash(bytes.toString("base64"))}` } }
                  : {}),
              });
            } catch {
              reject(new ProviderError("PROVIDER_RESPONSE_INVALID"));
            }
          });
        },
      );
      connection.setTimeout(timeoutOverrideMs ?? request.timeoutMs, () =>
        connection.destroy(new ProviderError("PROVIDER_TIMEOUT")),
      );
      connection.on("error", reject);
      connection.end(request.body);
    });
}
