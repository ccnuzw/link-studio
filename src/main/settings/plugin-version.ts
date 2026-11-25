import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";

const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const maxUint64 = (1n << 64n) - 1n;
const maxInt64 = maxUint64 >> 1n;

export function compareUpgradeCore(left: string, right: string) {
  const core = (version: string) => {
    const [base = ""] = version.split("-", 1);
    return base.split(".").map((part) => {
      const value = /^\d+$/.test(part) ? BigInt(part) : 0n;
      return value < maxInt64 ? value : maxInt64;
    });
  };
  const first = core(left);
  const second = core(right);
  for (let index = 0; index < Math.max(first.length, second.length); index++) {
    const difference = (first[index] ?? 0n) - (second[index] ?? 0n);
    if (difference) return difference > 0n ? 1 : -1;
  }
  return 0;
}

export function declaredPluginVersion(value: unknown) {
  return typeof value === "string" && value.length <= 32 && versionPattern.test(value) ? value : "";
}

function parseVersion(value: unknown) {
  if (typeof value !== "string") return;
  const match = versionPattern.exec(value);
  if (!match) return;
  const core = match.slice(1, 4).map(BigInt);
  if (core.some((part) => part > maxUint64)) return;
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
    const numeric = /^\d+$/.test(part) && BigInt(part) <= maxUint64;
    const otherNumeric = /^\d+$/.test(other) && BigInt(other) <= maxUint64;
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
  const requested = declaredPluginVersion(declared);
  const candidate = parseVersion(requested);
  const highest = versions
    .flatMap((value) => {
      const version = parseVersion(value);
      return version ? [version] : [];
    })
    .sort(compare)
    .at(-1);
  if (
    requested &&
    !versions.includes(requested) &&
    (!highest || (candidate && compare(candidate, highest) > 0))
  )
    return requested;
  if (!highest) return "1.0.0";
  const [major, minor, patch = 0n] = highest.core;
  if (patch === maxUint64)
    throw new ProviderError("PLUGIN_VERSION_LIMIT", [
      {
        path: "meta.version",
        message: `无法自动决定版本号：版本号 "${highest.value}" 的补丁位已经到上限，无法递增`,
      },
    ]);
  return `${major}.${minor}.${patch + 1n}`;
}
