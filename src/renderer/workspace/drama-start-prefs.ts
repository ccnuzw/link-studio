import type { DramaImageParams, DramaStartRatio, PromptPicks } from "@link-studio/core";
import { defaultDramaStyle, dramaStyles, promptSteps } from "@link-studio/core";

const key = "drama-start-prefs";
export const emptyStartImages = { character: "", scene: "", prop: "" };
type StartPrefs = {
  ratio: DramaStartRatio;
  seconds: number;
  genre?: string;
  styleKey?: string;
  styleCustom?: string;
  textModel?: string;
  videoModel?: string;
  imageModels?: typeof emptyStartImages;
  imageParams?: DramaImageParams;
  prompts?: PromptPicks;
};
const savedModel = (value: unknown) =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
    ? value
    : "";

export function loadDramaStartPrefs(): StartPrefs {
  const defaults: StartPrefs = { ratio: "9:16", seconds: 60 };
  try {
    const data = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!data || typeof data !== "object") return defaults;
    return {
      ratio: ["9:16", "16:9", "4:3"].includes(data.ratio) ? data.ratio : defaults.ratio,
      seconds:
        Number.isInteger(data.seconds) && data.seconds >= 30 && data.seconds <= 180
          ? data.seconds
          : defaults.seconds,
      ...(typeof data.textModel === "string" &&
        /^[a-f0-9-]{36}$/.test(data.textModel) && { textModel: data.textModel }),
      imageModels: {
        character: savedModel(data.imageModels?.character),
        scene: savedModel(data.imageModels?.scene),
        prop: savedModel(data.imageModels?.prop),
      },
      videoModel: savedModel(data.videoModel),
      prompts: Object.fromEntries(
        promptSteps.flatMap((step) => {
          const choice = data.prompts?.[step];
          const skill =
            step !== "board" &&
            typeof choice === "string" &&
            choice.length <= 69 &&
            /^skill:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(choice);
          return savedModel(choice) || skill ? [[step, choice]] : [];
        }),
      ),
      imageParams: Object.fromEntries(
        Object.keys(emptyStartImages).map((slot) => [
          slot,
          Object.fromEntries(
            ["aspectRatio", "resolution"].flatMap((key) => {
              const value = data.imageParams?.[slot]?.[key];
              return typeof value === "string" && value.length <= 32 ? [[key, value]] : [];
            }),
          ),
        ]),
      ),
      genre: dramaStyles.genres.some((genre) => genre.key === data.genre) ? data.genre : "",
      styleKey:
        data.styleKey === "custom" ||
        dramaStyles.styles.some((style) => style.key === data.styleKey)
          ? data.styleKey
          : defaultDramaStyle,
      styleCustom:
        typeof data.styleCustom === "string" && Array.from(data.styleCustom).length <= 500
          ? data.styleCustom
          : "",
    };
  } catch {
    return defaults;
  }
}

export function saveDramaStartPrefs(prefs: StartPrefs) {
  try {
    localStorage.setItem(key, JSON.stringify(prefs));
  } catch {
    return;
  }
}
