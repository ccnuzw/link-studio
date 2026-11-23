export function importModelKey(upstream: string, channel: string, taken: Set<string>) {
  const base =
    upstream
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "")
      .slice(0, 80) || "model";
  if (!taken.has(base)) return { key: base, prefixed: false };
  const prefix = `${channel}-${base}`;
  let key = prefix;
  for (let suffix = 2; taken.has(key); suffix++) key = `${prefix}-${suffix}`;
  return { key, prefixed: true };
}
