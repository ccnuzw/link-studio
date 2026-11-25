export function parseCanvasAspect(value: unknown) {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) return undefined;
  const ratio = Number(match[1]) / Number(match[2]);
  return ratio > 0 && Number.isFinite(ratio) ? ratio : undefined;
}

export function imageDisplaySize(metadata: Record<string, unknown>) {
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  const orientation = Number(metadata.orientation);
  return Number.isInteger(orientation) && orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height };
}
