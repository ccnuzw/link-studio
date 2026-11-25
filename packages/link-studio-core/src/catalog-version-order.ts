function numericCore(version: string): number[] {
  const [core = ""] = version.split("-", 1);
  return core.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

export function compareCore(left: string, right: string) {
  const first = numericCore(left);
  const second = numericCore(right);
  for (let index = 0; index < Math.max(first.length, second.length); index++) {
    const difference = (first[index] ?? 0) - (second[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export function newestCatalogVersions<Entry extends { version: string }>(
  entries: readonly Entry[],
) {
  return [...entries].reverse().sort((left, right) => compareCore(right.version, left.version));
}

export function olderCatalogVersions<Entry extends { version: string }>(ordered: readonly Entry[]) {
  const latest = ordered[0];
  return latest ? ordered.filter((entry) => compareCore(entry.version, latest.version) < 0) : [];
}

export function groupAdapters<Entry extends { key: string; version: string }>(
  plugins: readonly Entry[],
) {
  const groups = new Map<string, Entry[]>();
  for (const plugin of plugins) {
    const group = groups.get(plugin.key);
    if (group) group.push(plugin);
    else groups.set(plugin.key, [plugin]);
  }
  return [...groups]
    .sort(([left], [right]) => (left > right ? 1 : left < right ? -1 : 0))
    .map(([, group]) => newestCatalogVersions(group));
}
