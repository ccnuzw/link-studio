import {
  type DramaDocument,
  dramaAssetMeta,
  dramaBoardMeta,
  requirePresent,
} from "@link-studio/core";
import { Clapperboard, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocalPreview } from "./character-card-body";
import type { DramaAssetEditor } from "./drama-asset-browser";
import { DramaOverviewNext } from "./drama-overview-next";
import { boardSourceHash } from "./drama-segment-video";
import { DramaEmptyState } from "./drama-studio-status";
import type { Stage } from "./drama-workspace-nav";

type Snapshot = { freshBoards: Set<string> };

export function useStageCanvas(
  projectHandle: string,
  doc?: DramaDocument | null,
  canvasRevision?: number,
) {
  const [snapshot, setSnapshot] = useState<Snapshot>(),
    [problem, setProblem] = useState(""),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    if (!doc) return;
    async function load() {
      const [graph, assets] = await Promise.all([
        window.desktop.projects.getCanvas({ projectHandle }),
        window.desktop.projects.listAssets({ projectHandle }),
      ]);
      if (!graph.ok || !assets.ok) throw Error("资产画布加载失败，请重试");
      const ready = new Set(
        assets.value.assets
          .filter((item) => item.availability === "ready" && item.mediaType === "image")
          .map((item) => item.assetId),
      );
      const boards = new Map<string, string>();
      for (const node of graph.value.canvas.nodes) {
        if (node.type !== "creative" || !node.data.assetId || !ready.has(node.data.assetId))
          continue;
        const board = dramaBoardMeta(node.data);
        if (board) boards.set(board.segmentId, board.sourceHash);
      }
      const freshBoards = new Set<string>();
      await Promise.all(
        (doc?.segments ?? [])
          .filter((item) => boards.has(item.id))
          .map(async (item) => {
            if ((await boardSourceHash(item.prompt)) === boards.get(item.id))
              freshBoards.add(item.id);
          }),
      );
      if (live) {
        setSnapshot({ freshBoards });
        setProblem("");
      }
    }
    void load().catch(() => {
      if (live) setProblem("资产画布加载失败，请重试");
    });
    return () => {
      live = false;
    };
  }, [projectHandle, doc, retry, canvasRevision]);
  return { snapshot, problem, reload: () => setRetry((value) => value + 1) };
}

export function stageHints(doc: DramaDocument, fresh?: Set<string>) {
  const hints: Partial<Record<Stage, "run" | "todo">> = {},
    jobs = doc.jobs?.filter((item) => item.status === "running" || item.status === "queued") ?? [];
  const ready = (item: DramaDocument["episodes"][number]) =>
    (item.script_status ?? (item.script_md.trim() ? "ready" : "empty")) === "ready";
  if (doc.planning?.phase === "running" || jobs.some((job) => job.step === "scripts"))
    hints.script = "run";
  else if (doc.episodes.some((item) => !ready(item))) hints.script = "todo";
  if (jobs.some((job) => job.step === "breakdown" || job.step === "asset_prompts"))
    hints.assets = "run";
  else if (doc.episodes.some((item) => ready(item) && !item.locked)) hints.assets = "todo";
  if (
    jobs.some((job) => job.step === "storyboard") ||
    doc.episodes.some((item) => item.storyboard_status === "generating")
  )
    hints.studio = "run";
  else if (fresh) {
    const planned = new Set(
      doc.episodes
        .filter((item) => item.storyboard_status === "ready")
        .map((item) => item.episode_no),
    );
    if (doc.segments?.some((item) => planned.has(item.episode_no) && !fresh.has(item.id)))
      hints.studio = "todo";
  }
  if (jobs.some((job) => job.step === "compose")) hints.final = "run";
  return hints;
}

