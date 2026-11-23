import type { GenerationInput } from "./generation.ts";
import type { ModelConfig } from "./model-config.ts";
import { validCustomName, validCustomValue } from "./model-config.ts";

export function providerInput(
  kind: string,
  adapter: string,
  input: Partial<GenerationInput>,
  config?: ModelConfig,
  references?: { images: string[]; audios: string[]; videos: string[] },
) {
  return {
    prompt: input.prompt,
    ...(kind === "text" && { system: config?.systemPrompt, max_tokens: config?.maxOutputTokens }),
    op:
      input.op ??
      (kind === "image"
        ? references?.images.length ||
          (config?.modes?.includes("i2i") && !config.modes.includes("t2i"))
          ? "i2i"
          : "t2i"
        : undefined),
    size: input.size ?? (adapter === "agnes-image" ? input.resolution : undefined),
    duration: input.duration,
    count: input.count,
    n: input.count,
    quality: input.quality,
    aspect_ratio: input.aspectRatio,
    resolution: adapter === "agnes-video" ? input.resolution?.toUpperCase() : input.resolution,
    generate_audio: input.generateAudio,
    seed: input.seed,
    negative_prompt: input.negativePrompt,
    make_instrumental: input.makeInstrumental,
    format: input.audioFormat,
    speaker: input.speaker,
    sample_rate: input.sampleRate,
    speech_rate: input.speechRate,
    loudness_rate: input.loudnessRate,
    pitch_rate: input.pitchRate,
    video_action: input.videoAction,
    ...Object.fromEntries(
      Object.entries(input.customParams ?? {}).filter(([name, value]) => {
        const field = config?.customParams?.[name];
        return validCustomName(name) && field && validCustomValue(field, value);
      }),
    ),
    ...references,
  };
}
