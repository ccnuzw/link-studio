import {
  boardPrompt,
  type DramaDocument,
  dramaAssetMeta,
  dramaBoardMeta,
  jobIsTerminal,
  modelGenerationOptions,
  type PluginView,
  type ProviderView,
} from "@link-studio/core";
import { useEffect, useRef, useState } from "react";
import { composeLinkedPrompt } from "./compose-canvas-prompt";
import { boardSourceHash, type referenceContext } from "./drama-segment-video";
import { promptRefIds } from "./prompt-tokens";

type Context = Awaited<ReturnType<typeof referenceContext>>;
type Segment = NonNullable<DramaDocument["segments"]>[number];
function boardOf(context: Context, segmentId: string) {
  const node = context.graph.canvas.nodes.findLast(
    (node) => node.type === "creative" && dramaBoardMeta(node.data)?.segmentId === segmentId,
  );
  return node?.type === "creative" ? node : undefined;
}

function BoardImage({
  projectHandle,
  assetId,
  alt,
}: {
  projectHandle: string;
  assetId: string;
  alt: string;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let live = true;
    setUrl("");
    void window.desktop.projects.getAssetPreview({ projectHandle, assetId }).then((result) => {
      if (live && result.ok) setUrl(result.value.url);
    });
    return () => {
      live = false;
    };
  }, [projectHandle, assetId]);
  return url ? <img src={url} alt={alt} draggable={false} /> : null;
}

function needsBoard(context: Context, segment: Segment, hash: string) {
  if (!segment.prompt.trim()) return false;
  const node = boardOf(context, segment.id);
  if (!node) return true;
  const jobs = context.jobs.filter((job) => job.nodeId === node.id && job.kind === "image");
  if (jobs.some((job) => !jobIsTerminal(job.status))) return false;
  return (
    !node.data.assetId ||
    !context.assets.some(
      (asset) => asset.assetId === node.data.assetId && asset.availability === "ready",
    ) ||
    dramaBoardMeta(node.data)?.sourceHash !== hash
  );
}

