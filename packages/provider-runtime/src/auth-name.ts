export const reservedHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
]);

export function authNameIssue(type: unknown, name: unknown): string | undefined {
  if (type !== "header" && type !== "query") return;
  const value = typeof name === "string" ? name : "";
  if (type === "query") {
    if (!value.trim() || Buffer.byteLength(value) > 64)
      return "auth.type 为 query 时必须填写查询参数名（最长 64 个字符）";
  } else {
    if (!value || /[^!#$%&'*+.^_`|~0-9A-Za-z-]/.test(value) || Buffer.byteLength(value) > 64)
      return "auth.type 为 header 时必须填写合法的请求头名（最长 64 个字符）";
    if (reservedHeaders.has(value.toLowerCase())) return "桌面宿主不允许用保留请求头作为鉴权字段";
  }
}
