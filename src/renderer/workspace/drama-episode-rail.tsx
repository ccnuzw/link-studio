import { type DramaDocument, dramaDeleteBlocked } from "@link-studio/core";
import { ChevronsDown, Lock, Plus, ScrollText, Users } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EpisodeDeleteDialog, type EpisodeDeletion, EpisodeMenu } from "./drama-episode-delete";
import type { Stage } from "./drama-workspace-nav";

export type DramaPage = number | "outline" | "characters";
export function EpisodeProgress({
  progress,
  queued,
  size = 12,
}: {
  progress: number;
  queued: boolean;
  size?: number;
}) {
  const stroke = size <= 12 ? 2 : 2.5,
    center = size / 2,
    radius = (size - stroke) / 2,
    length = 2 * radius * Math.PI;
  return (
    <svg
      aria-hidden="true"
      className="episode-progress"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
    >
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        stroke="var(--rail-muted)"
      />
      <motion.circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={length}
        stroke={
          queued ? "color-mix(in oklab,var(--rail-soft) 50%,transparent)" : "var(--rail-primary)"
        }
        initial={false}
        animate={{
          strokeDashoffset: length * (queued ? 0.75 : 1 - Math.max(0.04, progress / 100)),
        }}
        transition={{ type: "spring", stiffness: 500, damping: 38, mass: 0.8 }}
      />
    </svg>
  );
}
export function EpisodeRail({
  doc,
  page,
  stage = "script",
  pick,
  add,
  remove,
  extend,
  busy,
}: {
  doc: DramaDocument;
  page: DramaPage;
  stage?: Stage;
  pick: (page: DramaPage) => void;
  add: () => void;
  remove: (target: EpisodeDeletion) => Promise<void>;
  extend: () => void;
  busy: boolean;
}) {
  const [target, setTarget] = useState<EpisodeDeletion>();
  const blocked = dramaDeleteBlocked(doc);
  const scroll = useRef<HTMLDivElement>(null),
    [offset, setOffset] = useState(0),
    [height, setHeight] = useState(720);
  const [mobile, setMobile] = useState(() => matchMedia("(max-width:639px)").matches);
  useEffect(() => {
    const query = matchMedia("(max-width:639px)"),
      change = () => setMobile(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useLayoutEffect(() => {
    const box = scroll.current;
    if (!box) return;
    const update = () => setHeight(box.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(box);
    return () => observer.disconnect();
  }, [mobile]);
  const active = doc.episodes.findIndex((item) => item.episode_no === page);
  useLayoutEffect(() => {
    const box = scroll.current;
    if (!box || active < 0) return;
    if (active * 56 < box.scrollTop) box.scrollTop = active * 56;
    else if ((active + 1) * 56 > box.scrollTop + box.clientHeight)
      box.scrollTop = (active + 1) * 56 - box.clientHeight;
    setOffset(box.scrollTop);
  }, [active, mobile]);
  const first = Math.max(0, Math.floor(offset / 56) - 8),
    end = Math.ceil((offset + height) / 56) + 8;
  const documents = (
    [
      ["outline", "大纲", "故事大纲", ScrollText],
      ["characters", "人物", "人物传记", Users],
    ] as const
  ).map(([key, label, title, Icon]) => (
    <button type="button"
      key={key}
      title={title}
      aria-label={mobile ? label : title}
      aria-current={page === key}
      onClick={() => pick(key)}
    >
      {!mobile && <Icon size={16} />} {label}
    </button>
  ));
  if (mobile)
    return (
      <nav className="drama-episode-tabs" aria-label="分集">
        {stage === "script" && documents}
        {stage === "assets" && (
          <button type="button" aria-current={page === 0} onClick={() => pick(0)}>
            全集
          </button>
        )}
        {doc.episodes.map((item) => (
          <button type="button"
            key={item.episode_no}
            aria-current={page === item.episode_no}
            onClick={() => pick(item.episode_no)}
          >
            第{item.episode_no}集
          </button>
        ))}
      </nav>
    );
  return (
    <nav className="drama-episode-rail" aria-label="分集">
      <small>分集</small>
      {documents}
      <hr />
      <button type="button"
        disabled={stage !== "assets"}
        title={stage === "assets" ? "全集" : "仅资产管理可按全集筛选"}
        aria-current={stage === "assets" && page === 0}
        onClick={() => pick(0)}
      >
        全集
        <i className="episode-pips">
          <i data-state="on" />
        </i>
      </button>
      <div
        className="episode-rows"
        ref={scroll}
        onScroll={(event) => setOffset(event.currentTarget.scrollTop)}
      >
        <div style={{ height: doc.episodes.length * 56 }}>
          {doc.episodes.slice(first, end).map((item, index) => {
            const no = item.episode_no,
              label = `第 ${no} 集 · ${item.title}`;
            const activeJob = doc.jobs?.find(
              (job) => ["queued", "running"].includes(job.status) && job.episodes.includes(no),
            );
            const segments = doc.segments?.filter((segment) => segment.episode_no === no);
            const states = [
              (item.script_status ?? (item.script_md.trim() ? "ready" : "empty")) === "ready"
                ? "on"
                : "off",
              item.locked ? "on" : "off",
              item.storyboard_status === "generating"
                ? "run"
                : item.storyboard_status === "ready"
                  ? segments?.length && segments.every((segment) => segment.chosen_task_id)
                    ? "on"
                    : "part"
                  : "off",
              item.final_asset_id
                ? item.segment_version === item.final_segment_version
                  ? "on"
                  : "part"
                : "off",
            ];
            return (
              <EpisodeMenu
                key={no}
                blocked={blocked}
                select={() =>
                  setTarget({
                    no,
                    title: item.title,
                    segments: segments?.length ?? 0,
                    total: doc.episodes.length,
                    order: doc.episode_order ?? 0,
                  })
                }
                button={
                  <button
                    type="button"
                    style={{ top: (first + index) * 56 }}
                    title={label}
                    aria-label={label}
                    aria-current={page === no}
                    onClick={() => pick(no)}
                  >
                    <b>{String(no).padStart(2, "0")}</b>
                    <i className="episode-pips" aria-hidden="true">
                      {states.map((state, slot) => (
                        <i key={slot} data-state={state} />
                      ))}
                    </i>
                    {activeJob ? (
                      <EpisodeProgress
                        queued={activeJob.status === "queued"}
                        progress={activeJob.progress ?? 0}
                      />
                    ) : (
                      item.locked && <Lock className="episode-lock" size={10} />
                    )}
                  </button>
                }
              />
            );
          })}
        </div>
      </div>
      {doc.planning?.phase === "done" && doc.source && doc.planning.end < doc.source.total && (
        <button type="button" title="继续规划后面的章节" onClick={extend}>
          <ChevronsDown size={16} />
          继续规划
        </button>
      )}
      {stage === "script" && !!doc.episodes.length && (
        <button type="button"
          title={doc.planning?.phase === "running" ? "正在规划，完成或暂停后再新增" : "新增一集"}
          disabled={busy || doc.planning?.phase === "running"}
          onClick={add}
        >
          <Plus size={16} />
          新增一集
        </button>
      )}
      {target && (
        <EpisodeDeleteDialog
          target={target}
          blocked={blocked}
          close={() => setTarget(undefined)}
          remove={() => remove(target)}
        />
      )}
    </nav>
  );
}