export function StageOverview({
  editor,
  projectHandle,
  doc,
  go,
  openOutline,
  openBreakdown,
  fresh,
}: {
  editor: DramaAssetEditor;
  projectHandle: string;
  doc: DramaDocument;
  go: (stage: Stage, no: number) => void;
  openOutline: () => void;
  openBreakdown: () => void;
  fresh?: Set<string>;
}) {
  const rows = useMemo(() => {
    const counts = new Map<number, { total: number; done: number; boards: number }>();
    for (const segment of doc.segments ?? []) {
      const count = counts.get(segment.episode_no) ?? { total: 0, done: 0, boards: 0 };
      count.total++;
      if (segment.chosen_task_id) count.done++;
      if (fresh?.has(segment.id)) count.boards++;
      counts.set(segment.episode_no, count);
    }
    return doc.episodes.map((item) => {
      const { total, done, boards } = counts.get(item.episode_no) ?? {
        total: 0,
        done: 0,
        boards: 0,
      };
      const script =
        (item.script_status ?? (item.script_md.trim() ? "ready" : "empty")) === "ready";
      const shots = item.storyboard_status === "ready",
        hasShots = shots && total > 0;
      const stale = (item.segment_version ?? 0) !== (item.final_segment_version ?? 0);
      const next: Stage | null =
        !script || !item.locked
          ? "script"
          : !hasShots || done < total
            ? "studio"
            : !item.final_asset_id || stale
              ? "final"
              : null;
      const units =
        Number(script) +
        Number(!!item.locked) +
        Number(shots) +
        (hasShots ? done / total : 0) +
        Number(!!item.final_asset_id);
      const cells: [string, Stage, boolean, string][] = [
        ["剧本", "script", true, script ? "✓" : "—"],
        [
          "拆解",
          item.locked ? "assets" : "script",
          !!item.locked || script,
          item.locked ? "✓" : "待拆解",
        ],
        [
          "分镜",
          "studio",
          !!item.locked || shots || item.storyboard_status === "generating",
          shots ? "✓" : item.storyboard_status === "generating" ? "进行中" : "待生成",
        ],
        ["故事板", "studio", hasShots, `${boards}/${total}`],
        ["片段", "studio", hasShots, `${done}/${total}`],
        [
          "成片",
          "final",
          hasShots || !!item.final_asset_id,
          item.final_asset_id ? (stale ? "已过期" : "✓") : "未合成",
        ],
      ];
      return { no: item.episode_no, title: item.title, next, units, cells };
    });
  }, [doc, fresh]);
  const nextIndex = rows.findIndex((row) => row.next),
    resume = rows[nextIndex];
  const [index, setIndex] = useState(() => Math.floor(Math.max(0, nextIndex) / 10));
  const pages = Math.max(1, Math.ceil(rows.length / 10)),
    page = Math.min(index, pages - 1);
  const percent = rows.length
    ? Math.round((rows.reduce((sum, row) => sum + row.units, 0) * 20) / rows.length)
    : 0;
  return (
    <section aria-label="总览" className="dp-overview">
      <div className="dp-hero">
        <div>
          <small>
            {doc.ratio || "比例未定"} · {doc.episode_seconds ?? 90} 秒 / 集
          </small>
          <h2>{doc.title}</h2>
          {doc.outline_md && (
            <p>
              {Array.from(
                doc.outline_md
                  .replace(/[#*_>`]/g, "")
                  .trim()
                  .replace(/\s+/g, " "),
              )
                .slice(0, 110)
                .join("")}{" "}
              <button type="button" className="dp-link" onClick={openOutline}>
                读完整大纲 →
              </button>
            </p>
          )}
          <div className="dp-chips">
            <span>{rows.length} 集</span>
            <span>
              {
                editor.graph.nodes.filter(
                  (node) => node.type === "creative" && !dramaBoardMeta(node.data),
                ).length
              }{" "}
              个资产
            </span>
          </div>
          <div className="dp-tools">
            {resume?.next ? (
              <button
                className="dp-action dp-primary"
                type="button"
                onClick={() => go(requirePresent(resume.next, "resume.next"), resume.no)}
              >
                <Play size={15} />
                继续制作第 {resume.no} 集
              </button>
            ) : (
              rows[0] && (
                <button
                  className="dp-action dp-primary"
                  type="button"
                  onClick={() => go("final", requirePresent(rows[0], "rows[0]").no)}
                >
                  全部完成，查看成片
                </button>
              )
            )}
            {resume && (
              <span>
                {resume.next === "script"
                  ? doc.episodes[nextIndex]?.locked
                    ? "剧本"
                    : doc.episodes[nextIndex]?.script_md
                      ? "剧本 · 还没有拆解资产"
                      : "剧本 · 还没有写好"
                  : resume.next === "studio"
                    ? "片场 · 继续制作片段"
                    : "成片 · 待合成"}
              </span>
            )}
          </div>
        </div>
        <div className="dp-posters" aria-hidden="true">
          <Clapperboard size={72} strokeWidth={1} />
          {editor.graph.nodes
            .flatMap((node) =>
              node.type === "creative" &&
              (node.data.character || dramaAssetMeta(node.data)?.type === "character") &&
              node.data.assetId
                ? [{ id: node.id, assetId: node.data.assetId }]
                : [],
            )
            .slice(0, 3)
            .map(({ id, assetId }) => (
              <Portrait key={id} id={assetId} handle={projectHandle} />
            ))}
        </div>
      </div>
      <div className="drama-overview-details">
        <div>
          <h2>制作进度</h2>
          <table aria-label="分集与工序进度">
            <thead>
              <tr>
                {["分集", "剧本", "拆解", "分镜", "故事板", "片段", "成片"].map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(page * 10, page * 10 + 10).map(({ no, title, cells }) => (
                <tr key={no}>
                  <th>
                    <button type="button" onClick={() => go("script", no)}>
                      {String(no).padStart(2, "0")} {title}
                    </button>
                  </th>
                  {cells.map(([label, target, enabled, text]) => (
                    <td key={label}>
                      <button
                        type="button"
                        disabled={!enabled}
                        data-state={matrixTone(enabled, text)}
                        aria-label={`第 ${no} 集 ${label}${enabled ? "" : "，需要先完成前一道工序"}`}
                        onClick={() => go(target, no)}
                      >
                        {enabled ? text : ""}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && (
            <DramaEmptyState
              compact
              title="还没有分集"
              description="完成研读后，分集会出现在这里。"
            />
          )}
          {pages > 1 && (
            <nav aria-label="进度表分页">
              <button type="button" disabled={!page} onClick={() => setIndex(page - 1)}>
                上一页
              </button>{" "}
              <small>
                第 {page * 10 + 1}–{Math.min(rows.length, (page + 1) * 10)} 集
              </small>
              {[...new Set([0, page - 1, page, page + 1, pages - 1])]
                .filter((number) => number >= 0 && number < pages)
                .sort((left, right) => left - right)
                .map((number, position, numbers) => (
                  <span key={number}>
                    {position > 0 &&
                      number - requirePresent(numbers[position - 1], "numbers[position - 1]") > 1 &&
                      "…"}
                    <button
                      type="button"
                      aria-current={number === page ? "page" : undefined}
                      aria-label={`第 ${number + 1} 页`}
                      onClick={() => setIndex(number)}
                    >
                      {number + 1}
                    </button>
                  </span>
                ))}
              <button
                type="button"
                disabled={page + 1 === pages}
                onClick={() => setIndex(page + 1)}
              >
                下一页
              </button>
            </nav>
          )}
        </div>
        <div>
          <h2>整体完成度</h2>
          <div className="dp-completion">
            <span
              className="dp-ring"
              role="progressbar"
              aria-label={`整体完成度 ${percent}%`}
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              style={{
                background: `conic-gradient(var(--rail-primary) ${percent}%, var(--desk-inset) 0)`,
              }}
            >
              <b>{percent}%</b>
            </span>
            <div>
              {
                doc.episodes.filter(
                  (item) =>
                    (item.script_status ?? (item.script_md.trim() ? "ready" : "empty")) === "ready",
                ).length
              }{" "}
              集剧本就绪
              <br />
              <small>{doc.episodes.filter((item) => item.locked).length} 集已拆解 · </small>
              <small>{doc.episodes.filter((item) => item.final_asset_id).length} 集已成片</small>
            </div>
          </div>
          <DramaOverviewNext doc={doc} go={go} openBreakdown={openBreakdown} />
        </div>
      </div>
    </section>
  );
}

function Portrait({ id, handle }: { id: string; handle: string }) {
  const url = useLocalPreview(handle, id);
  return url ? <img src={url} alt="" /> : null;
}

function matrixTone(enabled: boolean, text: string) {
  if (!enabled) return "none";
  const [completed, total] = text.split("/").map(Number);
  if (text === "✓" || (total && completed === total)) return "done";
  return text === "已过期" || text === "进行中" || (total && completed) ? "active" : "todo";
}
