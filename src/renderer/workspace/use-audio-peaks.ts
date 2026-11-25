import { requirePresent } from "@link-studio/core";
import { useEffect, useState } from "react";
import { computePeaks } from "./audio-peaks";

type Waveform = { peaks: number[] | null; duration: number };
const cache = new Map<string, Waveform>();
const pending = new Map<string, Promise<Waveform>>();
let context: AudioContext | undefined;
let decoding = Promise.resolve();

async function decode(
  projectHandle: string | undefined,
  assetId: string,
  bars: number,
  src: string,
): Promise<Waveform> {
  const library = /^link-media:\/\/global-assets\/(history|personal)\/([\da-f-]{36})$/.exec(src);
  if (!projectHandle && !library) return { peaks: null, duration: 0 };
  const result = await window.desktop.projects.readAudioForWaveform(
    projectHandle
      ? { projectHandle, assetId }
      : {
          library: requirePresent(library, "library")[1] === "history" ? "history" : "personal",
          assetId: requirePresent(requirePresent(library, "library")[2], "library[2]"),
        },
  );
  if (!result.ok) return { peaks: null, duration: 0 };
  context ??= new AudioContext();
  const audio = await context.decodeAudioData(new Uint8Array(result.value.bytes).buffer);
  return { peaks: computePeaks(audio.getChannelData(0), bars), duration: audio.duration };
}

export function useAudioPeaks(
  projectHandle: string | undefined,
  assetId: string,
  src: string,
  bars: number,
) {
  const key = `${projectHandle}|${assetId}|${src}|${bars}`;
  const [loaded, setLoaded] = useState<{ key: string; wave: Waveform }>();
  useEffect(() => {
    if ((!projectHandle && !src.startsWith("link-media://global-assets/")) || cache.has(key))
      return;
    let current = true;
    let task = pending.get(key);
    if (!task) {
      task = decoding
        .then(() => decode(projectHandle, assetId, bars, src))
        .catch(() => ({ peaks: null, duration: 0 }));
      pending.set(key, task);
      decoding = task.then((wave) => {
        pending.delete(key);
        if (cache.size >= 256)
          cache.delete(requirePresent(cache.keys().next().value, "cache.keys().next().value"));
        cache.set(key, wave);
      });
    }
    void task.then((wave) => {
      if (current) setLoaded({ key, wave });
    });
    return () => {
      current = false;
    };
  }, [key, projectHandle, assetId, bars, src]);
  const wave = cache.get(key) ?? (loaded?.key === key ? loaded.wave : undefined);
  return { peaks: wave?.peaks, duration: wave?.duration ?? 0 };
}
