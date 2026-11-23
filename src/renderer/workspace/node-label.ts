export function availableNodeLabel(base: string, existing: Iterable<string>): string {
  const used = new Set(existing);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base} ${suffix}`)) suffix++;
  return `${base} ${suffix}`;
}

export function normalizeNodeLabel(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? [...normalized].slice(0, 40).join("") : fallback;
}

export function assetNodeLabel(filename: string, fallback: string): string {
  const trimmed = filename.trim();
  const lastDot = trimmed.lastIndexOf(".");
  return normalizeNodeLabel(lastDot > 0 ? trimmed.slice(0, lastDot) : trimmed, fallback);
}
