export function keyedItems<T>(items: readonly T[], identify: (item: T) => string) {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const identity = identify(item);
    const occurrence = counts.get(identity) ?? 0;
    counts.set(identity, occurrence + 1);
    return { item, key: JSON.stringify([identity, occurrence]) };
  });
}
