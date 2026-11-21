export const outpaintRatios = [
  "原比例",
  "自由",
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "21:9",
] as const;
export type OutpaintRatio = (typeof outpaintRatios)[number];
export type OutpaintPlan = {
  width: number;
  height: number;
  left: number;
  top: number;
  imageWidth: number;
  imageHeight: number;
};

export function planOutpaint(
  sourceWidth: number,
  sourceHeight: number,
  scale: number,
  ratio: OutpaintRatio,
  horizontal: number,
  vertical: number,
  heightScale = scale,
): OutpaintPlan {
  const [ratioWidth, ratioHeight] = /^\d+:\d+$/.test(ratio) ? ratio.split(":").map(Number) : [];
  const aspect = ratioWidth && ratioHeight ? ratioWidth / ratioHeight : sourceWidth / sourceHeight;
  const baseWidth = sourceWidth * scale;
  const baseHeight = sourceHeight * scale;
  const expandedWidth = ratio === "自由" ? baseWidth : Math.max(baseWidth, baseHeight * aspect);
  const expandedHeight = ratio === "自由" ? sourceHeight * heightScale : expandedWidth / aspect;
  const fit = Math.min(1, 2048 / Math.max(expandedWidth, expandedHeight));
  const width = Math.max(1, Math.round(expandedWidth * fit));
  const height = Math.max(1, Math.round(expandedHeight * fit));
  const imageWidth = Math.min(width, Math.max(1, Math.round(sourceWidth * fit)));
  const imageHeight = Math.min(height, Math.max(1, Math.round(sourceHeight * fit)));
  return {
    width,
    height,
    imageWidth,
    imageHeight,
    left: Math.round(((width - imageWidth) * horizontal) / 100),
    top: Math.round(((height - imageHeight) * vertical) / 100),
  };
}

export function outpaintAspect(ratios: readonly string[], plan: OutpaintPlan) {
  const aspect = plan.width / plan.height;
  const options = ratios.flatMap((ratio) => {
    const [width, height] = ratio.split(":").map(Number);
    return width && height
      ? [{ ratio, distance: Math.abs(Math.log(aspect / (width / height))) }]
      : [];
  });
  const closest = options.sort((left, right) => left.distance - right.distance)[0];
  return closest?.distance !== undefined && closest.distance < 0.02
    ? closest.ratio
    : ratios.includes("adaptive")
      ? "adaptive"
      : undefined;
}

export function outpaintSize(sizes: readonly string[], plan: OutpaintPlan) {
  return [...sizes].sort((left, right) => {
    const distance = (size: string) => {
      const [width, height] = size.split("x").map(Number);
      return width && height
        ? Math.abs(Math.log(plan.width / plan.height / (width / height)))
        : Infinity;
    };
    return distance(left) - distance(right);
  })[0];
}
