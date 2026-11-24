import { AlertDialog } from "@base-ui/react/alert-dialog";
import {
  configuredGenerationInput,
  type DramaDocument,
  dramaBoardMeta,
  type GenerationJob,
  jobFailureReason,
  jobIsTerminal,
  type modelGenerationOptions,
  type PluginView,
  type ProviderView,
  quoteModel,
  quoteQuantity,
} from "@link-studio/core";
import {
  CircleX,
  Clapperboard,
  Film,
  Grid2X2,
  Languages,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DramaBatchVideo } from "./drama-batch-video";
import { boardOf, DramaBoardStage } from "./drama-board-stage";
import { DramaChoiceContent } from "./drama-choice-content";
import { DramaGenerateButton } from "./drama-generate-button";
import { DramaReferenceBar } from "./drama-reference-bar";
import { SegmentPromptEditor, useSegmentPrompt } from "./drama-segment-prompt";
import { batchVideoTargets } from "./drama-segment-status";
import { TakeCarousel } from "./drama-take-carousel";
import { dramaVideoInput } from "./drama-video-input";

type Segment = NonNullable<DramaDocument["segments"]>[number];

export async function boardSourceHash(prompt: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prompt));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function referenceContext(projectHandle: string, prompt: string) {
  const [graph, assets, jobs, sourceHash] = await Promise.all([
    window.desktop.projects.getCanvas({ projectHandle }),
    window.desktop.projects.listAssets({ projectHandle }),
    window.desktop.projects.listJobs({ projectHandle }),
    boardSourceHash(prompt),
  ]);
  if (!graph.ok || !assets.ok || !jobs.ok) throw Error("读取片段参考素材失败");
  return { graph: graph.value, assets: assets.value.assets, jobs: jobs.value.jobs, sourceHash };
}

