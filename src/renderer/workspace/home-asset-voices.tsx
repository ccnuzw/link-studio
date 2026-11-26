import { useState } from "react";
import { AudioPreview } from "./audio-preview";
import { AssetFilter, AssetSearch, AssetToolbar } from "./home-asset-controls";
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

export function VoiceLibrary() {
  const [query, setQuery] = useState(""),
    [lang, setLang] = useState(""),
    [group, setGroup] = useState(""),
    [preview, setPreview] = useState<OfficialVoice>();
  const term = query.trim();
  const matches = matchOfficialVoices(term, lang, group);
  return (
    <>
      <AssetToolbar>
        <AssetFilter
          label="语言"
          value={lang}
          change={setLang}
          options={Object.entries(voiceLanguages).map(([value, label]) => ({ value, label }))}
        />
        <AssetFilter
          label="人群"
          value={group}
          change={setGroup}
          options={Object.entries(voiceGroups).map(([value, label]) => ({ value, label }))}
        />
        <AssetSearch label="搜索音色名称" value={query} change={setQuery} />
      </AssetToolbar>
      {matches.length ? (
        <div className="home-voice-grid">
          {matches.map((voice) => (
            <OfficialVoiceCard key={voice.url} voice={voice} preview={() => setPreview(voice)} />
          ))}
        </div>
      ) : (
        <div className="global-empty">
          <strong>{term ? `没有找到“${query.trim()}”` : "这个分类下还没有音色"}</strong>
          <p>换个关键词，或换成「全部」再看看</p>
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
