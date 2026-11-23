import { Value } from "@sinclair/typebox/value";
import type { CreativeData } from "./canvas.ts";
import { GenerationParameters } from "./generation-parameters.ts";

const names = {
  size: "size",
  duration: "duration",
  count: "count",
  quality: "quality",
  aspectRatio: "aspect_ratio",
  resolution: "resolution",
  generateAudio: "generate_audio",
  seed: "seed",
  negativePrompt: "negative_prompt",
  makeInstrumental: "make_instrumental",
  audioFormat: "audio_format",
  speaker: "speaker",
  sampleRate: "sample_rate",
  speechRate: "speech_rate",
  loudnessRate: "loudness_rate",
  pitchRate: "pitch_rate",
  videoAction: "video_action",
} satisfies Record<Exclude<keyof GenerationParameters, "customParams">, string>;

const fields = Object.keys(names) as (keyof typeof names)[];

export function canvasParameterKey(name: string) {
  return fields.find((key) => names[key] === name || key === name);
}

export function importVideoCanvasParameters(params: Record<string, unknown>): GenerationParameters {
  return Object.fromEntries(
    fields.flatMap((key) => {
      const value = params[names[key]];
      return Value.Check(GenerationParameters.properties[key], value) ? [[key, value]] : [];
    }),
  );
}

export function canvasVideoDuration(data: Pick<CreativeData, "generation" | "videoDuration">) {
  const draft = data.generation;
  if (draft?.durationInput === undefined && draft?.params?.duration === undefined)
    return data.videoDuration;
  const raw = draft?.durationInput;
  const seconds =
    raw === undefined ? draft?.params?.duration : /^\d+$/.test(raw) ? Number(raw) : undefined;
  return Value.Check(GenerationParameters.properties.duration, seconds) ? seconds : undefined;
}

export function exportVideoCanvasParameters(data: CreativeData) {
  const draft = data.generation;
  const params = { ...draft?.params };
  if (draft?.sizeInput !== undefined) params.size = draft.sizeInput;
  delete params.duration;
  const result: Record<string, unknown> = Object.fromEntries(
    fields.flatMap((key) => {
      const value = params[key];
      return Value.Check(GenerationParameters.properties[key], value) ? [[names[key], value]] : [];
    }),
  );
  const seconds = canvasVideoDuration(data);
  if (seconds !== undefined) result.duration = seconds;
  return result;
}