export function useStudioAdaptations() {
  const pending = useRef(new Set<string>());
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  return {
    running,
    errors,
    reserve(id: string) {
      if (pending.current.has(id)) return false;
      pending.current.add(id);
      return true;
    },
    start(id: string, key: string) {
      setRunning((previous) => new Set(previous).add(id));
      setErrors((previous) => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
    },
    fail(key: string, message: string) {
      setErrors((previous) => ({ ...previous, [key]: message }));
    },
    finish(id: string) {
      pending.current.delete(id);
      setRunning((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    },
  };
}

type VideoProps = {
  canvasVisible?: boolean;
  canvasRevision?: number;
  boardOff: boolean;
  setBoardOff: (off: boolean) => void;
  batchHost?: HTMLElement | null;
  adaptations: ReturnType<typeof useStudioAdaptations>;
  toolbar: HTMLElement | null;
  expanded: boolean;
  previewHost: HTMLElement | null;
  editorHost: HTMLElement | null;
  locked: boolean;
  loadingModels: boolean;
  openBoard: (id: string) => void;
  projectHandle: string;
  model?: ProviderView;
  options?: ReturnType<typeof modelGenerationOptions>;
  resolution: string;
  segment: Segment;
  failure?: string;
  episodeSegments: Segment[];
  episodeOrder: number;
  boardSettings: DramaDocument["board_settings"];
  settingsRevision: number;
  imageModels: ProviderView[];
  plugins: PluginView[];
  ratio: string;
  reload: () => Promise<void>;
};

export function DramaSegmentVideo(props: VideoProps) {
  const format = props.model ? (props.model.config?.promptFormat ?? "generic") : "seedance";
  return <SegmentWorkspace key={`${props.segment.id}:${format}`} {...props} format={format} />;
}

function SegmentWorkspace({
  canvasVisible,
  canvasRevision,
  boardOff,
  setBoardOff,
  format,
  adaptations,
  batchHost,
  openBoard,
  projectHandle,
  model,
  options,
  resolution,
  segment,
  failure,
  episodeSegments,
  episodeOrder,
  imageModels,
  boardSettings,
  settingsRevision,
  plugins,
  ratio,
  reload,
  toolbar,
  expanded,
  previewHost,
  editorHost,
  locked,
  loadingModels,
}: VideoProps & { format: "seedance" | "generic" | "h3" }) {
  const [context, setContext] = useState<Awaited<ReturnType<typeof referenceContext>>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [pickedView, setView] = useState<"board" | "video">();
  const [refresh, setRefresh] = useState(0);
  const nodeId = `seg:${segment.id}`;
  const source = useSegmentPrompt(projectHandle, segment, episodeOrder, reload);
  const translated = useSegmentPrompt(
    projectHandle,
    segment,
    episodeOrder,
    reload,
    format === "h3" ? "h3" : "generic",
  );
  const adaptation = format === "seedance" ? undefined : segment.adaptations?.[format];
  const hasAdaptation = Boolean(adaptation);
  const sourceText = source.value;
  const [fingerprint, setFingerprint] = useState<{ text: string; hash: string }>();
  useEffect(() => {
    if (!hasAdaptation) return;
    let live = true;
    void boardSourceHash(sourceText).then((hash) => {
      if (live) setFingerprint({ text: sourceText, hash });
    });
    return () => {
      live = false;
    };
  }, [hasAdaptation, sourceText]);
  const stale =
    adaptation && fingerprint?.text === sourceText && fingerprint.hash !== adaptation.source_hash;
  const [picked, setPicked] = useState<boolean>();
  const adapted = format !== "seedance" && (picked ?? !!adaptation);
  const draft = adapted ? translated : source;
  const label = format === "h3" ? "H3" : "通用";
  const runId = JSON.stringify([projectHandle, segment.id]);
  const errorKey = JSON.stringify([projectHandle, segment.id, format]);
  const adapting = format !== "seedance" && adaptations.running.has(runId);
  const adaptError = adaptations.errors[errorKey];
  type Question =
    | { kind: "overwrite" }
    | { kind: "stale"; edited: boolean }
    | { kind: "dead"; labels: string[] };
  const [question, setQuestion] = useState<Question>();
  type Choice = "adapt" | "keep" | "cancel";
  const answer = useRef<(choice: Choice) => void>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      answer.current?.("cancel");
    };
  }, []);
  function decide(choice: Choice) {
    answer.current?.(choice);
    answer.current = undefined;
    setQuestion(undefined);
  }
  function ask(next: Question) {
    setQuestion(next);
    return new Promise<Choice>((resolve) => {
      answer.current = resolve;
    });
  }
  async function currentSegment() {
    const result = await window.desktop.projects.drama({ projectHandle });
    const latest = result.ok && result.value?.segments?.find((item) => item.id === segment.id);
    if (!latest) throw Error("读取片段失败");
    return latest;
  }
  async function requestRewrite(latest: Segment) {
    if (format === "seedance") throw Error("原稿无需转写");
    if (!latest.prompt.trim()) throw Error("原稿是空的，先写好原稿再转写");
    const result = await window.desktop.projects.drama({
      projectHandle,
      adaptSegment: {
        segmentId: latest.id,
        episodeNo: latest.episode_no,
        episodeOrder,
        revision: latest.revision,
        format,
      },
    });
    if (!result.ok) throw Error(result.error.message || "转写失败，请稍后重试");
    const saved = result.value?.segments?.find((item) => item.id === latest.id);
    if (!saved?.adaptations?.[format]) throw Error("读取转写稿失败");
    await reload();
    return saved;
  }
  async function rewrite(latest: Segment) {
    const key = JSON.stringify([projectHandle, latest.id, format]);
    adaptations.start(JSON.stringify([projectHandle, latest.id]), key);
    try {
      return await requestRewrite(latest);
    } catch (problem) {
      adaptations.fail(key, problem instanceof Error ? problem.message : "转写失败，请稍后重试");
      throw problem;
    }
  }
  async function changeTab(next: boolean) {
    try {
      await draft.flush();
      setPicked(next);
    } catch {
      setError("提示词尚未保存");
    }
  }
  async function adapt() {
    if (format === "seedance" || busy || !adaptations.reserve(runId)) return;
    setPicked(true);
    try {
      await draft.flush();
      const latest = await currentSegment();
      if (!mounted.current) return;
      if (latest.adaptations?.[format]?.edited && (await ask({ kind: "overwrite" })) !== "adapt")
        return;
      await rewrite(latest);
    } catch (problem) {
      adaptations.fail(
        errorKey,
        problem instanceof Error ? problem.message : "转写失败，请稍后重试",
      );
    } finally {
      adaptations.finish(runId);
    }
  }
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    if (canvasVisible) {
      setContext(undefined);
      return;
    }
    async function load() {
      const result = await referenceContext(projectHandle, segment.prompt).catch(() => undefined);
      if (!live) return;
      if (!result) {
        setError("读取片段参考素材失败");
        return;
      }
      setContext(result);
      if (result.jobs.some((job) => !jobIsTerminal(job.status)))
        timer = window.setTimeout(() => void load(), 600);
      else await reload();
    }
    void load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [nodeId, projectHandle, refresh, reload, segment.prompt, canvasVisible, canvasRevision]);
  const planFor = (
    current: Awaited<ReturnType<typeof referenceContext>>,
    prompt: string,
    sourceHash = current.sourceHash,
  ) =>
    options &&
    dramaVideoInput(
      prompt,
      segment.seconds,
      ratio,
      options,
      current.graph.canvas,
      current.assets,
      current.jobs,
      { segmentId: segment.id, sourceHash, off: boardOff },
      resolution,
    );
  const preview =
    context &&
    planFor(context, draft.value, source.value === segment.prompt ? context.sourceHash : "");
  const jobs: GenerationJob[] =
    context?.jobs.filter((job) => job.purpose === "drama-segment" && job.nodeId === nodeId) ?? [];
  const takes = (segment.take_ids ?? []).flatMap((id) => {
    const job = jobs.find((entry) => entry.id === id);
    if (!job) return [];
    const output = job.outputs.find((entry) => entry.kind === "video");
    return [
      {
        taskId: id,
        status: job.status,
        errorMessage: jobFailureReason(job),
        asset: output?.kind === "video" ? { projectHandle, assetId: output.assetId } : undefined,
      },
    ];
  });
  const running = jobs.some((job) => !jobIsTerminal(job.status));
  const playable = takes.some(
    (take) =>
      take.status === "succeeded" &&
      context?.assets.some(
        (asset) => asset.assetId === take.asset?.assetId && asset.availability === "ready",
      ),
  );
  const view = pickedView ?? (playable ? "video" : "board");
  const boardNode = context && boardOf(context, segment.id);
  const boardJob =
    boardNode && context?.jobs.find((job) => job.nodeId === boardNode.id && job.kind === "image");
  const boardMark =
    boardJob && !jobIsTerminal(boardJob.status)
      ? "生成中"
      : boardJob?.status === "failed"
        ? "失败"
        : boardNode?.data.assetId
          ? dramaBoardMeta(boardNode.data)?.sourceHash === context?.sourceHash
            ? "已就绪"
            : "已过期"
          : "待生成";
  const videoMark = running
    ? "生成中"
    : playable
      ? "已就绪"
      : jobs[0]?.status === "failed"
        ? "失败"
        : "待生成";
  const reason = running
    ? "这个片段正在生成"
    : adapted && adapting
      ? "正在转写"
      : adapted && !adaptation
        ? `先把原稿转写为 ${label}`
        : busy
          ? "正在提交"
          : loadingModels
            ? "正在加载模型清单"
            : !model
              ? "没有可用的视频模型（需要支持参考图）"
              : !locked
                ? "媒体任务只允许已锁定的集"
                : !preview
                  ? error || "正在读取片段参考素材"
                  : preview.errors[0];
  const params = preview && configuredGenerationInput(model?.config, preview.input);
  const pricing = model?.config?.pricing;
  const credits =
    params && pricing && (pricing.unit !== "second" || Number(params.duration) > 0)
      ? quoteModel(
          pricing,
          {
            op: params.op,
            params: {
              ...params,
              ...params.customParams,
              aspect_ratio: params.aspectRatio,
              generate_audio: params.generateAudio,
            },
            promptChars:
              Array.from(params.prompt).length +
              Array.from(model?.config?.systemPrompt ?? "").length,
            outputTokens: model?.config?.maxOutputTokens,
            refVideo: context?.assets.some(
              (asset) =>
                asset.mediaType === "video" && params.referenceAssetIds.includes(asset.assetId),
            ),
          },
          quoteQuantity(model?.config, { ...params, ...params.customParams }),
        )
      : undefined;
  async function generate() {
    if (!model || reason || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      let prompt = await draft.flush();
      let original = prompt;
      if (adapted) {
        let latest = await currentSegment();
        const text = latest.adaptations?.[format];
        if (!text) throw Error(`先把原稿转写为 ${label}`);
        if (text.source_hash !== (await boardSourceHash(latest.prompt))) {
          const choice = await ask({ kind: "stale", edited: !!text.edited });
          if (choice === "cancel") return;
          if (choice === "adapt") {
            if (!adaptations.reserve(runId)) return;
            try {
              latest = await rewrite(latest);
            } finally {
              adaptations.finish(runId);
            }
          }
        }
        original = latest.prompt;
        prompt = latest.adaptations![format]!.prompt;
      }
      const current = await referenceContext(projectHandle, original);
      setContext(current);
      const plan = planFor(current, prompt);
      if (current.jobs.some((job) => job.nodeId === nodeId && !jobIsTerminal(job.status))) {
        setRefresh((value) => value + 1);
        return;
      }
      if (!plan || plan.errors.length) {
        setError(plan?.errors[0] || "还没有片段");
        return;
      }
      const dead = [
        ...new Set(plan.refs.filter((ref) => ref.state === "已失效").map((ref) => ref.label)),
      ];
      if (dead.length) {
        if ((await ask({ kind: "dead", labels: dead })) !== "keep") return;
      }
      await submitInput(segment, current, plan);
      setContext(await referenceContext(projectHandle, original));
      await reload();
      setRefresh((value) => value + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "生成请求失败");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  async function submitInput(
    item: Segment,
    current: Awaited<ReturnType<typeof referenceContext>>,
    plan: ReturnType<typeof dramaVideoInput>,
  ) {
    if (!model) throw Error("没有可用的视频模型");
    const result = await window.desktop.projects.submitJob({
      projectHandle,
      confirmed: true,
      operationId: crypto.randomUUID(),
      generation: {
        purpose: "drama-segment",
        nodeId: `seg:${item.id}`,
        expectedCanvasRevision: current.graph.canvasRevision,
        providerId: model.id,
        expectedProviderRevision: model.revision,
        ...plan.input,
      },
    });
    if (!result.ok) throw Error(result.error.message);
    if (item.id === segment.id) setView("video");
  }
  async function choose(taskId: string) {
    const result = await window.desktop.projects.drama({
      projectHandle,
      chooseTake: { taskId, segmentId: segment.id, revision: segment.revision },
    });
    if (!result.ok) setError(result.error.message ?? "采用片段视频失败");
    await reload();
  }
  const [width = 0, height = 0, extra] = ratio.split(":").map(Number);
  const quotient = width > 0 && height > 0 ? width / height : 0;
  const aspect =
    extra === undefined && Number.isFinite(quotient) && quotient > 0 ? quotient : 9 / 16;
  return (
    <>
      {batchHost &&
        createPortal(
          <DramaBatchVideo
            adapted={adapted}
            format={format}
            disabled={!model || !locked || busy}
            hash={boardSourceHash}
            refresh={reload}
            report={setError}
            targets={async () => {
              await draft.flush();
              const [response, tasks, assets] = await Promise.all([
                window.desktop.projects.drama({ projectHandle }),
                window.desktop.projects.listJobs({ projectHandle }),
                window.desktop.projects.listAssets({ projectHandle }),
              ]);
              if (!response.ok || !response.value || !tasks.ok || !assets.ok)
                throw Error("读取本集片段失败");
              return batchVideoTargets(
                response.value.segments ?? [],
                segment.episode_no,
                tasks.value.jobs,
                assets.value.assets,
              );
            }}
            rewrite={async (item) => {
              const id = JSON.stringify([projectHandle, item.id]);
              if (!adaptations.reserve(id)) throw Error("这个片段正在转写");
              try {
                return await rewrite(item);
              } finally {
                adaptations.finish(id);
              }
            }}
            plan={async (item, prompt) => {
              if (!options) throw Error("没有可用的视频模型");
              const current = await referenceContext(projectHandle, item.prompt);
              const plan = dramaVideoInput(
                prompt,
                item.seconds,
                ratio,
                options,
                current.graph.canvas,
                current.assets,
                current.jobs,
                { segmentId: item.id, sourceHash: current.sourceHash, off: boardOff },
                resolution,
              );
              if (plan.errors.length) throw Error(plan.errors[0]);
              return {
                dead: plan.refs.filter((ref) => ref.state === "已失效").map((ref) => ref.label),
                submit: () => submitInput(item, current, plan),
              };
            }}
          />,
          batchHost,
        )}
      {question && (
        <AlertDialog.Root
          open
          onOpenChange={(open) => {
            if (!open) decide("cancel");
          }}
        >
          <AlertDialog.Portal className="storyboard-layer drama-delete-layer">
            <AlertDialog.Backdrop className="shot-confirm-backdrop" />
            <AlertDialog.Popup
              className="shot-confirm drama-delete-confirm"
              data-batch-choice={question.kind === "stale" || undefined}
            >
              {question.kind === "stale" ? (
                <DramaChoiceContent<Choice>
                  title="原稿在转写后改过"
                  description={`当前 ${label} 转写稿是按旧原稿转的${question.edited ? "，并且被你手改过，重新转写会覆盖这些修改" : ""}。`}
                  options={[
                    { key: "adapt", label: "重新转写并生成" },
                    { key: "keep", label: "仍用当前转写稿生成" },
                  ]}
                  select={decide}
                  cancel={() => decide("cancel")}
                />
              ) : (
                <>
                  <AlertDialog.Title>
                    {question.kind === "dead" ? "有引用已失效" : "覆盖手改的转写稿？"}
                  </AlertDialog.Title>
                  <AlertDialog.Description>
                    {question.kind === "dead"
                      ? `「${question.labels.join("」「")}」对应的资产已被删除，这部分只会按文字提交。要继续生成吗？`
                      : `这份 ${label} 转写稿被你改过，重新转写会覆盖这些修改。`}
                  </AlertDialog.Description>
                  <div>
                    <button type="button" onClick={() => decide("cancel")}>
                      取消
                    </button>
                    <button
                      type="button"
                      data-primary
                      onClick={() => decide(question.kind === "dead" ? "keep" : "adapt")}
                    >
                      {question.kind === "dead" ? "继续生成" : "重新转写"}
                    </button>
                  </div>
                </>
              )}
            </AlertDialog.Popup>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      )}
      {toolbar &&
        createPortal(
          <>
            <DramaGenerateButton
              reason={reason}
              busy={busy || running}
              again={takes.some(
                (take) =>
                  take.taskId === segment.chosen_task_id &&
                  take.status === "succeeded" &&
                  !!take.asset,
              )}
              credits={credits}
              generate={() => void generate()}
            />
            {error && <span role="alert">{error}</span>}
          </>,
          toolbar,
        )}
      {expanded &&
        editorHost &&
        createPortal(
          <section
            className="studio-video-editor"
            aria-label="片段视频"
            onKeyDown={(event) => {
              if (
                (event.metaKey || event.ctrlKey) &&
                event.key === "Enter" &&
                !event.defaultPrevented &&
                !event.nativeEvent.isComposing &&
                !event.repeat
              ) {
                event.preventDefault();
                void generate();
              }
            }}
          >
            {preview && (
              <DramaReferenceBar
                plan={preview}
                projectHandle={projectHandle}
                setBoardOff={setBoardOff}
              />
            )}
            {format !== "seedance" && (
              <div className="studio-draft-controls">
                <div role="tablist" aria-label="提示词格式">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={!adapted}
                    disabled={busy}
                    onClick={() => void changeTab(false)}
                  >
                    原稿 · Seedance
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={adapted}
                    disabled={busy}
                    onClick={() => void changeTab(true)}
                  >
                    转写 · {label}
                    {adapting ? (
                      <Loader2 size={12} className="studio-adapt-spin" />
                    ) : stale ? (
                      <span className="studio-adapt-stale">
                        <i />
                        已过期
                      </span>
                    ) : (
                      adaptation && <i title="最新" aria-hidden="true" />
                    )}
                  </button>
                </div>
                <button
                  type="button"
                  disabled={busy || adapting}
                  title={
                    adapting ? "正在转写" : adaptation ? `按当前原稿重新转写为 ${label}` : undefined
                  }
                  onClick={() => void adapt()}
                >
                  {adapting ? (
                    <Loader2 size={16} className="studio-adapt-spin" />
                  ) : adaptation ? (
                    <RefreshCw size={16} />
                  ) : (
                    <Languages size={16} />
                  )}{" "}
                  {adaptation ? "重新转写" : `转写为 ${label}`}
                </button>
              </div>
            )}
            {adapted && adaptError && (
              <div className="studio-adapt-bar" role="alert">
                <CircleX size={16} aria-hidden />
                <span>{adaptError}</span>
                <button type="button" disabled={adapting} onClick={() => void adapt()}>
                  重试
                </button>
              </div>
            )}
            {adapted && stale && !adapting && (
              <div className="studio-adapt-bar" role="status">
                <TriangleAlert size={16} aria-hidden />
                <span>原稿已修改</span>
                <button type="button" disabled={busy} onClick={() => void adapt()}>
                  重新转写
                </button>
              </div>
            )}
            {adapted && !adaptation ? (
              <div className="studio-adapt-empty">
                {adapting ? (
                  <Loader2 size={24} className="studio-adapt-spin" />
                ) : (
                  <Languages size={24} />
                )}
                {adapting ? `正在转写为 ${label}` : `还没有 ${label} 转写稿`}
                {!adapting && (
                  <button type="button" onClick={() => void adapt()}>
                    转写为 {label}
                  </button>
                )}
              </div>
            ) : (
              <SegmentPromptEditor
                boardLine={preview?.boardLine}
                key={adapted ? format : "source"}
                adapted={adapted}
                disabled={(adapted && adapting) || busy}
                graph={context?.graph.canvas}
                episodeNo={segment.episode_no}
                projectHandle={projectHandle}
                prompt={draft}
                generate={() => void generate()}
                report={setError}
              />
            )}
            {preview?.notices.map((notice) => (
              <p key={notice}>{notice}</p>
            ))}
            {preview?.errors.map((problem) => (
              <p key={problem} role="alert">
                {problem}
              </p>
            ))}
            {failure && (
              <div role="alert" className="studio-segment-failure">
                <CircleX size={16} aria-hidden />
                <span>{failure}</span>
              </div>
            )}
          </section>,
          editorHost,
        )}
      {expanded &&
        (previewHost || batchHost) &&
        createPortal(
          <>
            {previewHost && (
              <fieldset data-ui-group className="drama-preview-switch" aria-label="预览">
                <button
                  type="button"
                  aria-pressed={view === "board"}
                  onClick={() => setView("board")}
                >
                  <Grid2X2 size={14} aria-hidden /> 故事板{" "}
                  <i title={boardMark} data-preview-mark={boardMark} />
                </button>
                <button
                  type="button"
                  aria-pressed={view === "video"}
                  onClick={() => setView("video")}
                >
                  <Film size={14} aria-hidden /> 视频{" "}
                  <i title={videoMark} data-preview-mark={videoMark} />
                </button>
              </fieldset>
            )}
            {context && (
              <DramaBoardStage
                hidden={!previewHost || view !== "board"}
                batchHost={batchHost}
                openBoard={openBoard}
                projectHandle={projectHandle}
                segment={{ ...segment, prompt: source.value }}
                episodeSegments={episodeSegments}
                draftPrompt={source.value}
                models={imageModels}
                plugins={plugins}
                context={context}
                settings={boardSettings}
                settingsRevision={settingsRevision}
                prepareSegments={async () => {
                  await source.flush();
                  const response = await window.desktop.projects.drama({ projectHandle });
                  if (!response.ok || !response.value) throw Error("读取已保存分镜失败");
                  return response.value.segments ?? [];
                }}
                read={(prompt = segment.prompt) => referenceContext(projectHandle, prompt)}
                refresh={() => setRefresh((value) => value + 1)}
              />
            )}
            {previewHost && view === "video" && (
              <>
                {takes.length > 0 && (
                  <TakeCarousel
                    takes={takes}
                    chosenTaskId={segment.chosen_task_id ?? ""}
                    aspect={aspect}
                    onChoose={(taskId) => void choose(taskId)}
                  />
                )}
                {!takes.length && context && (
                  <div
                    className="studio-video-stage"
                    style={{ "--video-aspect": aspect } as CSSProperties}
                  >
                    <div className="studio-video-slate">
                      <strong title={`第 ${segment.seq + 1} 段`}>
                        {String(segment.seq + 1).padStart(2, "0")}
                      </strong>
                      <Clapperboard size={20} aria-hidden="true" />
                      <span>{running || busy ? "正在生成视频…" : "还没有生成内容"}</span>
                    </div>
                  </div>
                )}
              </>
            )}
          </>,
          previewHost ?? batchHost!,
        )}
    </>
  );
}
