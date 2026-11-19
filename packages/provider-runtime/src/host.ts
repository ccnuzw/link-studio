import { request as httpRequest } from "node:http";
import { inspectPlugin, type PluginInfo, validateContext, validateResult } from "./plugin.ts";
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
}
export interface Binding {
  source: string;
  approvedHash: string;
  baseUrl: string;
  secret?: string;
  media?: Record<string, ReferenceMedia>;
}

const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const bannedHeaders = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
];

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
): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceReferences(item, binding, context));
  if (value === null || typeof value !== "object") return value;
  const object = record(value);
  if ("__fileRef" in object) {
    const media = resolveMedia(object.__fileRef, binding, context);
    if (object.as === "url") throw new ProviderError("MEDIA_TRANSPORT_UNAVAILABLE");
    const base64 = Buffer.from(media.bytes).toString("base64");
    if (object.as === "base64") return base64;
    if (object.as === "dataUrl") return `data:${media.mime};base64,${base64}`;
    throw new ProviderError("MEDIA_REFERENCE_INVALID");
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [key, replaceReferences(item, binding, context)]),
  );
}

export async function buildHostRequest(
  value: unknown,
  plugin: PluginInfo,
  binding: Binding,
  context: Record<string, unknown>,
): Promise<HostRequest> {
  const descriptor = record(value);
  if (!methods.includes(String(descriptor.method)))
    throw new ProviderError("PLUGIN_REQUEST_INVALID");
  const url = targetURL(descriptor, binding.baseUrl);
  const headers: Record<string, string> = {};
  for (const [name, entry] of Object.entries(
    descriptor.headers === undefined ? {} : record(descriptor.headers),
  )) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      bannedHeaders.includes(name.toLowerCase()) ||
      (plugin.auth.type === "header" && name.toLowerCase() === plugin.auth.name?.toLowerCase()) ||
      typeof entry !== "string" ||
      /[\r\n]/.test(entry)
    )
      throw new ProviderError("PLUGIN_REQUEST_INVALID");
    headers[name.toLowerCase()] = entry;
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
    body = Buffer.from(
      encoded(replaceReferences(descriptor.json, binding, context), LIMITS.payload),
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
      if (typeof part.name !== "string" || /[\r\n]/.test(part.name))
        throw new ProviderError("PLUGIN_REQUEST_INVALID");
      form.append(
        part.name,
        new Blob([Uint8Array.from(media.bytes)], { type: media.mime }),
        media.filename,
      );
    }
    const request = new Request(url, { method: "POST", body: form });
    body = new Uint8Array(await request.arrayBuffer());
    headers["content-type"] = request.headers.get("content-type") ?? "";
  }
  const responseType = String(descriptor.responseType ?? "json");
  if (!["json", "text", "binary", "image_json"].includes(responseType))
    throw new ProviderError("PLUGIN_REQUEST_INVALID");
  const timeout = descriptor.timeout ?? 30;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)
    throw new ProviderError("PLUGIN_REQUEST_INVALID");
  const auth = descriptor.auth === undefined ? plugin.auth : record(descriptor.auth);
  if (!["none", "bearer", "header", "query"].includes(String(auth.type)))
    throw new ProviderError("PLUGIN_REQUEST_INVALID");
  if (
    (auth.type === "header" || auth.type === "query") &&
    (typeof auth.name !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(auth.name) ||
      bannedHeaders.includes(auth.name.toLowerCase()))
  )
    throw new ProviderError("PLUGIN_REQUEST_INVALID");
  if (url.origin === new URL(binding.baseUrl).origin && auth.type !== "none") {
    if (!binding.secret) throw new ProviderError("PROVIDER_SECRET_UNAVAILABLE");
    if (auth.type === "bearer") headers.authorization = `Bearer ${binding.secret}`;
    if (auth.type === "header") headers[String(auth.name).toLowerCase()] = binding.secret;
    if (auth.type === "query") url.searchParams.set(String(auth.name), binding.secret);
  }
  if (body && descriptor.multipart === undefined && body.byteLength > LIMITS.payload)
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
    const context = validateContext(value);
    if (record(context.channel).baseUrl !== binding.baseUrl)
      throw new ProviderError("PLUGIN_CONTEXT_INVALID");
    const call = (hook: string, args: unknown[]) =>
      this.runner.call(binding.source, hook, args, signal);
    const send = async (descriptor: unknown, submitting = false) => {
      const request = await buildHostRequest(descriptor, plugin, binding, context);
      if (signal?.aborted) throw new ProviderError("PLUGIN_CANCELLED");
      let response: HostResponse;
      try {
        response = await this.transport(request, signal);
      } catch (error) {
        if (
          error instanceof ProviderError &&
          ["PROVIDER_ENDPOINT_BLOCKED", "MOCK_RESPONSE_TYPE_UNSUPPORTED"].includes(error.code)
        )
          throw error;
        if (submitting) throw new ProviderError("PROVIDER_OUTCOME_UNKNOWN");
        throw error;
      }
      response = redact(response, binding.secret) as HostResponse;
      if (response.status >= 300 && response.status < 400)
        throw new ProviderError("PROVIDER_REDIRECT_BLOCKED");
      encoded(response, LIMITS.payload);
      if (response.status < 200 || response.status >= 300) {
        const classified = plugin.hooks.includes("classifyError")
          ? await call("classifyError", [context, response])
          : null;
        const error =
          classified === null
            ? {
                class: response.status === 429 || response.status >= 500 ? "retryable" : "terminal",
              }
            : record(classified);
        if (
          !["retryable", "terminal", "moderation", "provider_balance"].includes(String(error.class))
        )
          throw new ProviderError("PLUGIN_RESULT_INVALID");
        throw new ProviderError(`PROVIDER_${String(error.class).toUpperCase()}`);
      }
      return response;
    };
    if (
      phase === "submit" &&
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
    }
    const suffix = phase === "submit" ? "Submit" : phase === "query" ? "Query" : "Cancel";
    if (!plugin.hooks.includes(`build${suffix}Request`)) {
      if (phase === "cancel") return { cancellation: "local_only" };
      throw new ProviderError("PLUGIN_HOOK_MISSING");
    }
    const descriptor = await call(`build${suffix}Request`, [context]);
    const response = await send(descriptor, phase === "submit");
    if (phase === "cancel") return { cancellation: "requested" };
    const parsed = record(await call(`parse${suffix}Response`, [context, response]));
    if (parsed.state !== undefined) encoded(parsed.state, LIMITS.state);
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
