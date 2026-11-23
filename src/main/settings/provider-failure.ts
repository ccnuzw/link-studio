export function providerFailureMessage(
  message: unknown,
  redact: (value: string) => string,
  privateValues: unknown[],
) {
  if (typeof message !== "string" || !message.trim() || message.length > 4096) return undefined;
  const values = privateValues
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === "string" && !!value.trim());
  let text = message;
  for (const value of [...new Set(values)].sort((left, right) => right.length - left.length)) {
    text = text.replaceAll(value, "[已隐藏]");
  }
  text = redact(text).replace(/https?:\/\/[^\s<>"']+/gi, "[地址已隐藏]");
  if (
    /(?:authorization|api[-_ ]?key|password|signature|secret|token|cookie|credential|\b(?:bearer|basic)\s|data:|[{}<>]|[?&][\w.-]+=|[\w+/=-]{48,})/i.test(
      text,
    )
  )
    return undefined;
  return (
    Array.from(text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim())
      .slice(0, 300)
      .join("") || undefined
  );
}
