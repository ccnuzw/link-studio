const encoder = new TextEncoder();
const truncated = "…（已截断）";
const intro =
  "我的 video-canvas 协议插件出错了，请按插件契约修复，输出完整的 .js 文件（版本号不用改，上传时会自动递增）。";

function limitBytes(text: string, limit: number) {
  if (encoder.encode(text).length <= limit) return text;
  let remaining = limit - encoder.encode(truncated).length;
  let end = 0;
  for (const character of text) {
    remaining -= encoder.encode(character).length;
    if (remaining < 0) break;
    end += character.length;
  }
  return text.slice(0, end) + truncated;
}

export function composeRepairReport(...sections: string[]) {
  return limitBytes([intro, ...sections.filter(Boolean)].join("\n\n"), 16 * 1024);
}

type UploadIssue = { path: string; message: string };

export function normalizeUploadIssues(raw: unknown): UploadIssue[] {
  if (!Array.isArray(raw)) return [];
  const unique = new Map<string, UploadIssue>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const path = typeof item.path === "string" ? item.path.trim() : "";
    const message =
      typeof item.message === "string" && item.message.trim() ? item.message.trim() : "未知问题";
    unique.set(JSON.stringify([path, message]), { path, message });
  }
  return [...unique.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

export function uploadRepairReport(issues: readonly UploadIssue[]) {
  const items = issues.map(({ path, message }) => {
    const [first, ...rest] = limitBytes(message.replace(/\r\n?/g, "\n").trim(), 2048).split("\n");
    return [
      `- ${path.trim() || "（整个文件）"}：${first}`,
      ...rest.map((line) => line && `  ${line}`),
    ].join("\n");
  });
  return composeRepairReport("阶段：上传预检", items.length ? ["问题：", ...items].join("\n") : "");
}
