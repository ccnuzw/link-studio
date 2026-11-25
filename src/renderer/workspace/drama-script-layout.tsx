import { type DramaDocument, type DramaJobRecord, episodeScriptPhase } from "@link-studio/core";
import { Clock3, LoaderCircle, Lock } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { DramaFieldEditor, type FieldAccess } from "./drama-field-editor";
import { extractScenes, normalizeSceneTitle } from "./drama-scenes";

export function DramaScriptLayout({
  episode,
  order,
  access,
  scriptJob,
  children,
  sourceKind,
}: {
  episode: DramaDocument["episodes"][number];
  order: number;
  access: FieldAccess;
  scriptJob?: DramaJobRecord;
  children: ReactNode;
  sourceKind?: string;
}) {
  const paper = useRef<HTMLDivElement>(null);
  const scenes = extractScenes(episode.script_md);
  const phase = scriptJob && episodeScriptPhase(scriptJob, episode.episode_no);
  return (
    <div className="dp-script">
      <div ref={paper}>
        <header className="dp-paper-head">
          <h2>
            第 {episode.episode_no} 集 · {episode.title}
          </h2>
          {(episode.locked || (!phase && !episode.script_md)) && (
            <small data-locked={episode.locked}>
              {episode.locked && <Lock size={12} />} {episode.locked ? "已锁定" : "待写剧本"}
            </small>
          )}
        </header>
        {episode.locked && (
          <div className="dp-lock-banner">
            <Lock size={16} />
            这一集已经拆解资产，剧本已锁定。资产和分镜都以这一版为准。
          </div>
        )}
        {phase && scriptJob ? (
          <section className="dp-script-wait" role="status">
            {phase === "writing" ? (
              <LoaderCircle className="drama-reading-spinner" size={24} aria-hidden />
            ) : (
              <Clock3 size={24} aria-hidden />
            )}
            <strong>{phase === "writing" ? "正在生成这一集的剧本…" : "这一集正在排队"}</strong>
            <small>
              本批已完成 {scriptJob.done_episodes?.length ?? 0} / {scriptJob.episodes.length} 集
            </small>
            <progress
              aria-label="本批剧本进度"
              value={scriptJob.done_episodes?.length ?? 0}
              max={scriptJob.episodes.length}
            />
            <div className="dp-script-lines" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
          </section>
        ) : (
          children
        )}
      </div>
      <aside aria-label="本集资料">
        {!phase && episode.script_md && (
          <>
            <h3>本集场次</h3>
            {scenes.length ? (
              <ol>
                {scenes.map((title, index) => {
                  const occurrence = scenes
                    .slice(0, index)
                    .filter((scene) => scene === title).length;
                  return (
                    <li key={`${title}:${occurrence}`}>
                      <button
                        type="button"
                        className="dp-link"
                        onClick={() => {
                          const matches = Array.from(
                            paper.current?.querySelectorAll(".drama-paper-prose :is(h2,h3,h4,p)") ??
                              [],
                          ).filter((node) => normalizeSceneTitle(node.textContent ?? "") === title);
                          matches[occurrence]?.scrollIntoView({
                            block: "start",
                            behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
                              ? "auto"
                              : "smooth",
                          });
                        }}
                      >
                        {title}
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p>剧本里还没有场次标题</p>
            )}
          </>
        )}
        <h3>梗概</h3>
        <p>{episode.synopsis || "暂无梗概"}</p>
        {(
          [
            ["hook", "开场钩子"],
            ["cliffhanger", "结尾悬念"],
          ] as const
        ).map(([field, label]) => (
          <div key={field}>
            <header className="dp-paper-head">
              <h3>{label}</h3>
              {!episode.locked && !phase && (
                <DramaFieldEditor
                  {...access}
                  label={label}
                  target={{
                    field,
                    episode_no: episode.episode_no,
                    episodeOrder: order,
                    previous: episode[field] ?? "",
                    value: episode[field] ?? "",
                  }}
                />
              )}
            </header>
            <p>{episode[field] || "尚未填写"}</p>
          </div>
        ))}
        {episode.unit_from && (
          <>
            <h3>对应原文</h3>
            <p>
              第 {episode.unit_from}
              {episode.unit_to && episode.unit_to !== episode.unit_from
                ? `–${episode.unit_to}`
                : ""}{" "}
              {sourceKind === "chapter"
                ? "章"
                : sourceKind === "scene"
                  ? "场"
                  : sourceKind === "episode"
                    ? "集"
                    : "段"}
            </p>
          </>
        )}
      </aside>
    </div>
  );
}
