export function imageDisplaySize(metadata: Record<string, unknown>) {
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  const orientation = Number(metadata.orientation);
  return Number.isInteger(orientation) && orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height };
}
