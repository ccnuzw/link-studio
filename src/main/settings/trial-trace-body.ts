const safeValue = new Set(["status", "type", "code", "role", "finish_reason", "object"]);
const sensitive =
  /(?:authorization|password|credential|secret|token|cookie|signature|api.?key|base64|b64_json)/i;

export function traceBody(value: unknown, redact: (text: string) => string) {
  let remaining = 120;
  let truncated = false;
  function visit(raw: unknown, key: string, depth: number): unknown {
    if (--remaining < 0 || depth > 6) {
      truncated = true;
      return "…";
    }
    if (sensitive.test(key)) return "[已隐藏]";
    if (typeof raw === "string") {
      if (safeValue.has(key) && /^[a-zA-Z0-9_.-]{1,64}$/.test(raw)) return redact(raw);
      return `[文本 ${raw.length} 字符]`;
    }
    if (typeof raw !== "object" || raw === null) return raw;
    if (Array.isArray(raw)) {
      const entries = [];
      for (const item of raw) {
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        entries.push(visit(item, key, depth + 1));
      }
      return entries;
    }
    const fields: [string, unknown][] = [];
    for (const [name, entry] of Object.entries(raw)) {
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const label = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(name)
        ? redact(name)
        : `[字段 ${fields.length + 1}]`;
      fields.push([label, visit(entry, name, depth + 1)]);
    }
    return Object.fromEntries(fields);
  }
  const text = JSON.stringify(visit(value, "", 0), null, 2) ?? "";
  return { text: text.slice(0, 4096), truncated: truncated || text.length > 4096 };
}
