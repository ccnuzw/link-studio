import { MOTION_PRESETS as motions, STYLE_PRESETS as styles } from "../../shared/media-preset-data";

export * from "../../shared/media-preset-data";

const covers = import.meta.glob<string>("./preset-assets/*/*.{webp,gif}", {
  eager: true,
  query: "?url",
  import: "default",
});
const withCover = <Preset extends { cover: string }>(preset: Preset) => ({
  ...preset,
  cover: covers[`./preset-assets/${preset.cover}`] ?? "",
});
export const STYLE_PRESETS = styles.map(withCover);
export const MOTION_PRESETS = motions.map(withCover);
