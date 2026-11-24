import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { isPublicReferenceURL } from "../../../packages/link-studio-core/src/media-generation.ts";
import { maxModelReferenceMB } from "../../../packages/link-studio-core/src/model-config.ts";
import { openProviderResponse } from "./network.ts";

export const trialMimes = {
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

export async function uploadTrialReference(
  path: string,
  mime: string,
  maximum: number,
  endpoint: string,
  token?: string,
  signal?: AbortSignal,
) {
  const target = new URL(endpoint);
  const loopback = ["127.0.0.1", "[::1]"].includes(target.hostname);
  if (
    target.search ||
    target.hash ||
    target.username ||
    target.password ||
    (!loopback && !isPublicReferenceURL(endpoint)) ||
    !Object.values(trialMimes).some((types) => types.includes(mime)) ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > maxModelReferenceMB * 1024 ** 2
  )
    throw new Error("Invalid trial upload configuration");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > maximum) throw new Error("Invalid trial file");
    const boundary = `link-studio-${randomUUID()}`;
    const start = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="reference.${mime.split("/")[1]}"\r\nContent-Type: ${mime}\r\n\r\n`,
    );
    const end = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Readable.from(
      (async function* () {
        yield start;
        let bytes = 0;
        for await (const chunk of handle.createReadStream({
          autoClose: false,
          end: stat.size - 1,
        })) {
          bytes += chunk.length;
          yield chunk;
        }
        if (bytes !== stat.size) throw new Error("Trial file changed during upload");
        yield end;
      })(),
    );
    try {
      const response = await openProviderResponse(
        target.origin,
        loopback,
        {
          method: "POST",
          url: target.href,
          timeoutMs: 180000,
          responseType: "text",
          headers: {
            "content-type": `multipart/form-data; boundary=${boundary}`,
            "content-length": String(start.length + stat.size + end.length),
            ...(token && { authorization: `Bearer ${token}` }),
          },
        },
        signal,
        body,
      );
      try {
        if (
          response.statusCode === undefined ||
          response.statusCode < 200 ||
          response.statusCode >= 300
        )
          throw new Error("Trial upload failed");
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of response) {
          length += chunk.length;
          if (length > 64 * 1024) throw new Error("Invalid asset response");
          chunks.push(chunk);
        }
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const asset = result?.code === 0 ? result.data : result?.code === undefined ? result : null;
        if (
          typeof asset?.url !== "string" ||
          asset.url.length > 4096 ||
          !isPublicReferenceURL(asset.url)
        )
          throw new Error("Invalid asset URL");
        return asset.url as string;
      } finally {
        response.destroy();
      }
    } finally {
      body.destroy();
    }
  } finally {
    await handle.close();
  }
}
