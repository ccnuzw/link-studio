import { useState } from "react";
import voices from "../settings/official-voices.json";

export type VoiceChoice = { assetId: string; displayName: string; official: string };

export function CanvasVoices({
  query,
  selected,
  full,
  toggle,
}: {
  query: string;
  selected: { assetId: string }[];
  full: boolean;
  toggle: (voice: VoiceChoice) => void;
}) {
  const [preview, setPreview] = useState("");
  const matches = voices.filter((voice) =>
    `${voice.name} ${voice.lang}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <div className="canvas-voices">
      {preview && (
        // biome-ignore lint/a11y/useMediaCaption: The catalog provides a voice sample but no transcript.
        <audio
          controls
          autoPlay
          key={preview}
          src={`./official-voices/${preview}`}
          aria-label="音色试听"
        />
      )}
      {!matches.length && <p>没有匹配的音色</p>}
      {matches.map((voice) => {
        const file = voice.url.split("/").at(-1)!;
        const checked = selected.some((item) => item.assetId === voice.url);
        return (
          <div key={voice.url}>
            <button
              type="button"
              disabled={!checked && full}
              aria-pressed={checked}
              onClick={() =>
                toggle({ assetId: voice.url, official: file, displayName: voice.name })
              }
            >
              {voice.name}
            </button>
            <button
              type="button"
              aria-label={`试听 ${voice.name}`}
              onClick={() => setPreview(file)}
            >
              试听
            </button>
          </div>
        );
      })}
    </div>
  );
}
