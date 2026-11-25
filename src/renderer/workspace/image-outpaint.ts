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
export function outpaintSize(sizes: readonly string[], plan: { width: number; height: number }) {
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
