import { AudioLines, Copy, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { copySettingsText } from "../settings/copy-settings-text";
import { BackdropDialog } from "./backdrop-dialog";
import { NodeAudioPlayer } from "./node-audio-player";
import { type OfficialVoice, voiceGroup, voiceLocalFile } from "./official-voice-card";
import "./audio-preview.css";

export function AudioPreview({
  name,
  src,
  voice,
  close,
}: {
  name: string;
  src: string;
  voice?: OfficialVoice;
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
      isolateClicks
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <div className="home-audio-body">
        {voice && <img className="home-audio-blur" alt="" src={voiceLocalFile(voice.avatar)} />}
        <button type="button" className="home-audio-close" aria-label="关闭" onClick={close}>
          <X size={16} />
        </button>
        <span className="home-audio-avatar" data-playing={playing}>
          {voice ? <img src={voiceLocalFile(voice.avatar)} alt="" /> : <AudioLines size={48} />}
        </span>
        <h2>{name}</h2>
        {voice && (
          <div className="home-audio-tags">
            <span>{voice.lang === "zh" ? "中文" : "English"}</span>
            <span>{voiceGroup(voice)}</span>
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
