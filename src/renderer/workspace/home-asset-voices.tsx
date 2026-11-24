import { AudioLines, Copy, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { copySettingsText } from "../settings/copy-settings-text";
import type catalog from "../settings/official-voices.json";
import { BackdropDialog } from "./backdrop-dialog";
import { AssetFilter, AssetSearch, AssetToolbar } from "./home-asset-controls";
import { NodeAudioPlayer } from "./node-audio-player";

type Voice = (typeof catalog)[number];
const ages: Record<string, string> = {
  child: "儿童",
  teen: "少年",
  young: "青年",
  middle: "中年",
  older: "老年",
};
const groups = ["男孩", "女孩", "男生", "女生"];
const voiceName = (voice: Voice) =>
  voice.name.replace(/^(Child|Teen|Young|Middle-aged|Older) - (Male|Female) - /, "").trim() ||
  "音色";
const groupOf = (voice: Voice) =>
  groups[
    (voice.age === "child" || voice.age === "teen" ? 0 : 2) + (voice.gender === "female" ? 1 : 0)
  ]!;
const localFile = (name: string) => `./official-voices/${name}`;
export function AudioPreview({
  name,
  src,
  voice,
  close,
}: {
  name: string;
  src: string;
  voice?: Voice;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [playing, setPlaying] = useState(false),
    [notice, setNotice] = useState("");
  useLayoutEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <BackdropDialog
      ref={dialog}
      className="home-audio-dialog"
      aria-label={name}
      dismiss={close}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="home-audio-body">
        {voice && <img className="home-audio-blur" alt="" src={localFile(voice.avatar)} />}
        <button type="button" className="home-audio-close" aria-label="关闭" onClick={close}>
          <X size={16} />
        </button>
        <span className="home-audio-avatar" data-playing={playing}>
          {voice ? <img src={localFile(voice.avatar)} alt="" /> : <AudioLines size={48} />}
        </span>
        <h2>{name}</h2>
        {voice && (
          <div className="home-audio-tags">
            <span>{voice.lang === "zh" ? "中文" : "English"}</span>
            <span>{groupOf(voice)}</span>
          </div>
        )}
        <div className="home-audio-deck">
          <NodeAudioPlayer
            src={src}
            assetId={src}
            autoPlay
            onPlayingChange={setPlaying}
            waveform={voice?.wave.match(/../g)?.map((byte) => parseInt(byte, 16) / 255)}
          />
        </div>
        {voice && (
          <button
            className="home-voice-copy"
            type="button"
            aria-label="复制音色地址"
            title="复制音色地址"
            onClick={() =>
              void copySettingsText(voice.url).then(
                () => setNotice("已复制音色地址"),
                () => setNotice("复制失败"),
              )
            }
          >
            <Copy size={14} />
          </button>
        )}
        {notice && <small role="status">{notice}</small>}
      </div>
    </BackdropDialog>
  );
}
export function VoiceLibrary() {
  const [voices, setVoices] = useState<Voice[]>(),
    [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0),
    [query, setQuery] = useState(""),
    [lang, setLang] = useState(""),
    [group, setGroup] = useState(""),
    [preview, setPreview] = useState<Voice>();
  useEffect(() => {
    let active = true;
    setFailed(false);
    void import("../settings/official-voices.json").then(
      (catalog) => {
        if (active) setVoices(catalog.default);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [retry]);
  const term = query.trim().toLowerCase(),
    matches = voices?.filter(
      (voice) =>
        (!lang || voice.lang === lang) &&
        (!group || groupOf(voice) === group) &&
        [voice.name, voice.lang === "zh" ? "中文" : "英文 English", groupOf(voice), ages[voice.age]]
          .join(" ")
          .toLowerCase()
          .includes(term),
    );
  return (
    <>
      <AssetToolbar>
        <AssetFilter
          label="语言"
          value={lang}
          change={setLang}
          options={[
            { value: "", label: "全部" },
            { value: "zh", label: "中文" },
            { value: "en", label: "English" },
          ]}
        />
        <AssetFilter
          label="人群"
          value={group}
          change={setGroup}
          options={[
            { value: "", label: "全部" },
            ...groups.map((value) => ({ value, label: value })),
          ]}
        />
        <AssetSearch label="搜索音色名称" value={query} change={setQuery} />
      </AssetToolbar>
      {failed ? (
        <p role="alert">
          音色库加载失败{" "}
          <button type="button" onClick={() => setRetry(retry + 1)}>
            重试
          </button>
        </p>
      ) : !matches ? (
        <p role="status">正在加载…</p>
      ) : matches.length ? (
        <div className="home-voice-grid">
          {matches.map((voice) => (
            <button
              key={voice.url}
              type="button"
              className="home-voice-card"
              aria-label={voiceName(voice)}
              onClick={() => setPreview(voice)}
            >
              <span>
                <img src={localFile(voice.avatar)} loading="lazy" alt="" />
                <small>{groupOf(voice)}</small>
              </span>
              <strong>{voiceName(voice)}</strong>
            </button>
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
          src={localFile(preview.url.split("/").at(-1)!)}
          voice={preview}
          close={() => setPreview(undefined)}
        />
      )}
    </>
  );
}
