import { AudioLines } from "lucide-react";
import { type RefObject, useState } from "react";
import { AudioPreview } from "./audio-preview";
import {
  matchOfficialVoices,
  type OfficialVoice,
  OfficialVoiceCard,
  voiceAudioFile,
  voiceGroups,
  voiceLanguages,
  voiceLocalFile,
  voiceName,
} from "./official-voice-card";
import { PickerFilter } from "./picker-filter";
import "./canvas-voices.css";

export type VoiceChoice = {
  assetId: string;
  displayName: string;
  official: string;
  avatar: string;
};

export function CanvasVoices({
  query,
  selected,
  full,
  toggle,
  container,
}: {
  query: string;
  selected: { assetId: string }[];
  full: boolean;
  toggle: (voice: VoiceChoice) => void;
  container: RefObject<HTMLDialogElement | null>;
}) {
  const [preview, setPreview] = useState<OfficialVoice>();
  const [lang, setLang] = useState("");
  const [group, setGroup] = useState("");
  const matches = matchOfficialVoices(query, lang, group);
  return (
    <>
      <div className="canvas-voice-filters">
        <PickerFilter
          label="语言"
          options={voiceLanguages}
          value={lang}
          change={setLang}
          container={container}
        />
        <PickerFilter
          label="人群"
          options={voiceGroups}
          value={group}
          change={setGroup}
          container={container}
        />
        <span aria-live="polite">{matches.length} 个音色</span>
      </div>
      {matches.length ? (
        <section className="canvas-voice-grid" aria-label="官方音色">
          {matches.map((voice) => {
            const checked = selected.some((item) => item.assetId === voice.url);
            return (
              <OfficialVoiceCard
                key={voice.url}
                voice={voice}
                preview={() => setPreview(voice)}
                selection={{
                  checked,
                  disabled: !checked && full,
                  toggle: () =>
                    toggle({
                      assetId: voice.url,
                      official: voiceAudioFile(voice),
                      displayName: voice.name,
                      avatar: voiceLocalFile(voice.avatar),
                    }),
                }}
              />
            );
          })}
        </section>
      ) : (
        <div className="canvas-voice-empty">
          <AudioLines size={24} aria-hidden="true" />
          <strong>没有匹配的音色</strong>
          <p>试试其他关键词或筛选条件。</p>
        </div>
      )}
      {preview && (
        <AudioPreview
          name={voiceName(preview)}
          src={voiceLocalFile(voiceAudioFile(preview))}
          voice={preview}
          close={() => setPreview(undefined)}
        />
      )}
    </>
  );
}