export function DramaBoardStage({
  projectHandle,
  segment,
  episodeSegments,
  models,
  plugins,
  context,
  settings,
  settingsRevision,
  read,
  refresh,
}: {
  projectHandle: string;
  segment: Segment;
  episodeSegments: Segment[];
  models: ProviderView[];
  plugins: PluginView[];
  context: Context;
  read: (prompt?: string) => Promise<Context>;
  refresh: () => void;
  settings: DramaDocument["board_settings"];
  settingsRevision: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [targets, setTargets] = useState<Segment[]>([]);
  const [confirmedList, setConfirmedList] = useState<Segment[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let live = true;
    void Promise.all(
      episodeSegments.map(async (item) =>
        needsBoard(context, item, await boardSourceHash(item.prompt)) ? item : null,
      ),
    ).then((items) => {
      if (live) setTargets(items.filter((item): item is Segment => !!item));
    });
    return () => {
      live = false;
    };
  }, [context, episodeSegments]);
  const pointer = useRef<number | null>(null);
  const wheel = useRef({ distance: 0, next: 0 });
  const node = boardOf(context, segment.id);
  const meta = node && dramaBoardMeta(node.data);
  const outputs =
    node?.data.outputs?.filter((output) => output.kind === "image" && output.assetId) ?? [];
  const index = outputs.findIndex((output) => output.id === node?.data.activeOutputId);
  const latest = context.jobs.find((job) => job.nodeId === node?.id && job.kind === "image");
  const running = latest && !jobIsTerminal(latest.status);
  const model =
    models.find((model) => model.id === settings?.boardModel) ??
    models.find((model) => model.id === settings?.sceneModel) ??
    models[0];
  const built = boardPrompt(segment.prompt, settings?.template);
  const pricing = model?.config?.pricing;
  const credits =
    pricing && !pricing.pending && pricing.unit !== "token"
      ? Math.min(
          pricing.input,
          ...(pricing.tiers ?? []).filter((tier) => tier.on).map((tier) => tier.unit),
        )
      : 0;
  async function submit(item: Segment, model: ProviderView, fill: boolean) {
    const current = await read(item.prompt);
    if (fill && !needsBoard(current, item, current.sourceHash)) return;
    const built = boardPrompt(item.prompt, settings?.template);
    const adapter = plugins.find((plugin) => plugin.hash === model.pluginHash);
    const options = modelGenerationOptions(
      "image",
      adapter?.origin === "builtin" ? adapter.key : undefined,
      model.model,
      model.channel,
      model.config,
    );
    const sources = current.graph.canvas.nodes.flatMap((item) =>
      item.type === "creative" && dramaAssetMeta(item.data) ? [[item.id, item.data] as const] : [],
    );
    const byId = new Map(sources);
    const refs = promptRefIds(built.text)
      .filter((id) => byId.has(id))
      .slice(0, options.references.image ?? 0);
    const ids = [...new Set(refs.flatMap((id) => byId.get(id)?.assetId ?? []))];
    const attachments = ids.flatMap((id) =>
      current.assets.filter(
        (asset) =>
          asset.assetId === id && asset.mediaType === "image" && asset.availability === "ready",
      ),
    );
    const result = await window.desktop.projects.submitJob({
      projectHandle,
      operationId: crypto.randomUUID(),
      confirmed: true,
      generation: {
        purpose: "drama-board",
        board: { segmentId: item.id, sourceHash: current.sourceHash, refs, settingsRevision },
        nodeId: boardOf(current, item.id)?.id ?? crypto.randomUUID(),
        providerId: model.id,
        expectedProviderRevision: model.revision,
        expectedCanvasRevision: current.graph.canvasRevision,
        prompt: composeLinkedPrompt(built.text, byId, false, attachments),
        referenceAssetIds: attachments.map((asset) => asset.assetId),
        ...(options.ratios.includes("16:9") && { aspectRatio: "16:9" }),
      },
    });
    if (!result.ok) throw Error(result.error.message);
  }
  async function generate(list: Segment[], fill: boolean) {
    if (!model || busy || !list.length) return;
    setBusy(true);
    setError("");
    const failures: string[] = [];
    try {
      for (const item of list) {
        try {
          await submit(item, model, fill);
        } catch (failure) {
          failures.push(failure instanceof Error ? failure.message : "生成故事板失败");
        }
      }
      if (failures.length)
        setError(`${list.length > 1 ? failures.length + " 张" : ""}没能开始生成：${failures[0]}`);
      refresh();
    } finally {
      setBusy(false);
    }
  }
  async function choose(id?: string) {
    if (!id || busy || running || id === node?.data.activeOutputId) return;
    setBusy(true);
    setError("");
    try {
      const current = await read();
      const target = boardOf(current, segment.id);
      const output = target?.data.outputs?.find((item) => item.id === id && item.kind === "image");
      if (!target || !output?.assetId) throw Error("故事板版本已变更");
      const result = await window.desktop.projects.applyCanvasOperations({
        projectHandle,
        operationId: crypto.randomUUID(),
        expectedCanvasRevision: current.graph.canvasRevision,
        operations: [
          {
            type: "putNode",
            node: {
              ...target,
              data: { ...target.data, assetId: output.assetId, activeOutputId: id },
            },
          },
        ],
      });
      if (!result.ok) throw Error(result.error.message);
      refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "选择故事板版本失败");
    } finally {
      setBusy(false);
    }
  }
  const step = (delta: number) => void choose(outputs[index + delta]?.id);
  return (
    <section className="drama-board-stage" aria-label="故事板预览">
      <fieldset
        data-ui-group
        aria-label={outputs.length > 1 ? `故事板版本 ${index + 1} / ${outputs.length}` : "故事板"}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Arrow keys on the focused preview switch storyboard versions.
        tabIndex={0}
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            step(event.key === "ArrowLeft" ? -1 : 1);
          }
        }}
        onWheel={(event) => {
          if (
            Math.abs(event.deltaX) <= Math.abs(event.deltaY) ||
            performance.now() < wheel.current.next
          )
            return;
          wheel.current.distance += event.deltaX;
          if (Math.abs(wheel.current.distance) >= 60) {
            step(Math.sign(wheel.current.distance));
            wheel.current = { distance: 0, next: performance.now() + 260 };
          }
        }}
      >
        <div
          className="drama-board-frame"
          onPointerDown={(event) => {
            pointer.current = event.clientX;
          }}
          onPointerUp={(event) => {
            if (pointer.current !== null && Math.abs(event.clientX - pointer.current) >= 40)
              step(event.clientX < pointer.current ? 1 : -1);
            pointer.current = null;
          }}
        >
          {running ? (
            <span role="status">故事板生成中 · {latest.progress}%</span>
          ) : node?.data.assetId ? (
            <BoardImage
              projectHandle={projectHandle}
              assetId={node.data.assetId}
              alt={`片段 ${segment.seq + 1} 的故事板`}
            />
          ) : (
            <span>还没有故事板</span>
          )}
        </div>
        <div className="drama-board-strip">
          {outputs.length > 1 &&
            outputs.map((output) => (
              <button
                type="button"
                key={output.id}
                aria-label={`故事板版本 ${output.id}`}
                aria-current={output.id === node?.data.activeOutputId || undefined}
                onClick={() => void choose(output.id)}
              >
                <BoardImage projectHandle={projectHandle} assetId={output.assetId!} alt="" />
              </button>
            ))}
        </div>
      </fieldset>
      {node?.data.assetId && meta && meta.shotCount > 0 && (
        <small>
          {meta.shotCount} 镜 · {meta.layout.replace("x", "×")} · 16:9
        </small>
      )}
      {node?.data.assetId && meta?.sourceHash !== context.sourceHash && <span>原稿已改</span>}
      <span>{model?.config?.name ?? model?.label ?? "暂无可用图片模型"}</span>
      {built.notice && <small>{built.notice}</small>}
      {!running && (
        <button
          type="button"
          disabled={!model || busy || !segment.prompt.trim()}
          onClick={() => void generate([segment], false)}
        >
          {node?.data.assetId || latest?.status === "failed" ? "重新生成" : "生成故事板"}
        </button>
      )}
      <button
        type="button"
        disabled={!targets.length || !model || busy}
        onClick={() => {
          setConfirmedList(targets);
          dialog.current?.showModal();
        }}
      >
        批量生成故事板{targets.length > 0 && ` · ${targets.length}`}
      </button>
      <dialog
        ref={dialog}
        className="drama-start-dialog"
        aria-label={`生成 ${confirmedList.length} 张故事板？`}
      >
        <form
          method="dialog"
          onSubmit={(event) => {
            event.preventDefault();
            dialog.current?.close();
            void generate(confirmedList, true);
          }}
        >
          <h2>生成 {confirmedList.length} 张故事板？</h2>
          <p>
            片段 {confirmedList.map((item) => String(item.seq + 1).padStart(2, "0")).join("、")}
            {credits > 0 && `，约 ${credits * confirmedList.length} 积分起`}
          </p>
          <footer>
            <button type="button" onClick={() => dialog.current?.close()}>
              取消
            </button>
            <button type="submit">开始生成</button>
          </footer>
        </form>
      </dialog>
      {(error || latest?.error) && <p role="alert">{error || latest?.error}</p>}
    </section>
  );
}
