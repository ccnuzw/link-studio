import { createHash } from "node:crypto";
import type { AttachmentCheck } from "../../../packages/agent-runtime/upstream/src/attachments.ts";
import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";
import { endpointURL, openProviderResponse } from "./network.ts";

export async function readAgentReference(
  input: string,
  redact: (text: string) => string,
): Promise<AttachmentCheck> {
  if (redact(input) !== input) throw new ProviderError("AGENT_REFERENCE_UNAVAILABLE");
  const url = endpointURL(input, false);
  const response = await openProviderResponse(url.origin, false, {
    method: "GET",
    url: url.href,
    headers: { accept: "text/plain, text/markdown" },
    timeoutMs: 5000,
    responseType: "text",
  });
  const mime = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (response.statusCode !== 200 || (mime !== "text/plain" && mime !== "text/markdown")) {
    response.destroy();
    throw new ProviderError("AGENT_REFERENCE_UNAVAILABLE");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > 32 * 1024) throw new ProviderError("AGENT_REFERENCE_UNAVAILABLE");
    chunks.push(chunk);
  }
  const text = redact(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  return {
    asset_id: createHash("sha256").update(url.href).update("\0").update(text).digest("hex"),
    kind: "document",
    name: url.hostname,
    mime_type: mime,
    byte_size: bytes,
    url: url.href,
    text,
  };
}
