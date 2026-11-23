import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AttachmentCheck } from "../../../packages/agent-runtime/upstream/src/attachments.ts";
import { maxAgentDocumentBytes } from "../../../packages/link-studio-core/src/canvas-agent.ts";
import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";

function directory(root: string, project: string) {
  return join(root, "documents", createHash("sha256").update(project).digest("hex"));
}

export async function saveAgentDocument(
  root: string,
  project: string,
  name: string,
  bytes: Uint8Array,
) {
  if (
    !/\.(txt|md|markdown)$/i.test(name) ||
    /[/\\]/.test(name) ||
    bytes.length === 0 ||
    bytes.length > maxAgentDocumentBytes
  )
    throw new ProviderError("AGENT_ARGUMENT_INVALID");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProviderError("AGENT_ARGUMENT_INVALID");
  }
  if (text.includes("\0")) throw new ProviderError("AGENT_ARGUMENT_INVALID");
  const data = JSON.stringify({ uploadId: randomUUID(), name, text, size: bytes.byteLength });
  const documentId = createHash("sha256").update(data).digest("hex");
  const target = directory(root, project);
  await mkdir(target, { mode: 0o700, recursive: true });
  const temporary = join(target, randomUUID());
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await rename(temporary, join(target, documentId));
  } finally {
    await rm(temporary, { force: true });
  }
  return { documentId };
}

export async function loadAgentDocument(
  root: string,
  project: string,
  documentId: string,
): Promise<AttachmentCheck> {
  try {
    if (!/^[a-f0-9]{64}$/.test(documentId)) throw new Error();
    const data = await readFile(join(directory(root, project), documentId), "utf8");
    if (createHash("sha256").update(data).digest("hex") !== documentId) throw new Error();
    const { name, text, size } = JSON.parse(data);
    return {
      asset_id: documentId,
      kind: "document",
      name,
      text,
      byte_size: size,
      mime_type: /\.txt$/i.test(name) ? "text/plain" : "text/markdown",
      url: `document:${documentId}`,
    };
  } catch {
    throw new ProviderError("AGENT_REFERENCE_UNAVAILABLE");
  }
}
