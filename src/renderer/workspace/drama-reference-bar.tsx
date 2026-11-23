import { AudioLines, Box, Grid2x2, Image as ImageIcon, User, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { dramaVideoInput } from "./drama-video-input";

type Plan = ReturnType<typeof dramaVideoInput>;

function ReferenceIcon({
  item,
  projectHandle,
}: {
  item: { kind: string; thumbnail?: string };
  projectHandle: string;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let live = true;
    setUrl("");
    if (item.thumbnail)
      void window.desktop.projects
        .getAssetPreview({ projectHandle, assetId: item.thumbnail })
        .then((result) => {
          if (live && result.ok) setUrl(result.value.url);
        });
    return () => {
      live = false;
    };
  }, [item.thumbnail, projectHandle]);
  const Icon =
    item.kind === "board"
      ? Grid2x2
      : item.kind === "audio"
        ? AudioLines
        : item.kind === "character"
          ? User
          : item.kind === "prop"
            ? Box
            : ImageIcon;
  return (
    <i aria-hidden="true">
      {url ? <img src={url} alt="" draggable={false} /> : <Icon size={14} />}
    </i>
  );
}

export function DramaReferenceBar({
  plan,
  projectHandle,
  setBoardOff,
}: {
  plan: Plan;
  projectHandle: string;
  setBoardOff: (off: boolean) => void;
}) {
  const player = useRef<HTMLAudioElement | null>(null);
  const request = useRef(0);
  const [problem, setProblem] = useState("");
  useEffect(
    () => () => {
      request.current++;
      player.current?.pause();
    },
    [projectHandle],
  );
  async function listen(assetId: string) {
    const sequence = ++request.current;
    player.current?.pause();
    setProblem("");
    try {
      const result = await window.desktop.projects.getAssetPreview({ projectHandle, assetId });
      if (sequence !== request.current) return;
      if (!result.ok) throw Error(result.error.message);
      const audio = new Audio(result.value.url);
      player.current = audio;
      await audio.play();
    } catch {
      if (sequence === request.current) setProblem("音色试听失败");
    }
  }
  return (
    <section className="drama-ref-bar" aria-label="参考素材">
      <header>
        参考素材{" "}
        {plan.counts.imageMax > 0 && (
          <small>
            图 {plan.counts.images}/{plan.counts.imageMax}
          </small>
        )}
        {plan.counts.audios > 0 && (
          <small>
            音频 {plan.counts.audios}/{plan.counts.audioMax}
          </small>
        )}
      </header>
      <div>
        {plan.board.state === "none" ? (
          <span className="drama-board-empty">
            <Grid2x2 size={14} />
            未引用故事板
          </span>
        ) : (
          <span
            className="drama-board-chip"
            data-state={plan.board.state}
            title={plan.board.reason || undefined}
          >
            <ReferenceIcon
              item={{ kind: "board", thumbnail: plan.board.thumbnail }}
              projectHandle={projectHandle}
            />
            故事板
            {plan.board.state === "stale" && <small>已过期</small>}
            {plan.board.state === "unsupported" && <small>未带入</small>}
            {plan.board.state === "off" ? (
              <button type="button" onClick={() => setBoardOff(false)}>
                带上
              </button>
            ) : (
              <button
                type="button"
                aria-label="本次不带故事板"
                title="本次不带故事板"
                onClick={() => setBoardOff(true)}
              >
                <X size={12} />
              </button>
            )}
          </span>
        )}
        {plan.refs.map((item) => (
          <Fragment key={item.id}>
            <span
              role="img"
              aria-label={`${item.label} · ${item.state}`}
              data-dead={item.state === "已失效"}
            >
              <ReferenceIcon item={item} projectHandle={projectHandle} />
              <span>{item.label}</span>
              {item.state === "参考音频" ? (
                <AudioLines size={14} aria-label="参考音频" />
              ) : (
                item.state !== "参考图" && <small>{item.state}</small>
              )}
              {item.truncated && <small>部分未带入</small>}
              {item.voice && !item.voiceId && <small>{item.voice}</small>}
            </span>
            {item.voiceId && (
              <button
                type="button"
                aria-label={`试听${item.label} · 音色`}
                title="点一下试听音色"
                onClick={() => void listen(item.voiceId!)}
              >
                <i aria-hidden="true">
                  <AudioLines size={14} />
                </i>
                {item.label} · 音色
              </button>
            )}
          </Fragment>
        ))}
      </div>
      {problem && <p role="alert">{problem}</p>}
    </section>
  );
}
