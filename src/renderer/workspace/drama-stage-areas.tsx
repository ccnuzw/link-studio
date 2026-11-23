import { type DramaDocument, dramaBoardMeta } from "@link-studio/core";
import { useEffect, useMemo, useState } from "react";
import { DramaOverviewNext } from "./drama-overview-next";
import { boardSourceHash } from "./drama-segment-video";
import type { Stage } from "./drama-workspace-nav";

type Snapshot = { freshBoards: Set<string> };

export function useStageCanvas(projectHandle: string, doc?: DramaDocument | null) {
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
  }, [projectHandle, doc, retry]);
  return { snapshot, problem, reload: () => setRetry((value) => value + 1) };
}

export function stageHints(doc: DramaDocument, fresh?: Set<string>) {
  const hints: Partial<Record<Stage, "run" | "todo">> = {},
    jobs = doc.jobs?.filter((item) => item.status === "running" || item.status === "queued") ?? [];
  const ready = (item: DramaDocument["episodes"][number]) =>
    (item.script_status ?? (item.script_md.trim() ? "ready" : "empty")) === "ready";
  if (doc.planning?.pending?.step === "analyze" || jobs.some((job) => job.step === "scripts"))
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
  doc,
  go,
  openOutline,
  openBreakdown,
  fresh,
}: {
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
      const stale = item.segment_version !== item.final_segment_version;
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
    <section aria-label="总览">
      {doc.outline_md && <button type="button" onClick={openOutline}>读完整大纲</button>}
      {resume?.next ? (
        <button type="button" onClick={() => go(resume.next!, resume.no)}>继续制作第 {resume.no} 集</button>
      ) : (
        rows[0] && <button type="button" onClick={() => go("final", rows[0]!.no)}>全部完成，查看成片</button>
      )}
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
                      <button type="button"
                        disabled={!enabled}
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
          {pages > 1 && (
            <nav aria-label="进度表分页">
              <button type="button" disabled={!page} onClick={() => setIndex(page - 1)}>
                上一页
              </button>{" "}
              {page + 1} / {pages}{" "}
              <button type="button" disabled={page + 1 === pages} onClick={() => setIndex(page + 1)}>
                下一页
              </button>
            </nav>
          )}
        </div>
        <div>
          <h2>整体完成度</h2>
          <progress aria-label={`整体完成度 ${percent}%`} value={percent} max={100} />
          <span>{percent}%</span>
          <DramaOverviewNext doc={doc} go={go} openBreakdown={openBreakdown} />
        </div>
      </div>
    </section>
  );
}
