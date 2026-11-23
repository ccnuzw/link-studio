export function channelNameIssue(raw: string) {
  const name = raw.trim();
  if (!name) return "请填写渠道名称";
  if ([...name].length > 128) return "渠道名称不能超过 128 个字";
}

export function channelEndpointIssue(raw: string) {
  const text = raw.trim();
  if (!text) return "请填写 Base URL";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "Base URL 不是合法的地址";
  }
  if (!["http:", "https:"].includes(url.protocol)) return "Base URL 只能是 http 或 https";
  if (!url.hostname) return "Base URL 缺少主机名";
  if (url.username || url.password) return "Base URL 不能包含用户名或密码";
  if (/[?#]/.test(text)) return "Base URL 不能带查询参数或片段";
}

export function channelEndpointIdentity(url: URL, saved?: string) {
  return url.href === saved ? saved : url.href.replace(/\/$/, "");
}

export function channelHeaderIssue(rawName: string, value: string, seen: Set<string>) {
  const name = rawName.trim();
  const key = name.toLowerCase();
  if (!name) return "请填写请求头名称";
  if (!/^[a-z0-9-]+$/.test(key) || name.length > 80) return `请求头名称「${name}」不合法`;
  if (
    /^(?:host|connection|content-.*|transfer-encoding|expect|upgrade|cookie|.*(?:auth|secret|token|api-key).*)$/.test(
      key,
    )
  )
    return `请求头 ${name} 不能设置`;
  if (seen.has(key)) return `请求头 ${name} 重复（名称不区分大小写）`;
  seen.add(key);
  if (value.length > 1024) return "请求头值不能超过 1024 个字符";
  if (/[\x00-\x1f\x7f]/.test(value)) return "请求头值不能包含换行或控制字符";
  if (/[^\x20-\x7e]/.test(value)) return "请求头值只能包含可打印的 ASCII 字符";
}
