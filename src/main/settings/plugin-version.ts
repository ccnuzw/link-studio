import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";

function parseVersion(value: unknown) {
  if (typeof value !== "string" || value.length > 32) return;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\w-]+(?:\.[\w-]+)*))?$/.exec(value);
  if (!match || value.includes("_")) return;
  const core = match.slice(1, 4).map(BigInt);
  if (core.some((part) => part > 2n ** 64n - 1n)) return;
  return { value, core, prerelease: match[4]?.split(".") ?? [] };
}

type Version = NonNullable<ReturnType<typeof parseVersion>>;

function compare(left: Version, right: Version) {
  for (const [index, part] of left.core.entries()) {
    const other = right.core[index] ?? 0n;
    if (part !== other) return part > other ? 1 : -1;
  }
  if (!left.prerelease.length || !right.prerelease.length)
    return Number(!left.prerelease.length) - Number(!right.prerelease.length);
  for (const [index, part] of left.prerelease.entries()) {
    const other = right.prerelease[index];
    if (other === undefined) return 1;
    if (part === other) continue;
    const numeric = /^\d+$/.test(part);
    const otherNumeric = /^\d+$/.test(other);
    if (numeric && otherNumeric) {
      if (BigInt(part) === BigInt(other)) continue;
      return BigInt(part) > BigInt(other) ? 1 : -1;
    }
    if (numeric !== otherNumeric) return numeric ? -1 : 1;
    return part > other ? 1 : -1;
  }
  return left.prerelease.length - right.prerelease.length;
}

export function nextPluginVersion(declared: unknown, versions: unknown[]) {
  const candidate = parseVersion(declared);
  const highest = versions
    .flatMap((value) => {
      const version = parseVersion(value);
      return version ? [version] : [];
    })
    .sort(compare)
    .at(-1);
  if (!highest) return candidate?.value ?? "1.0.0";
  if (candidate && compare(candidate, highest) > 0) return candidate.value;
  const [major, minor, patch = 0n] = highest.core;
  const next = `${major}.${minor}.${patch + 1n}`;
  if (!parseVersion(next)) throw new ProviderError("PLUGIN_VERSION_LIMIT");
  return next;
}
