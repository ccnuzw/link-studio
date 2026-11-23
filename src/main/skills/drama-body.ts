import { isUtf8 } from "node:buffer";
import { posix } from "node:path";

const scriptExtensions = new Set([
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".sh",
  ".bash",
  ".rb",
  ".pl",
]);
const limit = 16000;

export function isSkillScript(path: string) {
  return path.startsWith("scripts/") || scriptExtensions.has(posix.extname(path).toLowerCase());
}

function clip(text: string) {
  const bounded = text.slice(0, limit * 2);
  return Array.from(bounded).slice(0, limit).join("");
}

export function skillMethodText(
  manifest: Uint8Array,
  paths: string[],
  read: (path: string) => Uint8Array,
) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(manifest).replace(/\r\n?/g, "\n");
  const header = /^---[^\S\n]*\n[\s\S]*?\n---[^\S\n]*(?:\n|$)/.exec(text);
  if (!header) throw Error("无法读取技能正文");
  let body = clip(text.slice(header[0].length).trim());
  const pending = new Set(paths.filter((path) => path !== "SKILL.md" && !isSkillScript(path)));
  while (Array.from(body).length < limit) {
    const refs = Array.from(pending)
      .filter((path) => body.includes(path))
      .sort((left, right) => body.indexOf(left) - body.indexOf(right));
    if (!refs.length) break;
    for (const path of refs) {
      pending.delete(path);
      const bytes = read(path);
      if (bytes.subarray(0, 8192).includes(0) || !isUtf8(bytes)) continue;
      const content = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        bytes.subarray(0, limit * 4),
        { stream: bytes.length > limit * 4 },
      );
      body = clip(`${body}\n\n## ${path}\n${content}`);
      if (Array.from(body).length === limit) break;
    }
  }
  return body;
}
