import { requirePresent } from "@link-studio/core";
import { Check, Play } from "lucide-react";
import catalog from "../settings/official-voices.json";
import "./official-voice-card.css";

export type OfficialVoice = (typeof catalog)[number];
export const voiceLanguages = { "": "全部", zh: "中文", en: "English" };
export const voiceGroups = { "": "全部", 男孩: "男孩", 女孩: "女孩", 男生: "男生", 女生: "女生" };
const ages: Record<string, string> = {
  child: "儿童",
  teen: "少年",
  young: "青年",
  middle: "中年",
  older: "老年",
};

export const voiceName = (voice: OfficialVoice) =>
  voice.name.replace(/^(Child|Teen|Young|Middle-aged|Older) - (Male|Female) - /, "").trim() ||
  "音色";

export function voiceGroup(voice: OfficialVoice) {
  const minor = voice.age === "child" || voice.age === "teen";
  if (voice.gender === "female") return minor ? "女孩" : "女生";
  return minor ? "男孩" : "男生";
}

export const voiceLocalFile = (name: string) => `./official-voices/${name}`;
export const voiceAudioFile = (voice: OfficialVoice) =>
  requirePresent(voice.url.split("/").at(-1), 'voice.url.split("/").at(-1)');

export function matchOfficialVoices(query: string, lang: string, group: string) {
  const term = query.trim().toLowerCase();
  return catalog.filter(
    (voice) =>
      (!lang || voice.lang === lang) &&
      (!group || voiceGroup(voice) === group) &&
      [
        voice.name,
        voice.lang,
        voice.lang === "zh" ? "中文" : "英文 English",
        voiceGroup(voice),
        ages[voice.age],
      ]
        .join(" ")
        .toLowerCase()
        .includes(term),
  );
}

export function OfficialVoiceCard({
  voice,
  preview,
  selection,
}: {
  voice: OfficialVoice;
  preview: () => void;
  selection?: { checked: boolean; disabled: boolean; toggle: () => void };
}) {
  const name = voiceName(voice);
  return (
    <article
      className="official-voice-card"
      data-selectable={!!selection || undefined}
      data-selected={selection?.checked || undefined}
    >
      <button
        type="button"
        className="official-voice-hit"
        aria-label={name}
        aria-pressed={selection?.checked}
        disabled={selection?.disabled}
        onClick={selection?.toggle ?? preview}
      >
        <span className="official-voice-portrait">
          <img src={voiceLocalFile(voice.avatar)} loading="lazy" alt="" />
          <small>{voiceGroup(voice)}</small>
          {selection && (
            <span className="official-voice-check" aria-hidden="true">
              {selection.checked && <Check size={13} strokeWidth={3} />}
            </span>
          )}
        </span>
        <strong title={name}>{name}</strong>
      </button>
      {selection && (
        <button
          type="button"
          className="official-voice-preview"
          aria-label={`试听 ${name}`}
          title={`试听 ${name}`}
          onClick={preview}
        >
          <Play size={14} aria-hidden="true" />
        </button>
      )}
    </article>
  );
}
