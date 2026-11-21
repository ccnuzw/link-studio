import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { HostRequest, Transport } from "../../../packages/provider-runtime/src/host.ts";
import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";

export class ChannelLimits {
  private readonly slots = new Map<string, { active: number; next: number }>();

  tryAcquire(id: string, max?: number) {
    if (!max) return () => {};
    const slot = this.slots.get(id) ?? { active: 0, next: 0 };
    if (slot.active >= max) return undefined;
    this.slots.set(id, slot);
    slot.active++;
    return () => {
      slot.active--;
    };
  }

  async acquire(id: string, max?: number, rps?: number, signal?: AbortSignal) {
    if (!max && !rps) return () => {};
    const slot = this.slots.get(id) ?? { active: 0, next: 0 };
    this.slots.set(id, slot);
    const clock = () => performance.now();
    while ((max && slot.active >= max) || slot.next > clock()) {
      await delay(Math.max(10, Math.min(100, slot.next - clock())), undefined, { signal });
    }
    signal?.throwIfAborted();
    slot.active++;
    if (rps) slot.next = clock() + 1000 / rps;
    return () => {
      slot.active--;
    };
  }
}

function blocked(): never {
  throw new ProviderError("PROVIDER_ENDPOINT_BLOCKED");
}

function addressClass(address: string) {
  if (isIP(address) === 4) {
    const [first = 0, second = 0, third = 0] = address.split(".").map(Number);
    if (
      first === 0 ||
      first >= 224 ||
      (first === 169 && second === 254) ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 192 && second === 0 && third === 0)
    )
      return "blocked";
    if (
      first === 127 ||
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    )
      return "local";
    return "public";
  }
  if (address === "::1" || /^f[cd][\da-f]{2}:/i.test(address)) return "local";
  return /^[23][\da-f]{3}:/i.test(address) ? "public" : "blocked";
}

export function endpointURL(value: string, allowLocal: boolean) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return blocked();
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol) ||
    /(?:^|\.)(?:metadata|internal)(?:\.|$)/i.test(hostname) ||
    /\.$/.test(hostname)
  )
    blocked();
  const classification = isIP(hostname)
    ? addressClass(hostname)
    : /(?:^|\.)localhost$|\.local$/i.test(hostname)
      ? "local"
      : "public";
  if (
    classification === "blocked" ||
    (classification === "local" && !allowLocal) ||
    (url.protocol === "http:" && !allowLocal)
  )
    blocked();
  return url;
}

export async function openProviderResponse(
  base: string,
  allowLocal: boolean,
  input: HostRequest,
  signal?: AbortSignal,
): Promise<IncomingMessage> {
  const origin = endpointURL(base, allowLocal);
  const target = new URL(input.url);
  const local = allowLocal && target.origin === origin.origin;
  if (target.username || target.password || target.hash) blocked();
  if (target.origin !== origin.origin) endpointURL(target.origin, false);
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs)])
    : AbortSignal.timeout(input.timeoutMs);
  const entries = await lookup(hostname, { all: true }).catch(() => {
    throw new ProviderError("PROVIDER_REQUEST_NOT_SENT");
  });
  if (requestSignal.aborted) throw new ProviderError("PROVIDER_REQUEST_NOT_SENT");
  if (
    !entries.length ||
    entries.some(({ address }) => {
      const classification = addressClass(address);
      return (
        classification === "blocked" ||
        (classification === "local" && !local) ||
        (target.protocol === "http:" && classification !== "local")
      );
    })
  )
    blocked();
  const address = entries[0];
  if (!address) return blocked();
  return new Promise((resolve, reject) => {
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      target,
      {
        method: input.method,
        headers: { ...input.headers, "accept-encoding": "identity" },
        signal: requestSignal,
        agent: false,
        family: address.family,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      },
      (response) => {
        if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
          response.destroy();
          reject(new ProviderError("PROVIDER_ENDPOINT_BLOCKED"));
        } else resolve(response);
      },
    );
    request.on("error", reject);
    request.end(input.body);
  });
}

export function responseHeaders(response: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(response.headers).flatMap(([name, value]) => {
      const first = Array.isArray(value) ? value[0] : value;
      return first === undefined || name === "set-cookie" ? [] : [[name, first]];
    }),
  );
}

function stripImageData(body: unknown) {
  if (body && typeof body === "object") {
    if (Object.hasOwn(body, "b64_json")) delete (body as Record<string, unknown>).b64_json;
    for (const value of Object.values(body)) stripImageData(value);
  }
}

export function providerTransport(
  base: string,
  allowLocal: boolean,
  normalize?: (body: unknown) => Promise<unknown>,
  binary?: Transport,
): Transport {
  return async (input, signal) => {
    if (input.responseType === "binary") {
      if (binary) return binary(input, signal);
      throw new ProviderError("MEDIA_TRANSPORT_UNAVAILABLE");
    }
    const response = await openProviderResponse(base, allowLocal, input, signal);
    const status = response.statusCode ?? 502;
    const headers = responseHeaders(response);
    const success = status >= 200 && status < 300;
    const image = input.responseType === "image_json";
    const chunks: Buffer[] = [];
    let bytes = 0;
    const limit = (success && image ? 64 : 1) * 1024 * 1024;
    for await (const chunk of response) {
      const remaining = limit - bytes;
      if (chunk.length > remaining) {
        if (success) throw new ProviderError("PROVIDER_RESPONSE_LIMIT");
        chunks.push(chunk.subarray(0, remaining));
        break;
      }
      bytes += chunk.length;
      chunks.push(chunk);
    }
    let text = Buffer.concat(chunks).toString("utf8");
    let body: unknown = text;
    if (input.responseType === "json" || image) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (image) {
      if (success) {
        if (!body || Array.isArray(body) || typeof body !== "object" || !normalize)
          throw new ProviderError("PROVIDER_RESPONSE_INVALID");
        body = await normalize(body);
      }
      stripImageData(body);
      text = body ? JSON.stringify(body) : text.includes('"b64_json"') ? "" : text;
    }
    return { status, headers, body, text };
  };
}

export function withChannelHeaders(
  transport: Transport,
  _origin: string,
  headers: Array<{ name: string; value: string }>,
): Transport {
  return (input, signal) =>
    transport(
      {
        ...input,
        headers: {
          ...Object.fromEntries(headers.map(({ name, value }) => [name.toLowerCase(), value])),
          ...input.headers,
        },
      },
      signal,
    );
}
