import { Dialog } from "@base-ui/react/dialog";
import {
  type CanvasShot,
  type CreativeData,
  canvasVideoDuration,
  type GenerationJob,
  jobFailureReason,
  jobIsTerminal,
  maxStoryboardShots,
  type ProviderView,
  type SettingsValues,
} from "@link-studio/core";
import {
  Crosshair,
  GalleryHorizontalEnd,
  Image as ImageIcon,
  Link2,
  Loader2,
  Maximize2,
  Plus,
  RefreshCw,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { motion, Reorder } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useThumbURL } from "./canvas-prompt-editor";
import { BatchShotImages } from "./shot-batch-images";
import { newShot, ShotStats, StoryboardPlaceholder } from "./shot-card-preview";
import { ShotConfirm } from "./shot-confirm";
import { ShotImagePreview } from "./shot-image-preview";
import { ShotDuration, ShotText } from "./shot-inputs";
import { ShotModelPicker, splitModels, splitPrompt, useShotModel } from "./shot-model-picker";
import { ShotRowMenu } from "./shot-row-menu";
import { ShotSelect } from "./shot-select";
import { ShotTableRow } from "./shot-table-row";
import { shotDurationTitle, shotVideoOptions } from "./shot-video";
import { ShotVideoCell } from "./shot-video-cell";

type MediaKind = "image" | "video";
type LinkedNode = { id: string; data: CreativeData };
function ShotThumbnail({
  assetId,
  projectHandle,
  index,
}: {
  assetId: string;
  projectHandle: string;
  index: number;
}) {
  const label = `镜头 ${String(index + 1).padStart(2, "0")}`;
  const url = useThumbURL({ assetId, id: assetId, kind: "image", label }, projectHandle);
  return url ? (
    <img
      src={url}
      alt={`${label} 的分镜图`}
      style={{ width: 144, height: 81, objectFit: "cover", borderRadius: 8 }}
    />
  ) : null;
}

function SplitSkeletonRows() {
  return (
    <div aria-hidden="true" className="split-skeleton-rows">
      {[0, 1, 2].map((row) => (
        <div key={row} className="shot-grid split-skeleton-row">
          <div />
          <i />
          <i />
          {Array.from({ length: 6 }, (_, column) => (
            <i key={column} />
          ))}
          <div />
        </div>
      ))}
    </div>
  );
}

