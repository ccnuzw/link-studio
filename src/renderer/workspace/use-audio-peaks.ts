import { useEffect, useState } from "react";
import { computePeaks } from "./audio-peaks";

type Waveform = { peaks: number[] | null; duration: number };
const cache = new Map<string, Waveform>();
const pending = new Map<string, Promise<Waveform>>();
let context: AudioContext | undefined;
let decoding = Promise.resolve();

async function decode(projectHandle: string, assetId: string, bars: number): Promise<Waveform> {
  const result = await window.desktop.projects.readAudioForWaveform({ projectHandle, assetId });
  if (!result.ok) return { peaks: null, duration: 0 };
  context ??= new AudioContext();
  const audio = await context.decodeAudioData(new Uint8Array(result.value.bytes).buffer);
  return { peaks: computePeaks(audio.getChannelData(0), bars), duration: audio.duration };
}

export function useAudioPeaks(projectHandle: string, assetId: string, src: string, bars: number) {
  const key = `${projectHandle}|${assetId}|${src}|${bars}`;
  const [loaded, setLoaded] = useState<{ key: string; wave: Waveform }>();
  useEffect(() => {
    if (cache.has(key)) return;
    let current = true;
    let task = pending.get(key);
    if (!task) {
      task = decoding
        .then(() => decode(projectHandle, assetId, bars))
        .catch(() => ({ peaks: null, duration: 0 }));
      pending.set(key, task);
      decoding = task.then((wave) => {
        pending.delete(key);
        if (cache.size >= 256) cache.delete(cache.keys().next().value!);
        cache.set(key, wave);
      });
    }
    void task.then((wave) => {
      if (current) setLoaded({ key, wave });
    });
    return () => {
      current = false;
    };
  }, [key, projectHandle, assetId, bars]);
  const wave = cache.get(key) ?? (loaded?.key === key ? loaded.wave : undefined);
  return { peaks: wave?.peaks, duration: wave?.duration ?? 0 };
}
