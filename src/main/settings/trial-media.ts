import { randomUUID } from "node:crypto";
import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";

const lifetime = 15 * 60 * 1000;
export const trialMediaLimit = 64 * 1024 * 1024;
const supported = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/mp4",
  "audio/ogg",
  "audio/opus",
  "audio/webm",
  "audio/flac",
]);

export function trialOutputMime(kind: string, declared?: string, fallback?: string) {
  const aliases: Record<string, string> = {
    "audio/mp3": "audio/mpeg",
    "audio/x-wav": "audio/wav",
    "audio/wave": "audio/wav",
    "audio/x-m4a": "audio/mp4",
    "application/ogg": "audio/ogg",
  };
  const header = declared?.split(";")[0]?.trim().toLowerCase();
  const raw =
    !header || ["application/octet-stream", "binary/octet-stream"].includes(header)
      ? (fallback ?? "")
      : header;
  const mime = aliases[raw] ?? raw;
  if (!supported.has(mime) || !mime.startsWith(`${kind}/`))
    throw new ProviderError("JOB_OUTPUT_INVALID");
  return mime;
}

export function inlineTrialImage(encoded: string) {
  const data = encoded.replace(/[\r\n]/g, "");
  if (data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
    throw new ProviderError("JOB_OUTPUT_INVALID");
  const bytes = Buffer.from(data, "base64");
  return imagePreviewBlob(bytes);
}

export function imagePreviewBlob(bytes: Buffer<ArrayBuffer>) {
  let type: string;
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) type = "image/png";
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) type = "image/jpeg";
  else if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP")
    type = "image/webp";
  else if (["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6))) type = "image/gif";
  else throw new ProviderError("JOB_OUTPUT_INVALID");
  return new Blob([bytes], { type });
}

export class TrialMediaStore {
  private entries = new Map<string, { owner: number; blob: Blob; expiry: NodeJS.Timeout }>();
  private bytes = 0;

  private remove(token: string) {
    const entry = this.entries.get(token);
    if (!entry) return;
    clearTimeout(entry.expiry);
    this.bytes -= entry.blob.size;
    this.entries.delete(token);
  }

  close(owner: number) {
    for (const [token, entry] of this.entries) if (entry.owner === owner) this.remove(token);
  }

  grant(owner: number, blob: Blob) {
    if (!supported.has(blob.type) || !blob.size || blob.size > trialMediaLimit)
      throw new ProviderError("JOB_OUTPUT_INVALID");
    while (this.bytes + blob.size > 2 * trialMediaLimit || this.entries.size >= 128) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.remove(oldest);
    }
    const token = randomUUID();
    const expiry = setTimeout(() => this.remove(token), lifetime).unref();
    this.bytes += blob.size;
    this.entries.set(token, { owner, blob, expiry });
    return `link-media://trial/${token}`;
  }

  serve(owner: number, request: Request) {
    const url = new URL(request.url);
    const entry = this.entries.get(url.pathname.slice(1));
    if (
      url.hostname !== "trial" ||
      url.search ||
      url.hash ||
      !entry ||
      entry.owner !== owner ||
      !["GET", "HEAD"].includes(request.method)
    )
      return new Response(null, { status: 404 });
    const { blob } = entry;
    const headers = new Headers({
      "content-type": blob.type,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
    const range = request.headers.get("range");
    let start = 0;
    let end = blob.size - 1;
    if (range !== null) {
      const parts = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (parts?.[1]) {
        start = Number(parts[1]);
        if (parts[2]) end = Math.min(end, Number(parts[2]));
      } else start = blob.size - Math.min(blob.size, Number(parts?.[2] || 0));
      if (!parts || !Number.isSafeInteger(start) || start > end)
        return new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${blob.size}` },
        });
      headers.set("content-range", `bytes ${start}-${end}/${blob.size}`);
    }
    headers.set("content-length", String(end - start + 1));
    return new Response(request.method === "HEAD" ? null : blob.slice(start, end + 1), {
      status: range === null ? 200 : 206,
      headers,
    });
  }
}