export function StoryboardDialog({
  projectHandle,
  uploadImage,
  prepareVideo,
  generateImages,
  defaultImageProvider,
  locate,
  initial: shots,
  initialFocusId,
  highlightIds,
  resultNotice,
  clearHighlights,
  change,
  linkedNodes,
  jobs,
  settings,
  script,
  boardId,
  title,
  submitSplit,
  close,
}: {
  projectHandle: string;
  prepareVideo: (id: string) => string | undefined;
  generateImages: (
    targets: { id: string; provider?: ProviderView }[],
  ) => Promise<string | undefined>;
  defaultImageProvider?: string;
  uploadImage: (id: string, file: File, progress: (percent: number) => void) => Promise<void>;
  locate: (id: string) => void;
  initial: CanvasShot[];
  initialFocusId?: string;
  highlightIds?: string[];
  resultNotice?: ReactNode;
  clearHighlights: (ids: string[]) => void;
  change: (edit: (current: CanvasShot[]) => CanvasShot[]) => void;
  linkedNodes: Record<MediaKind, LinkedNode[]>;
  jobs: GenerationJob[];
  settings: SettingsValues["list"];
  script: { connected: boolean; text: string };
  boardId: string;
  title: string;
  submitSplit: (
    prompt: string,
    provider: ProviderView,
    mode: "replace" | "append",
  ) => Promise<string | undefined>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  const clearFresh = useRef(clearHighlights);
  clearFresh.current = clearHighlights;
  const firstFresh = highlightIds && shots.find((shot) => highlightIds.includes(shot.id))?.id;
  useEffect(() => {
    if (!firstFresh || !highlightIds) return;
    const frame = requestAnimationFrame(() => {
      dialog.current
        ?.querySelector(`[data-shot-id="${CSS.escape(firstFresh)}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    const timer = setTimeout(() => clearFresh.current(highlightIds), 1200);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [firstFresh, highlightIds]);
  const [addedId, setAddedId] = useState<string | undefined>(initialFocusId);
  const uploading = useRef(new Set<string>());
  const startingImages = useRef(new Set<string>());
  const [progressByRow, setProgressByRow] = useState<Record<string, number>>({});
  const [uploadError, setUploadError] = useState("");
  const upload = async (id: string, file: File) => {
    if (uploading.current.has(id)) return;
    const node = linkedNodes.image.find((node) => node.data.shotId === id);
    if (node && jobs.some((job) => job.nodeId === node.id && !jobIsTerminal(job.status))) {
      setUploadError("这一镜的分镜图正在生成，生成完再上传");
      return;
    }
    uploading.current.add(id);
    setUploadError("");
    const progress = (percent: number) =>
      setProgressByRow((current) => ({ ...current, [id]: percent }));
    progress(0);
    try {
      await uploadImage(id, file, progress);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "分镜图导入失败");
    } finally {
      uploading.current.delete(id);
      setProgressByRow((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  };
  const [previewId, setPreviewId] = useState<string>();
  const previews = shots.flatMap((row, index) => {
    const image = linkedNodes.image.find((node) => node.data.shotId === row.id);
    const assetId = image?.data.assetId ?? row.imageAssetId;
    return assetId
      ? [
          {
            id: row.id,
            assetId,
            nodeId: image?.id,
            label: `镜头 ${String(index + 1).padStart(2, "0")}`,
          },
        ]
      : [];
  });
  const [splitError, setSplitError] = useState("");
  const [dismissedJob, setDismissedJob] = useState<string>();
  const [requestedMode, setRequestedMode] = useState<"append" | "replace">("append");
  const [splitSubmitting, setSplitSubmitting] = useState(false);
  const [overwriteCount, setOverwriteCount] = useState(0);
  const appendButton = useRef<HTMLButtonElement>(null);
  const textModels = splitModels(settings);
  const splitSelection = useShotModel(textModels);
  const splitModel = splitSelection.model;
  const splitJob = jobs
    .filter((job) => job.nodeId === boardId && job.purpose === "storyboard-split")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const splitting = splitSubmitting || !!(splitJob && !jobIsTerminal(splitJob.status));
  const failedJob =
    splitJob?.status === "failed" && splitJob.id !== dismissedJob ? splitJob : undefined;
  const failure = splitError || jobFailureReason(failedJob);
  const splitReason = !script.connected
    ? "请先连接剧本节点"
    : !script.text
      ? "剧本节点还没有内容"
      : splitting
        ? "正在拆分镜"
        : !splitModel
          ? "请选择可用的 Agent 模型"
          : "";

  const latestByNode = new Map<string, GenerationJob>();
  for (const job of jobs) {
    const current = latestByNode.get(job.nodeId);
    if (!current || job.updatedAt > current.updatedAt) latestByNode.set(job.nodeId, job);
  }
  const imageCandidates = settings.providers
    .filter((candidate) => {
      const plugin = settings.plugins.find((item) => item.hash === candidate.pluginHash);
      return (
        candidate.enabled &&
        candidate.channelEnabled !== false &&
        plugin?.kind === "image" &&
        !plugin.disabled &&
        candidate.config?.kind !== "agent" &&
        (plugin.auth === "none" || candidate.hasSecret) &&
        (candidate.config?.modes?.includes("t2i") ?? true)
      );
    })
    .sort((left, right) => (left.config?.sort ?? 100) - (right.config?.sort ?? 100));
  const imageByShot = new Map(linkedNodes.image.map((node) => [node.data.shotId, node]));
  const planImages = () => {
    const targets: string[] = [];
    let missingScene = 0;
    for (const shot of shots) {
      const image = imageByShot.get(shot.id);
      const job = image && latestByNode.get(image.id);
      if (
        shot.imageAssetId ||
        startingImages.current.has(shot.id) ||
        uploading.current.has(shot.id)
      )
        continue;
      if (job && !jobIsTerminal(job.status)) continue;
      if (image?.data.assetId && job?.status !== "failed") continue;
      if (shot.scene.trim()) targets.push(shot.id);
      else missingScene++;
    }
    return { targets, missingScene };
  };
  const startImages = async (ids: string[]) => {
    const targets = ids
      .filter((id) => !startingImages.current.has(id))
      .map((id) => {
        const image = imageByShot.get(id);
        const job = image && latestByNode.get(image.id);
        const preferred = image
          ? (image.data.generation?.providerId ??
            image.data.generation?.modelKey ??
            job?.providerId)
          : defaultImageProvider;
        return {
          id,
          provider: preferred
            ? imageCandidates.find((model) => model.id === preferred)
            : imageCandidates[0],
        };
      });
    if (!targets.length) return;
    for (const { id } of targets) startingImages.current.add(id);
    try {
      return await generateImages(targets);
    } finally {
      for (const { id } of targets) startingImages.current.delete(id);
    }
  };
  async function splitScript(splitMode: "append" | "replace") {
    setOverwriteCount(0);
    if (!splitModel || splitReason) return;
    setSplitSubmitting(true);
    setRequestedMode(splitMode);
    setDismissedJob(splitJob?.id);
    setSplitError("");
    try {
      const prompt = splitPrompt(script.text);
      const result = await submitSplit(prompt, splitModel, splitMode);
      if (result) setSplitError(result);
    } catch {
      setSplitError("暂时无法提交拆镜任务，请稍后重试。");
    } finally {
      setSplitSubmitting(false);
    }
  }
  const update = (id: string, patch: Partial<CanvasShot>) => {
    change((current) => current.map((shot) => (shot.id === id ? { ...shot, ...patch } : shot)));
  };
  const [dragOrder, setDragOrder] = useState<string[]>();
  const orderRef = useRef<string[]>(undefined);
  const orderedRows = (current: CanvasShot[], ids: string[]) => {
    const byId = new Map(current.map((row) => [row.id, row]));
    const ordered = ids.flatMap((id) => byId.get(id) ?? []);
    return [...ordered, ...current.filter((row) => !ids.includes(row.id))];
  };
  const visibleRows = dragOrder ? orderedRows(shots, dragOrder) : shots;
  const finishDrag = () => {
    const order = orderRef.current;
    if (order) change((current) => orderedRows(current, order));
    orderRef.current = undefined;
    setDragOrder(undefined);
  };
  const requestSplit = () => {
    if (!shots.length) return void splitScript("replace");
    setOverwriteCount(shots.length);
  };
  const splitButton = (
    <span title={splitReason || undefined}>
      <button
        type="button"
        disabled={!!splitReason}
        aria-busy={splitting || undefined}
        onClick={requestSplit}
      >
        {splitting && <Loader2 size={16} className="shot-split-spinner" aria-hidden="true" />}
        {splitting ? "拆分中" : "从剧本拆分镜"}
      </button>
    </span>
  );
  const insert = (anchor?: string, after = false) => {
    const id = crypto.randomUUID();
    setAddedId(id);
    change((current) => {
      if (current.length >= maxStoryboardShots) return current;
      const index = current.findIndex((shot) => shot.id === anchor);
      const at = index < 0 ? current.length : index + Number(after);
      return [...current.slice(0, at), newShot(id), ...current.slice(at)];
    });
  };
  return (
    <>
      <ShotConfirm
        small
        open={overwriteCount > 0}
        focus={appendButton}
        title={<>分镜表里已有 {overwriteCount} 个镜头</>}
        change={(open) => {
          if (!open) setOverwriteCount(0);
        }}
      >
        <button type="button" ref={appendButton} onClick={() => void splitScript("append")}>
          追加到末尾
        </button>
        <button type="button" data-destructive onClick={() => void splitScript("replace")}>
          覆盖
        </button>
      </ShotConfirm>
      <Dialog.Root
        open={open}
        onOpenChange={setOpen}
        onOpenChangeComplete={(next) => {
          if (!next) close();
        }}
      >
        <Dialog.Portal
          className="storyboard-layer"
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <Dialog.Backdrop className="storyboard-backdrop" />
          <Dialog.Popup
            ref={dialog}
            className="image-doodle-dialog storyboard-dialog"
            initialFocus={
              initialFocusId
                ? () =>
                    dialog.current?.querySelector<HTMLTextAreaElement>(
                      `[data-shot-id="${CSS.escape(initialFocusId)}"] textarea`,
                    ) ?? true
                : undefined
            }
          >
            {resultNotice}
            <header className="storyboard-heading">
              <GalleryHorizontalEnd size={16} />
              <Dialog.Title id="storyboard-title">{title}</Dialog.Title>
              {shots.length > 0 && <BatchShotImages plan={planImages} generate={startImages} />}
              <div className="storyboard-split-pill">
                <ShotModelPicker models={textModels} selection={splitSelection} busy={splitting} />
                <div
                  className="shot-split-separator"
                  role="separator"
                  aria-orientation="vertical"
                />
                {splitButton}
              </div>
              <ShotStats shots={shots} />
            </header>
            {splitting && (
              <div role="progressbar" aria-label="拆分中" className="storyboard-split-progress">
                <div />
              </div>
            )}
            {failure && (
              <div role="alert" className="storyboard-split-error">
                <TriangleAlert size={16} />
                <span title={failure}>拆分镜失败：{failure}</span>
                <button
                  type="button"
                  disabled={!!splitReason}
                  onClick={() => void splitScript(failedJob?.storyboardSplitMode ?? requestedMode)}
                >
                  重试
                </button>
                <button
                  type="button"
                  aria-label="关闭"
                  onClick={() => {
                    setSplitError("");
                    setDismissedJob(splitJob?.id);
                  }}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {!shots.length && (
              <section className="storyboard-empty">
                {!splitting && <StoryboardPlaceholder />}
                <p>{splitting ? "正在拆分镜" : "还没有镜头"}</p>
                {splitting && <SplitSkeletonRows />}
                {!splitting && (
                  <div>
                    {splitButton}
                    <button type="button" onClick={() => insert()}>
                      <Plus size={16} />
                      添加镜头
                    </button>
                  </div>
                )}
              </section>
            )}
            {uploadError && <p role="alert">{uploadError}</p>}
            {shots.length > 0 && (
              <motion.div className="shot-table-scroll" layoutScroll>
                <div inert={splitting} className="shot-table-content">
                  <div className="shot-grid shot-table-head">
                    {[
                      "",
                      "镜号",
                      "分镜图",
                      "画面描述",
                      "景别",
                      "运镜",
                      "动作/走位",
                      "对白",
                      "时长",
                      "视频",
                      "",
                    ].map((label, index) => (
                      <div key={index}>
                        {label}
                        {index === 3 && <span> *</span>}
                      </div>
                    ))}
                  </div>
                  <Reorder.Group
                    axis="y"
                    as="div"
                    values={visibleRows.map((row) => row.id)}
                    onReorder={(ids: string[]) => {
                      orderRef.current = ids;
                      setDragOrder(ids);
                    }}
                  >
                    {visibleRows.map((row, index) => {
                      const imageNode = linkedNodes.image.find(
                        (image) => image.data.shotId === row.id,
                      );
                      const videoNode = linkedNodes.video.find(
                        (node) => node.data.shotId === row.id,
                      );
                      const actualSeconds = videoNode && canvasVideoDuration(videoNode.data);
                      const prepare = () => setUploadError(prepareVideo(row.id) ?? "");
                      const progress = progressByRow[row.id];
                      const imageJob = imageNode && latestByNode.get(imageNode.id);
                      const generating =
                        !row.imageAssetId && imageJob && !jobIsTerminal(imageJob.status);
                      const failed =
                        !row.imageAssetId &&
                        imageJob &&
                        ["failed", "outcome_unknown", "cancelled"].includes(imageJob.status);
                      const imageAssetId =
                        row.imageAssetId ??
                        (!generating && !failed ? imageNode?.data.assetId : undefined);
                      const regenerate = !row.imageAssetId && (failed || !!imageAssetId);
                      const imageStatus =
                        imageJob?.status === "queued"
                          ? "排队中"
                          : imageJob?.status === "running" && imageJob.progress > 0
                            ? `生成中 ${Math.round(imageJob.progress)}%`
                            : "生成中";
                      const startImage = async () => {
                        if (generating || startingImages.current.has(row.id)) return;
                        try {
                          setUploadError((await startImages([row.id])) ?? "");
                        } catch {
                          setUploadError("暂时无法生成分镜图，请重试。");
                        }
                      };
                      return (
                        <ShotTableRow
                          key={row.id}
                          id={row.id}
                          number={index + 1}
                          highlight={highlightIds?.includes(row.id)}
                          disabled={splitting}
                          finish={finishDrag}
                          dropImage={(file) => void upload(row.id, file)}
                        >
                          <div className="shot-image-cell">
                            <div
                              tabIndex={0}
                              className="shot-image-frame"
                              data-state={failed ? "failed" : generating ? "running" : undefined}
                              title={failed ? jobFailureReason(imageJob) || "生成失败" : undefined}
                            >
                              {imageAssetId ? (
                                <ShotThumbnail
                                  assetId={imageAssetId}
                                  projectHandle={projectHandle}
                                  index={index}
                                />
                              ) : failed ? (
                                <span className="shot-image-failed">
                                  <TriangleAlert size={16} />
                                  生成失败
                                </span>
                              ) : generating ? (
                                <span>{imageStatus}</span>
                              ) : (
                                progress === undefined && <ImageIcon size={24} />
                              )}
                              {imageNode && imageAssetId && !row.imageAssetId && (
                                <Link2 className="shot-image-linked" size={16} />
                              )}
                              <span aria-hidden="true" className="shot-image-drop-hint">
                                <Upload size={16} />
                              </span>
                              {progress !== undefined ? (
                                <span className="shot-image-progress" role="status">
                                  上传中 {progress}%
                                </span>
                              ) : (
                                <div className="shot-image-actions">
                                  {!generating && (
                                    <button
                                      className="shot-image-primary"
                                      type="button"
                                      title={regenerate ? "重新生成" : "生成分镜图"}
                                      aria-label={regenerate ? "重新生成" : "生成分镜图"}
                                      onClick={() => void startImage()}
                                    >
                                      {regenerate ? <RefreshCw /> : <ImageIcon />}
                                      {regenerate ? "重新生成" : "生成"}
                                    </button>
                                  )}
                                  <div className="shot-image-secondary">
                                    {!generating && (
                                      <button
                                        type="button"
                                        aria-label={imageAssetId ? "替换" : "上传分镜图"}
                                        onClick={() => {
                                          const input = document.createElement("input");
                                          input.type = "file";
                                          input.accept = "image/*";
                                          input.onchange = () => {
                                            const file = input.files?.[0];
                                            if (file) void upload(row.id, file);
                                          };
                                          input.click();
                                        }}
                                      >
                                        <Upload />
                                        {imageAssetId ? "替换" : "上传"}
                                      </button>
                                    )}
                                    {imageAssetId && (
                                      <button
                                        type="button"
                                        aria-label="查看大图"
                                        onClick={() => setPreviewId(row.id)}
                                      >
                                        <Maximize2 />
                                        查看
                                      </button>
                                    )}
                                    {imageNode && !row.imageAssetId && (
                                      <button
                                        type="button"
                                        aria-label="在画布中定位"
                                        onClick={() => {
                                          close();
                                          locate(imageNode.id);
                                        }}
                                      >
                                        <Crosshair />
                                        定位
                                      </button>
                                    )}
                                    {row.imageAssetId && (
                                      <button
                                        type="button"
                                        aria-label="移除分镜图"
                                        onClick={() => {
                                          change((current) =>
                                            current.map((shot) => {
                                              if (shot.id !== row.id) return shot;
                                              const { imageAssetId: _removed, ...withoutImage } =
                                                shot;
                                              return withoutImage;
                                            }),
                                          );
                                        }}
                                      >
                                        移除
                                      </button>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                          <ShotText
                            label={`第 ${index + 1} 镜的画面描述`}
                            focus={addedId === row.id}
                            placeholder="必填"
                            required
                            maxLength={2000}
                            value={row.scene}
                            commit={(scene) => update(row.id, { scene })}
                          />
                          <ShotSelect
                            label="景别"
                            container={dialog}
                            value={row.shot}
                            change={(shot) => update(row.id, { shot })}
                          />
                          <ShotSelect
                            label="运镜"
                            container={dialog}
                            value={row.camera}
                            change={(camera) => update(row.id, { camera })}
                          />
                          <ShotText
                            label={`第 ${index + 1} 镜的动作和走位`}
                            placeholder="角色动作、走位、朝向"
                            maxLength={1000}
                            value={row.action}
                            commit={(action) => update(row.id, { action })}
                          />
                          <ShotText
                            label={`第 ${index + 1} 镜的对白`}
                            placeholder="台词或旁白"
                            maxLength={1000}
                            value={row.dialogue}
                            commit={(dialogue) => update(row.id, { dialogue })}
                          />
                          <div>
                            <ShotDuration
                              value={row.duration}
                              change={(duration) => update(row.id, { duration })}
                            />
                            {videoNode &&
                              actualSeconds !== undefined &&
                              actualSeconds !== Math.round(row.duration) && (
                                <small
                                  title={shotDurationTitle(
                                    shotVideoOptions(
                                      settings,
                                      videoNode.data.generation?.providerId ??
                                        videoNode.data.generation?.modelKey ??
                                        latestByNode.get(videoNode.id)?.providerId,
                                    ),
                                  )}
                                >
                                  实际 {actualSeconds}s
                                </small>
                              )}
                          </div>
                          <ShotVideoCell
                            nodeId={videoNode?.id}
                            assetId={videoNode?.data.assetId}
                            job={videoNode && latestByNode.get(videoNode.id)}
                            prepare={prepare}
                            locate={(id) => {
                              close();
                              locate(id);
                            }}
                          />
                          <div className="storyboard-row-actions">
                            <ShotRowMenu
                              number={index + 1}
                              full={shots.length >= maxStoryboardShots}
                              hasVideo={!!videoNode}
                              prepareVideo={prepare}
                              hasImage={!!imageNode}
                              generateImage={() => void startImage()}
                              insert={(after) => insert(row.id, after)}
                              remove={() =>
                                change((current) => current.filter((shot) => shot.id !== row.id))
                              }
                              duplicate={() => {
                                const id = crypto.randomUUID();
                                change((current) => {
                                  const at = current.findIndex((shot) => shot.id === row.id);
                                  if (at < 0 || current.length >= maxStoryboardShots)
                                    return current;
                                  const {
                                    imageNodeId: _image,
                                    videoNodeId: _video,
                                    ...copy
                                  } = current[at]!;
                                  return [
                                    ...current.slice(0, at + 1),
                                    { ...copy, id },
                                    ...current.slice(at + 1),
                                  ];
                                });
                              }}
                            />
                          </div>
                        </ShotTableRow>
                      );
                    })}
                  </Reorder.Group>
                  {splitting &&
                    (splitSubmitting ? requestedMode : splitJob?.storyboardSplitMode) ===
                      "append" && <SplitSkeletonRows />}
                </div>
                <div className="shot-table-add">
                  <button
                    className="storyboard-add"
                    type="button"
                    disabled={splitting || shots.length >= maxStoryboardShots}
                    onClick={() => insert()}
                  >
                    <Plus size={16} /> 添加镜头
                  </button>
                </div>
              </motion.div>
            )}
            {previewId && previews.length > 0 && (
              <ShotImagePreview
                items={previews}
                activeId={previewId}
                select={setPreviewId}
                projectHandle={projectHandle}
                locate={locate}
                close={() => setPreviewId(undefined)}
              />
            )}
            <Dialog.Close aria-label="关闭分镜表" className="storyboard-close">
              <X size={16} />
            </Dialog.Close>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
