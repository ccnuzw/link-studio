import type {
  CanvasCharacter,
  CanvasOperation,
  CreativeData,
  CreativeOutput,
  DirectorScene,
  GenerationInput,
  GenerationJob,
  ImportStatus,
  ProjectActivation,
  ProjectAsset,
  ProjectCanvasView,
  ProjectSession,
  ProviderView,
  RecentProject,
} from "@link-studio/core";
import {
  type AppInfo,
  canvasAnchorPosition,
  characterVoice,
  defaultDirectorScene,
  gridBounds,
  imageDisplaySize,
  isAppInfo,
  isPlainGeneratedMedia,
  jobFailureReason,
  jobIsTerminal,
  mergeCanvasExchange,
  parseCanvasExchange,
  prepareCanvasExchange,
  prepareVideoCanvasExchange,
  queueFullMessage,
} from "@link-studio/core";
import {
  type Connection,
  type Edge,
  type EdgeChange,
  Handle,
  type Node,
  type NodeChange,
  type NodeProps,
  NodeToolbar,
  Position,
  ReactFlow,
  type ReactFlowInstance,
  SelectionMode,
  useEdgesState,
  useNodesState,
  useReactFlow,
  ViewportPortal,
} from "@xyflow/react";
import {
  Check,
  Copy,
  Cpu,
  Download,
  Expand,
  Image,
  LayoutGrid,
  Loader2,
  Music,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  TriangleAlert,
  Type,
  Upload,
  UserRound,
  Video,
  X,
} from "lucide-react";
import { motion } from "motion/react";
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AddNodeMenu, nodeMenuItems } from "./add-node-menu";
import { AgentMarks, createAgentMarks, useAgentMark } from "./agent-marks";
import type { FiledChoice } from "./asset-human-pane";
import { planAssetNodes, replaceImageAsset } from "./asset-node-batch";
import { AssetPickerDialog } from "./asset-picker-dialog";
import { runCanvasExport } from "./canvas-export";
import { CanvasExportProgress } from "./canvas-export-progress";
import { canvasFileAspect } from "./canvas-file-aspect";
import { canvasSeed } from "./canvas-seed";
import { CanvasTextMarkdown } from "./canvas-text-markdown";
import { CanvasUploadBody, CanvasUploadContext, useCanvasUploads } from "./canvas-upload";
import {
  type CanvasUploadSelection,
  type ClipboardUploadSelection,
  canvasUploadKind,
  clipboardFileName,
} from "./canvas-upload-file";
import {
  bindCharacterMedia,
  type CharacterPick,
  type CharacterPurpose,
  characterShowsGenerator,
} from "./character-pick";
import { CreationHome, type CreationMode } from "./creation-home";
import { importPickerFile } from "./import-picker-file";
import { LibraryFolderForm } from "./library-folder-form";
import { LibraryLocationDialog, LibraryManagement } from "./library-management";
import { MediaFillActions, MediaNodePlaceholder } from "./media-node-placeholder";
import { assetNodeLabel, availableNodeLabel } from "./node-label";
import { NodePort } from "./node-port";
import type { PickerUpload } from "./picker-uploads";
import { ReadonlyCanvas, type ReadonlyView } from "./readonly-canvas";
import { ShotConfirm } from "./shot-confirm";
import { TextFailureTask } from "./text-failure-task";
import { useConnectionTilt } from "./use-connection-tilt";
import "./text-editor.css";
import type { GroupHue } from "@link-studio/core";
import { createPortal, flushSync } from "react-dom";
import { toast } from "sonner";
import { copySettingsText } from "../settings/copy-settings-text";
import type { RenderFilingPicker } from "../settings/filing-library";
import { SettingsPage } from "../settings/settings-page";
import {
  ALIGN_ENTER_PX,
  ALIGN_RELEASE_PX,
  type AxisLock,
  alignmentGuides,
  findAxisSnap,
  type Guide,
  type Rect,
  type SnapTarget,
} from "./alignment";
import { animateArrangement } from "./arrange-animation";
import { ArrangeMenu } from "./arrange-menu";
import { CanvasAssistant } from "./canvas-assistant";
import { CanvasEdge, type CanvasFlowEdge, RunningEdgeTargets } from "./canvas-edge";
import { CanvasEditToolbar } from "./canvas-edit-toolbar";
import { canvasModifier } from "./canvas-keys";
import { CanvasMiniMap } from "./canvas-minimap";
import { canvasPreviewItem, collectCanvasPreviews } from "./canvas-preview-items";
import { CanvasProjectBar } from "./canvas-project-bar";
import { CanvasShortcuts } from "./canvas-shortcuts";
import { CanvasShortcutsDialog } from "./canvas-shortcuts-dialog";
import { CanvasStatsBar } from "./canvas-stats-bar";
import { CanvasTaskHistory } from "./canvas-task-history";
import { CanvasToaster, canvasNotice, reportFillError, reportLinkNotice } from "./canvas-toaster";
import { CanvasViewControls } from "./canvas-view-controls";
import { CanvasBackgroundLayer, useCanvasViewPreferences } from "./canvas-view-preferences";
import { CanvasViewSettings } from "./canvas-view-settings";
import { CharacterCardBody, useLocalPreview } from "./character-card-body";
import { CharacterDialog } from "./character-dialog";
import { imageProgress, imageTaskTitle, MediaGenerationTask } from "./character-image-task";
import { characterVoiceModel } from "./character-voice-model";
import { stopCharacterVoice } from "./character-voice-player";
import { CompositionDialog } from "./composition-dialog";
import { DirectorNodeBody } from "./director-node-body";
import { positionDirectorTakes } from "./director-take-placement";
import { assetImageInput, assetUnit, assetVoiceInput } from "./drama-asset-generation";
import { DramaStudio } from "./drama-studio";
import { edgeIdsHitBySweep } from "./edge-sweep";
import { FilingAssetPicker } from "./filing-asset-picker";
import type { FrameChoice } from "./frame-menu";
import { placeBeside, planFramePlacement } from "./frame-placement";
import {
  GenerationForm,
  isGenerationMedia,
  JobCenter,
  NodeGenerationHistory,
  useGenerationProviders,
} from "./generation";
import { gridNodeLabel, imageFrameSize, planGridPlacement } from "./grid-placement";
import { type GridSplitDraft, GridSplitOverlay } from "./grid-split-overlay";
import { GroupNodeCard } from "./group-card";
import { groupDropTargets } from "./group-drop";
import { GroupToolbar } from "./group-toolbar";
import { HumanEnroll } from "./human-enroll";
import { ImageDoodleOverlay } from "./image-doodle-overlay";
import { ImageOutpaintDialog, type OutpaintDraft } from "./image-outpaint-dialog";
import { appendShotImage, importShotImage } from "./import-shot-image";
import { canLinkKinds, type LinkKind, linkBodyAt, linkKind } from "./link-rules";
import { mediaGenerationDraft } from "./media-generation-draft";
import { mediaNodeJob } from "./media-node-job";
import {
  canvasModelGroups,
  defaultNodeGeneration,
  mediaNodeFrame,
  nodeModels,
} from "./media-node-model";
import { MediaPanelAnchor } from "./media-panel-anchor";
import { linkedMediaSources } from "./media-references";
import { NodeActionAnchor, NodeActionStrip } from "./node-action-strip";
import { NodeAudioPlayer } from "./node-audio-player";
import { NodeImagePreview } from "./node-image-preview";
import { CardHeading, RenameTitle } from "./node-title";
import { NodeVersionDialog, VersionBadge } from "./node-version-dialog";
import { versionBadge, versionJobs, versionNodes, versionOutputs } from "./node-versions";
import { NodeVideoPlayer } from "./node-video-player";
import { locatePetResults } from "./pet/locate-results";
import { promptPresets, removePromptRef } from "./prompt-tokens";
import { runningEdgeTargets as resolveRunningEdgeTargets } from "./running-edge-targets";
import {
  type ArrangeMode,
  arrangeSelection,
  type CanvasFragment,
  captureSelection,
  cloneSelection,
} from "./selection-actions";
import { SelectionButton } from "./selection-button";
import { type Fan, FanLines, type OpenFan, SelectionFan } from "./selection-fan";
import { SelectionOverlay } from "./selection-overlay";
import { newShot, ShotCardPreview, ShotStats, StoryboardPlaceholder } from "./shot-card-preview";
import { ShotImagePreview } from "./shot-image-preview";
import { readShotModel, splitModels, splitPrompt } from "./shot-model-picker";
import { seedShotVideo, shotImagePrompt } from "./shot-video";
import { NODE_LABELS, type NodeKind, useWorkspace } from "./store";
import { StoryboardDialog } from "./storyboard-dialog";
import { useCanvasHistory } from "./use-canvas-history";
import { useCanvasSave } from "./use-canvas-save";
import { useDoodleUploads } from "./use-doodle-uploads";
import { useTemporaryHand } from "./use-temporary-hand";
import { VideoFrameDialog } from "./video-frame-dialog";
import { VideoFrameOverlay } from "./video-frame-overlay";
import { mediaLinkMode } from "./video-modes";
import { VideoTrimDialog } from "./video-trim-dialog";

const NODE_ICONS = { script: Type, image: Image, video: Video, audio: Music };
const TextEditorDialog = lazy(() => import("./text-editor-dialog"));
const OpenTextEditor = createContext<(id: string) => void>(() => undefined);
const OpenStoryboard = createContext<(id: string, focusShotId?: string) => void>(() => undefined);
const SplitCard = createContext<
  | ((id: string) => {
      reason: string;
      running: boolean;
      failure?: string;
      start: () => Promise<string | undefined>;
    })
  | null
>(null);
const DirectorDialog = lazy(async () => ({
  default: (await import("./director-dialog")).DirectorDialog,
}));
const defaultCharacter: CanvasCharacter = {
  name: "未命名角色",
  look: "基础形象",
  description: "",
  extraAssetIds: [],
};

function withPrimaryAsset(
  data: CreativeData,
  assetId?: string,
  activeOutputId?: string,
): CreativeData {
  const { character } = data;
  return {
    ...data,
    assetId,
    activeOutputId,
    pendingMediaVersion: undefined,
    ...(character
      ? {
          character: {
            ...character,
            extraAssetIds: character.extraAssetIds.filter((id) => id !== assetId),
          },
        }
      : {}),
  };
}
type CreativeNode = Node<
  CreativeData & {
    uploadProgress?: number;
    uploadInterrupted?: boolean;
    framePending?: boolean;
    splitPending?: { width: number; height: number };
  },
  "creative"
> & {
  type: "creative";
};
type FlowNode =
  | CreativeNode
  | (Node<{ label: string; color?: GroupHue; labelColor?: GroupHue }, "group"> & { type: "group" })
  | (Node<{ label: string }, "unknown"> & { type: "unknown" });
type FlowEdge = Edge<{ readOnly?: true }>;
const initialViewport = { x: 20, y: 10, zoom: 0.9 };
const NodeMedia = createContext<{
  models: Record<"image" | "video", ReturnType<typeof nodeModels>>;
  assets: ProjectAsset[];
  projectHandle: string;
  writing: boolean;
} | null>(null);
type VisualMediaTarget = {
  nodeId: string;
  kind: ProjectAsset["mediaType"];
  extra?: boolean;
  replaceAssetId?: string;
};
function bindNodeMedia(data: CreativeData, assetId: string, extra?: boolean) {
  if (data.character)
    return bindCharacterMedia(data, extra ? "extra" : "main", [assetId], new Date().toISOString());
  return extra ? data : { ...withPrimaryAsset(data, assetId), uploaded: true as const };
}
const VisualMediaActions = createContext<{
  busy: boolean;
  running: (id: string) => boolean;
  editCharacter: (id: string) => void;
  enterDirector: (id: string) => void;
  voicePending: (id: string) => boolean;
  imageJob: (id: string) => GenerationJob | undefined;
  mediaJob: (id: string, data: CreativeData) => GenerationJob | undefined;
  versions: (id: string, data: CreativeData) => ReturnType<typeof versionBadge>;
  openVersions: (id: string) => void;
  retryHint: (id: string, data: CreativeData) => string | undefined;
  actOnTask: (job: GenerationJob, character?: boolean) => Promise<void>;
  upload: (target: VisualMediaTarget) => void;
  library: (target: VisualMediaTarget) => void;
  reportError: (message: string) => void;
} | null>(null);
type Point = { x: number; y: number };
type PendingLink = {
  id: string;
  kind: LinkKind;
  type: "source" | "target";
  from?: Point;
  to?: Point;
};
type DramaScope = { type?: "character" | "scene" | "prop"; episodes: number[] };
function dramaAssetScope(type: string, episode: number): DramaScope {
  return {
    type: type === "scene" || type === "prop" || type === "character" ? type : undefined,
    episodes: episode ? [episode] : [],
  };
}
function scopedDramaData(scope: DramaScope, label: string): CreativeData["drama"] {
  return scope.type
    ? {
        type: scope.type,
        name: label,
        look: "",
        description: "",
        aliases: [],
        episodes: scope.episodes,
      }
    : { episodes: scope.episodes };
}
type DropPlacement = {
  position: Point;
  pending?: PendingLink;
  clipboard?: true;
  dramaDrop?: { kind: ProjectAsset["mediaType"]; scope: DramaScope };
};
function droppedPosition({ position, pending }: DropPlacement, index = 0): Point {
  return canvasAnchorPosition(
    { x: position.x + (index % 3) * 440, y: position.y + Math.floor(index / 3) * 380 },
    pending?.type === "target" ? 1 : 0,
    pending ? 0.5 : 0,
  );
}
const emptyActions = [
  { kind: "image", label: "图片生成", detail: "文字或参考图出图", icon: Image },
  { kind: "video", label: "视频生成", detail: "文生、参考、编辑、延长", icon: Video },
  { kind: "script", label: "文本", detail: "脚本、分镜描述", icon: Type },
  { kind: "upload", label: "上传素材", detail: "图片、视频、音频", icon: Upload },
] as const;

function isBlankPane(target: EventTarget, root: Element) {
  return (
    target instanceof Element &&
    root.contains(target) &&
    !target.closest(
      ".react-flow__node,.react-flow__node-toolbar,.react-flow__edge,.react-flow__panel,button,input,textarea",
    )
  );
}
const assetErrors: Record<string, string> = {
  ASSET_READ_FAILED: "文件无法读取或媒体内容无效",
  ASSET_IMPORT_CANCELLED: "已取消媒体处理",
  ASSET_TYPE_UNSUPPORTED: "暂不支持此文件类型",
  ASSET_SIZE_LIMIT: "媒体超过导入限制",
  ASSET_STORAGE_FAILED: "无法写入项目副本或保存素材定位",
  ASSET_REFERENCE_CHANGED: "文件内容与原素材不一致，请选择内容相同的文件",
  ASSET_NOT_FOUND: "素材文件不可用，请刷新项目文件列表或重新定位",
  ASSET_IN_USE: "素材在画布或其他项目内容中被引用，请先解除引用",
  TOKEN_INVALID_OR_EXPIRED: "选择已过期，请重新选择文件",
  PROJECT_CONFLICT: "项目已更新，请重试",
  PROJECT_SAVE_FAILED: "无法保存项目，请检查磁盘或重新打开项目",
};

function AssetPreview({
  asset,
  url,
  close,
}: {
  asset: ProjectAsset;
  url: string;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="asset-preview"
      aria-labelledby="asset-preview-name"
      onClose={close}
    >
      <header>
        <h2 id="asset-preview-name">{asset.displayName}</h2>
        <button type="button" onClick={() => dialog.current?.close()}>
          关闭预览
        </button>
      </header>
      {failed ? (
        <p role="alert">无法播放此素材。请检查文件或媒体编码。</p>
      ) : asset.mediaType === "image" ? (
        <img src={url} alt={asset.displayName} onError={() => setFailed(true)} />
      ) : asset.mediaType === "video" ? (
        // biome-ignore lint/a11y/useMediaCaption: Local user-selected media may not have a caption track.
        <video src={url} controls preload="metadata" onError={() => setFailed(true)} />
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: Local user-selected media may not have a caption track.
        <audio src={url} controls preload="metadata" onError={() => setFailed(true)} />
      )}
    </dialog>
  );
}

function NodeAsset({
  assetId,
  kind,
  selected,
  children,
}: {
  assetId?: string;
  kind: Exclude<NodeKind, "script">;
  selected: boolean;
  children?: ReactNode;
}) {
  const media = useContext(NodeMedia);
  const actions = useContext(VisualMediaActions);
  const asset = media?.assets.find((item) => item.assetId === assetId);
  const handle = media?.projectHandle;
  const ready = asset?.availability === "ready";
  const [preview, setPreview] = useState<{ assetId: string; url: string }>();
  useEffect(() => {
    if (!handle || !assetId || !ready || kind === "image") return;
    let current = true;
    void window.desktop.projects
      .getAssetPreview({ projectHandle: handle, assetId })
      .then((result) => {
        if (current && result.ok) setPreview({ assetId, url: result.value.url });
      });
    return () => {
      current = false;
    };
  }, [handle, assetId, ready, kind]);
  const url = ready && preview?.assetId === assetId ? preview?.url : undefined;
  const Icon = NODE_ICONS[kind];
  return (
    <div className="node-media" data-kind={kind}>
      {ready && handle && assetId && kind === "image" ? (
        <NodeImagePreview
          key={`${handle}:${assetId}`}
          handle={handle}
          id={assetId}
          selected={selected}
          alt={asset?.displayName ?? ""}
        />
      ) : kind === "video" && url && actions && asset && handle ? (
        <NodeVideoPlayer
          key={url}
          src={url}
          assetId={asset.assetId}
          projectHandle={handle}
          active={selected}
          durationMs={Number(asset.metadata.durationMs)}
          onFailure={actions.reportError}
        />
      ) : kind === "audio" && url && asset && handle ? (
        <NodeAudioPlayer
          key={url}
          src={url}
          assetId={asset.assetId}
          projectHandle={handle}
          active={selected}
        />
      ) : !assetId ? (
        <MediaNodePlaceholder kind={kind} />
      ) : (
        <>
          <Icon size={27} />
          <span>{ready ? asset?.displayName : "素材待定位"}</span>
        </>
      )}
      {children}
    </div>
  );
}

function CreativeCard({ data, id, selected }: NodeProps<CreativeNode>) {
  const tilt = useConnectionTilt(id, linkKind(data));
  const mark = useAgentMark(id);
  const kind = linkKind(data);
  const { updateNodeData } = useReactFlow<FlowNode>();
  const openText = useContext(OpenTextEditor);
  const openBoard = useContext(OpenStoryboard);
  const cardSplit = useContext(SplitCard);
  const split = data.storyboard && cardSplit?.(id);
  const [splitError, setSplitError] = useState("");
  const media = useContext(NodeMedia);
  const actions = useContext(VisualMediaActions);
  const imageJob = data.character ? actions?.imageJob(id) : undefined;
  const textRunning =
    data.kind === "script" && !data.storyboard && !data.director && actions?.running(id);
  const ordinaryJob =
    data.uploadProgress === undefined && !data.framePending && !data.splitPending
      ? actions?.mediaJob(id, data)
      : undefined;
  const shownJob = imageJob ?? ordinaryJob;
  const retryHint = ordinaryJob?.status === "failed" ? actions?.retryHint(id, data) : undefined;
  const thumbnail = useLocalPreview(media?.projectHandle, data.directorThumbnailId);
  const imageStatus = imageTaskTitle(shownJob);
  const writing = media?.writing;
  const visual = isGenerationMedia(data.kind);
  const badge = actions?.versions(id, data);
  const target = data.kind !== "script" ? { nodeId: id, kind: data.kind } : undefined;
  const asset = media?.assets.find(
    ({ assetId, availability }) => assetId === data.assetId && availability === "ready",
  );
  const imageFrame = mediaNodeFrame(
    data,
    (data.kind === "image" || data.kind === "video") && media ? media.models[data.kind] : [],
    asset?.metadata,
    data.splitPending,
  );
  return (
    <motion.article
      className={`creative-card ${selected ? "is-selected" : ""}`}
      aria-label={data.label}
      tabIndex={0}
      data-card-kind={kind}
      data-agent-mark={mark}
      data-visual={visual}
      data-storyboard={data.storyboard ? true : undefined}
      data-director={data.director ? true : undefined}
      data-character={data.character ? true : undefined}
      data-image-frame={imageFrame && !data.character ? true : undefined}
      style={{ ...(data.character ? { width: imageFrame?.width ?? 576 } : imageFrame), ...tilt }}
    >
      {linkKind(data) !== "script" && !data.director && (
        <NodePort type="target" hidden={!!data.uploaded} />
      )}
      {badge && <VersionBadge {...badge} open={() => actions?.openVersions(id)} />}
      <CardHeading
        kind={kind}
        label={data.label}
        disabled={writing || !!data.framePending || !!data.splitPending}
        commit={(label) => updateNodeData(id, { label })}
        status={
          split?.running ? (
            <span className="shot-card-running">
              <Loader2 size={12} className="shot-split-spinner" />
              拆分中
            </span>
          ) : split?.failure ? (
            <button
              type="button"
              className="nodrag"
              title={split.failure}
              onClick={() => openBoard(id)}
            >
              拆分失败
            </button>
          ) : data.storyboard?.length ? (
            <ShotStats shots={data.storyboard} />
          ) : data.uploadProgress !== undefined || data.uploadFailed ? (
            <span
              className="canvas-upload-label"
              data-failed={data.uploadProgress === undefined || data.uploadInterrupted || undefined}
            >
              {data.uploadProgress === undefined || data.uploadInterrupted
                ? "上传失败"
                : `上传中 ${data.uploadProgress}%`}
            </span>
          ) : textRunning ? (
            <span className="canvas-text-running-label">生成中</span>
          ) : data.textStatus === "error" ? (
            <span className="canvas-text-error-label">生成失败</span>
          ) : shownJob && imageStatus ? (
            <span
              className={ordinaryJob ? "canvas-task-label" : "character-task-label"}
              data-task={shownJob.status}
            >
              {imageStatus}
              {imageProgress(shownJob) !== undefined && ` ${imageProgress(shownJob)}%`}
            </span>
          ) : undefined
        }
      />
      {(data.framePending || data.splitPending) && (
        <div className="node-media frame-pending" role="status">
          <span>{data.splitPending ? "正在切分…" : "正在截取…"}</span>
          <progress aria-label={data.splitPending ? "正在切分" : "正在截取"} />
        </div>
      )}
      {data.character && target && actions && (
        <CharacterCardBody
          character={data.character}
          voiceAssetName={
            media?.assets.find((item) => item.assetId === data.character?.voice?.assetId)
              ?.displayName
          }
          projectHandle={media?.projectHandle}
          mainId={asset?.assetId}
          aspect={imageFrame ? imageFrame.width / imageFrame.height : 16 / 9}
          disabled={actions.busy}
          voicePending={actions.voicePending(id)}
          edit={() => actions.editCharacter(id)}
          imageJob={imageJob}
          taskAction={async () => {
            if (imageJob) await actions.actOnTask(imageJob, true);
          }}
          upload={() => actions.upload(target)}
          library={(extra) => actions.library({ ...target, extra })}
        />
      )}
      {(data.uploadProgress !== undefined || data.uploadFailed) && (
        <CanvasUploadBody
          id={id}
          progress={data.uploadProgress}
          interrupted={data.uploadInterrupted}
        />
      )}
      {ordinaryJob && actions && (
        <div className="node-media canvas-upload-body" data-kind={data.kind}>
          <MediaGenerationTask
            key={ordinaryJob.id}
            job={ordinaryJob}
            disabled={actions.busy || !!retryHint}
            retryHint={retryHint}
            action={() => actions.actOnTask(ordinaryJob)}
          />
        </div>
      )}
      {!ordinaryJob &&
        !data.character &&
        data.uploadProgress === undefined &&
        !data.uploadFailed &&
        !data.framePending &&
        !data.splitPending &&
        data.kind !== "script" && (
          <NodeAsset key={data.assetId} assetId={data.assetId} kind={data.kind} selected={selected}>
            {target &&
              actions &&
              !actions.running(id) &&
              !data.assetId &&
              !data.outputs?.length && (
                <MediaFillActions
                  disabled={actions.busy}
                  upload={() => actions.upload(target)}
                  library={() => actions.library(target)}
                />
              )}
          </NodeAsset>
        )}
      {data.storyboard && (
        <div>
          {data.storyboard.length ? (
            <ShotCardPreview shots={data.storyboard} running={split?.running} />
          ) : split?.running ? (
            <div className="shot-card-thumbs shot-card-skeleton" aria-busy="true">
              {[0, 1, 2, 3, 4].map((index) => (
                <div key={index} />
              ))}
            </div>
          ) : (
            <div className="shot-card-empty">
              <StoryboardPlaceholder />
              <span>还没有镜头</span>
              <div>
                <span title={split?.reason || undefined}>
                  <button
                    type="button"
                    className="nodrag nopan"
                    disabled={!!split?.reason || writing}
                    onClick={async () => {
                      setSplitError("");
                      try {
                        setSplitError((await split?.start()) ?? "");
                      } catch {
                        setSplitError("暂时无法提交拆镜任务，请稍后重试。");
                      }
                    }}
                  >
                    从剧本拆分镜
                  </button>
                </span>
                <button
                  type="button"
                  className="nodrag nopan"
                  disabled={writing}
                  onClick={() => {
                    const shot = newShot(crypto.randomUUID());
                    updateNodeData(id, { storyboard: [shot] });
                    openBoard(id, shot.id);
                  }}
                >
                  <Plus size={16} />
                  添加镜头
                </button>
              </div>
              {splitError && <small role="alert">{splitError}</small>}
            </div>
          )}
        </div>
      )}
      {data.director && (
        <DirectorNodeBody
          scene={data.director}
          thumbnail={thumbnail}
          enter={() => actions?.enterDirector(id)}
          disabled={writing}
        />
      )}
      {data.kind === "script" && !data.storyboard && !data.director && (
        <div className="canvas-text-frame">
          <section
            className={
              textRunning
                ? "canvas-text-preview canvas-text-running"
                : data.textStatus === "error"
                  ? "canvas-text-preview canvas-text-error"
                  : data.text
                    ? "canvas-text-preview nowheel"
                    : "canvas-text-preview"
            }
            role={!textRunning && data.textStatus === "error" ? "alert" : undefined}
            aria-label={`${data.label}内容`}
            title={textRunning ? undefined : "双击编辑"}
            data-node-id={id}
            onDoubleClick={(event) => {
              event.stopPropagation();
              if (!textRunning) openText(id);
            }}
          >
            {textRunning ? (
              <>
                <Loader2 size={16} />
                生成中…
              </>
            ) : data.textStatus === "error" ? (
              <>
                <span className="canvas-text-error-message">
                  <TriangleAlert size={16} />
                  <span>{data.textError ?? "生成失败"}</span>
                </span>
                {data.textFailureTask && (
                  <TextFailureTask reference={data.textFailureTask.reference} />
                )}
              </>
            ) : data.text ? (
              <CanvasTextMarkdown text={data.text} />
            ) : (
              <div className="text-empty" role="img" aria-label="双击输入文字">
                <svg
                  width="40"
                  height="40"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <rect x="3" y="6" width="18" height="2.4" rx="1.2" />
                  <rect x="3" y="10.8" width="18" height="2.4" rx="1.2" />
                  <rect x="3" y="15.6" width="11" height="2.4" rx="1.2" />
                </svg>
                <span>双击输入文字</span>
              </div>
            )}
          </section>
        </div>
      )}
      {!visual && data.kind !== "script" && !data.storyboard && !data.director && (
        <label className="node-body nodrag nopan">
          <span className="sr-only">{data.label}内容</span>
          <textarea
            value={data.text}
            readOnly={writing}
            onChange={(event) => {
              updateNodeData(id, {
                text: event.target.value,
                activeOutputId: undefined,
              });
            }}
            aria-label={`${data.label}内容`}
            placeholder="描述你希望生成的内容…"
            data-node-id={id}
            maxLength={32768}
          />
        </label>
      )}
      {data.assetId && !data.character && data.kind !== "video" && data.kind !== "audio" && (
        <footer>
          <button
            type="button"
            className="nodrag"
            disabled={writing}
            onClick={() => {
              updateNodeData(id, { assetId: undefined });
            }}
          >
            解除素材引用
          </button>
        </footer>
      )}
      <NodePort type="source" hidden={!!data.director} />
    </motion.article>
  );
}

function GroupCard(props: NodeProps<Extract<FlowNode, { type: "group" }>>) {
  const writing = useContext(NodeMedia)?.writing;
  return <GroupNodeCard {...props} writing={writing} />;
}

function CompatibilityCard({ data }: NodeProps<Extract<FlowNode, { type: "unknown" }>>) {
  return (
    <article className="creative-card compatibility-card">
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <strong>{data.label}</strong>
      <span>兼容节点 · 只读</span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </article>
  );
}

const nodeTypes = { creative: CreativeCard, group: GroupCard, unknown: CompatibilityCard };
const edgeTypes = { default: CanvasEdge };

function flowOrder(nodes: FlowNode[]) {
  return [
    ...nodes.filter((node) => node.type === "group"),
    ...nodes.filter((node) => node.type !== "group"),
  ];
}

function flowNodes(canvas: ProjectCanvasView): FlowNode[] {
  const locked = new Set(
    canvas.edges.filter((edge) => edge.readOnly).flatMap(({ source, target }) => [source, target]),
  );
  const parents = new Set(
    canvas.nodes.flatMap((node) =>
      node.type === "unknown" && node.parentId ? [node.parentId] : [],
    ),
  );
  return flowOrder(
    canvas.nodes.map((node) => {
      if (node.type === "unknown")
        return { ...node, draggable: false, deletable: false, connectable: false };
      if (node.type === "group")
        return {
          ...node,
          draggable: !parents.has(node.id),
          zIndex: -2000,
          deletable: !parents.has(node.id),
          connectable: false,
        };
      return { ...node, deletable: !locked.has(node.id) };
    }),
  );
}

function selectedIds(items: readonly { id: string; selected?: boolean }[]) {
  return new Set(items.filter((item) => item.selected).map((item) => item.id));
}

function flowEdges(canvas: ProjectCanvasView, selected?: ReadonlySet<string>): FlowEdge[] {
  return canvas.edges.map(({ readOnly, ...edge }) => ({
    ...edge,
    ...(readOnly ? { deletable: false, data: { readOnly } } : {}),
    ...(selected?.has(edge.id) ? { selected: true } : {}),
  }));
}

function RuntimePanel() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inspect = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await window.desktop.app.getInfo();
      if (result.ok && isAppInfo(result.data)) setInfo(result.data);
      else setError(result.ok ? "桌面返回的数据格式无效" : result.error.message);
    } catch {
      setError("未连接桌面宿主，请使用桌面应用启动。");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void inspect();
  }, [inspect]);

  return (
    <section className="runtime-panel">
      <div className="panel-title">
        <Cpu size={18} />
        <h2>运行环境</h2>
      </div>
      <p className="muted">通过受限桌面接口读取当前应用信息。</p>
      {loading && <p role="status">正在检查…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {info && (
        <>
          <div className="connection-status">
            <Check size={15} />
            桌面连接正常
          </div>
          <dl>
            <div>
              <dt>应用</dt>
              <dd>
                {info.productName} {info.version}
              </dd>
            </div>
            <div>
              <dt>平台</dt>
              <dd>
                {info.platform} / {info.arch}
              </dd>
            </div>
            <div>
              <dt>Electron</dt>
              <dd>{info.electron}</dd>
            </div>
            <div>
              <dt>Chromium</dt>
              <dd>{info.chromium}</dd>
            </div>
            <div>
              <dt>Node.js</dt>
              <dd>{info.node}</dd>
            </div>
          </dl>
        </>
      )}
      <button
        type="button"
        className="secondary-button"
        disabled={loading}
        onClick={() => void inspect()}
      >
        重新检查
      </button>
    </section>
  );
}

export function App() {
  const [viewPreferences, changeViewPreferences, viewPreferenceError] = useCanvasViewPreferences();
  const [showSettings, setShowSettings] = useState(false);
  const [dramaHandle, setDramaHandle] = useState("");
  const [canvasHost] = useState(() => document.createElement("div"));
  const normalCanvasSlot = useRef<HTMLDivElement>(null);
  const [dramaCanvasSlot, setDramaCanvasSlot] = useState<HTMLDivElement | null>(null);
  const [withDramaAssistant, setWithDramaAssistant] = useState(false);
  const settingsPage = (renderFilingPicker?: RenderFilingPicker) =>
    showSettings && (
      <SettingsPage
        returnLabel={projectSession ? `返回${projectSession.name}` : "返回首页"}
        preferences={viewPreferences}
        changePreferences={changeViewPreferences}
        preferenceError={viewPreferenceError}
        diagnostic={<RuntimePanel />}
        close={() => setShowSettings(false)}
        renderFilingPicker={renderFilingPicker}
      />
    );
  const [nodes, setNodes, applyNodeChanges] = useNodesState<FlowNode>([]);
  const liveNodes = useRef(nodes);
  liveNodes.current = nodes;
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [pointerDragging, setDragging] = useState(false);
  const [arrangement, setArrangement] = useState<ReadonlyMap<string, Point>>();
  const cancelArrangement = useRef<() => void>(undefined);
  const dragging = pointerDragging || Boolean(arrangement);
  const displayedNodes = useMemo(
    () =>
      arrangement
        ? nodes.map((node) => {
            const position = arrangement.get(node.id);
            return position ? { ...node, position, dragging: true } : node;
          })
        : nodes,
    [arrangement, nodes],
  );
  const [alignmentGuidesState, setAlignmentGuidesState] = useState<Guide[]>([]);
  const alignmentSession = useRef<{
    nodeId: string;
    start: Point;
    rect: Rect;
    targets: SnapTarget[];
    rects: Map<string, Rect>;
    locks: { x?: AxisLock; y?: AxisLock };
    lastDelta: Point;
  } | null>(null);
  const { sidePanel, setSidePanel } = useWorkspace();
  const [handTool, setHand] = useState(false);
  const [sweepMode, setSweepMode] = useState(false);
  const [sweepPoints, setSweepPoints] = useState<Point[]>([]);
  const [showMap, setShowMap] = useState(false);
  const [addMenu, setAddMenu] = useState<{
    toolbar?: boolean;
    anchor: Point;
    position: Point;
    pending?: PendingLink;
    fan?: Fan;
  }>();
  const [assetPlacement, setAssetPlacement] = useState<Point | { target: VisualMediaTarget }>();
  const [assetBatchNotice, setAssetBatchNotice] = useState<{ count: number }>();
  useEffect(() => {
    if (!assetBatchNotice) return;
    const timer = setTimeout(() => setAssetBatchNotice(undefined), 3500);
    return () => clearTimeout(timer);
  }, [assetBatchNotice]);
  const [assetTarget, setAssetTarget] = useState<VisualMediaTarget>();
  const [enrollAsset, setEnrollAsset] = useState<ProjectAsset>();
  const [newLibraryFolder, setNewLibraryFolder] = useState(false);
  const [manageLibrary, setManageLibrary] = useState(false);
  const [libraryNode, setLibraryNode] = useState<{
    nodeId: string;
    assetId: string;
    handle: string;
  }>();
  const [stripNotice, setStripNotice] = useState<{ handle: string; message: string }>();
  useEffect(() => {
    if (!stripNotice) return;
    const timer = setTimeout(() => setStripNotice(undefined), 3000);
    return () => clearTimeout(timer);
  }, [stripNotice]);
  const [paneMoving, setPaneMoving] = useState(false);
  const [libraryNotice, setLibraryNotice] = useState<{ handle: string }>();
  useEffect(() => {
    if (!libraryNotice) return;
    const timer = setTimeout(() => setLibraryNotice(undefined), 3500);
    return () => clearTimeout(timer);
  }, [libraryNotice]);
  const [enrollNotice, setEnrollNotice] = useState("");
  const canvasArea = useRef<HTMLElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadPlacement = useRef<{ target: DropPlacement; projectHandle: string } | null>(null);
  const [petStage, setPetStage] = useState<HTMLDivElement | null>(null);
  const [fileOver, setFileOver] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [projectSession, setProjectSession] = useState<ProjectSession | null>(null);
  const temporaryHand = useTemporaryHand(
    canvasArea,
    !!projectSession && !showSettings && dramaHandle !== projectSession.projectHandle,
  );
  const hand = handTool || temporaryHand;
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [dramaTabs, setDramaTabs] = useState<string[]>([]);
  const [activeRecentId, setActiveRecentId] = useState<string>();
  const flushDrama = useRef<(() => Promise<boolean>) | null>(null);
  const [projectError, setProjectError] = useState("");
  const [projectBusy, setProjectBusy] = useState(false);
  const [readonlyView, setReadonlyView] = useState<ReadonlyView>();
  const [activation, setActivation] = useState<ProjectActivation>();
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const projectHandle = projectSession?.projectHandle;
  useEffect(
    () => () => {
      if (projectHandle) stopCharacterVoice(projectHandle);
    },
    [projectHandle],
  );
  useLayoutEffect(() => {
    const parent = dramaCanvasSlot ?? normalCanvasSlot.current;
    if (parent) parent.append(canvasHost);
    return () => canvasHost.remove();
  }, [canvasHost, dramaCanvasSlot, projectHandle]);
  const currentProjectHandle = useRef(projectHandle);
  currentProjectHandle.current = projectHandle;
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [jobsLoadedFor, setJobsLoadedFor] = useState<string>();
  const assetJobs = useMemo(() => {
    const grouped = new Map<string, GenerationJob[]>();
    for (const job of jobs) {
      const group = grouped.get(job.nodeId);
      if (group) group.push(job);
      else grouped.set(job.nodeId, [job]);
    }
    return grouped;
  }, [jobs]);
  const stats = useMemo(() => {
    const byNode = new Map<string, GenerationJob[]>();
    for (const job of jobs) {
      const group = byNode.get(job.nodeId);
      if (group) group.push(job);
      else byNode.set(job.nodeId, [job]);
    }
    const failed: string[] = [];
    for (const node of nodes) {
      if (node.type !== "creative") continue;
      const data = node.data,
        history = byNode.get(node.id) ?? [];
      const job = data.character
        ? history.find((item) => item.kind === "image")
        : data.storyboard
          ? history.find((item) => item.purpose === "storyboard-split")
          : mediaNodeJob(history, node.id, data);
      const textFailed =
        data.textStatus === "error" &&
        !history.some(
          (item) => item.kind === "text" && !item.purpose && !jobIsTerminal(item.status),
        );
      if (textFailed || data.uploadFailed || data.uploadInterrupted || job?.status === "failed")
        failed.push(node.id);
    }
    return { nodeCount: nodes.filter((node) => node.type !== "group").length, failed };
  }, [nodes, jobs]);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const [splitHighlights, setSplitHighlights] = useState<Record<string, string[]>>({});
  const [splitNotice, setSplitNotice] = useState<{ count: number; board: string }>();
  const [queueNotice, setQueueNotice] = useState<{ count: number }>();
  useEffect(() => {
    if (!queueNotice) return;
    const timer = setTimeout(() => setQueueNotice(undefined), 5000);
    return () => clearTimeout(timer);
  }, [queueNotice]);
  function showSubmissionWarning(submitted: GenerationJob[]) {
    const count = submitted.reduce((total, job) => total + (job.unsubmittedCount ?? 0), 0);
    if (count) setQueueNotice({ count });
  }
  useEffect(() => {
    if (!splitNotice) return;
    const timer = setTimeout(() => setSplitNotice(undefined), 4000);
    return () => clearTimeout(timer);
  }, [splitNotice]);
  const busyGenerationTargets = useMemo(
    () => new Set(jobs.filter((job) => !jobIsTerminal(job.status)).map((job) => job.nodeId)),
    [jobs],
  );
  const runningEdgeTargets = useMemo(() => resolveRunningEdgeTargets(nodes, jobs), [nodes, jobs]);
  const pendingVoiceNodes = useMemo(
    () =>
      new Set(
        jobs
          .filter((job) => job.purpose === "character-voice" && !jobIsTerminal(job.status))
          .map((job) => job.nodeId),
      ),
    [jobs],
  );
  const runningReferenceNodes = useMemo(
    () =>
      jobs.some((job) => job.purpose === "character-voice" && !jobIsTerminal(job.status))
        ? resolveRunningEdgeTargets(
            nodes,
            jobs.filter((job) => job.purpose !== "character-voice"),
          )
        : runningEdgeTargets,
    [nodes, jobs, runningEdgeTargets],
  );
  const [generationNodeId, setGenerationNodeId] = useState<string>();
  const [placedGenerationId, setPlacedGenerationId] = useState<string>();
  const [versionNodeId, setVersionNodeId] = useState<string>();
  const mediaForm = useRef<HTMLFormElement>(null);
  const [mountedDraft, setMountedDraft] = useState<{ id: string; reason?: string }>();
  const [catalogRevision, setCatalogRevision] = useState(0);
  const generationProviders = useGenerationProviders(
    !!projectSession && !showSettings,
    catalogRevision,
  );
  const preferenceModels = useMemo(
    () => canvasModelGroups(generationProviders),
    [generationProviders],
  );
  const newNodeModel = (kind: LinkKind) =>
    defaultNodeGeneration(kind, viewPreferences.defaultModels, preferenceModels);
  const [importing, setImporting] = useState(false);
  const [importMode, setImportMode] = useState<ProjectAsset["importMode"]>("copy");
  const [activeImport, setActiveImport] = useState<{
    id: string;
    name: string;
    status: ImportStatus;
    nodeId?: string;
  } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [preview, setPreview] = useState<{ asset: ProjectAsset; url: string } | null>(null);
  const [canvasPreview, setCanvasPreview] = useState<{ id: string; origin?: Point }>();
  const previewOpen = !!canvasPreview;
  const previewItems = useMemo(
    () => (previewOpen ? collectCanvasPreviews(nodes, assets) : []),
    [previewOpen, nodes, assets],
  );
  const startCanvasPreview = (node: FlowNode) => {
    if (
      node.type !== "creative" ||
      !canvasPreviewItem(
        node,
        assets.find((asset) => asset.assetId === node.data.assetId),
      )
    )
      return;
    document.querySelectorAll<HTMLVideoElement>(".react-flow__node video").forEach((video) => {
      video.pause();
    });
    const rect = document
      .querySelector(`.react-flow__node[data-id="${CSS.escape(node.id)}"]`)
      ?.getBoundingClientRect();
    setCanvasPreview({
      id: node.id,
      origin: rect && { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    });
  };
  const [compositionOpen, setCompositionOpen] = useState(false);
  const [splitTarget, setSplitTarget] = useState<{
    nodeId: string;
    asset: ProjectAsset;
    rows: number;
    columns: number;
  }>();
  const [splitError, setSplitError] = useState("");
  const [doodleTarget, setDoodleTarget] = useState<{
    nodeId: string;
    asset: ProjectAsset;
    url: string;
  }>();
  const [doodleError, setDoodleError] = useState("");
  useEffect(() => {
    if (!doodleTarget) return;
    const selectedNodes = nodes.filter((node) => node.selected);
    if (selectedNodes.length !== 1 || selectedNodes[0]?.id !== doodleTarget.nodeId)
      setDoodleTarget(undefined);
  }, [nodes, doodleTarget]);
  const [characterNodeId, setCharacterNodeId] = useState<string>();
  const [textNodeId, setTextNodeId] = useState<string>();
  const [renamingId, setRenamingId] = useState<string>();
  const [groupMenuId, setGroupMenuId] = useState<string>();
  const [draggedGroupId, setDraggedGroupId] = useState<string>();
  const confirmDeleteGroup = useRef<HTMLButtonElement>(null);
  const [deleteGroupRequest, setDeleteGroupRequest] = useState<{
    name: string;
    members: number;
    resolve: (confirmed: boolean) => void;
  }>();
  const [storyboardNodeId, setStoryboardNodeId] = useState<string>();
  const firstShotFocus = useRef<string | undefined>(undefined);
  const [directorNodeId, setDirectorNodeId] = useState<string>();
  const [outpaintTarget, setOutpaintTarget] = useState<typeof doodleTarget>();
  const [outpaintBusy, setOutpaintBusy] = useState(false);
  const [outpaintError, setOutpaintError] = useState("");
  const outpaintAttempt = useRef<{
    assetOperationId: string;
    canvasOperationId: string;
    jobId: string;
    nodeId: string;
    referenceId?: string;
    canvasWrite?: { expectedCanvasRevision: number; operations: CanvasOperation[] };
    generation?: GenerationInput;
  }>(undefined);
  const [frameTarget, setFrameTarget] = useState<{
    nodeId?: string;
    asset: ProjectAsset;
    url: string;
  }>();
  const [frameError, setFrameError] = useState("");
  const [pendingFrame, setPendingFrame] = useState<{ node: CreativeNode; edge: FlowEdge }>();
  const [pendingGrid, setPendingGrid] = useState<{ nodes: CreativeNode[]; edges: FlowEdge[] }>();
  const extractingFrame = useRef(false);
  const [trimTarget, setTrimTarget] = useState<{
    asset: ProjectAsset;
    nodeId: string;
    url: string;
  }>();
  const [trimBusy, setTrimBusy] = useState(false);
  const [mediaOperationId, setMediaOperationId] = useState<string>();
  const [mediaCancelling, setMediaCancelling] = useState(false);
  const cancelMediaTool = async () => {
    if (!projectHandle || !mediaOperationId || mediaCancelling) return;
    setMediaCancelling(true);
    try {
      await window.desktop.projects.cancelMediaTool({
        projectHandle,
        operationId: mediaOperationId,
      });
    } catch {
      setMediaCancelling(false);
    }
  };
  const [viewport, setViewport] = useState(initialViewport);
  const [canvasMount, setCanvasMount] = useState(0);
  useEffect(() => {
    setArrangement(undefined);
    return () => {
      cancelArrangement.current?.();
      cancelArrangement.current = undefined;
    };
  }, [projectHandle, canvasMount]);
  const flowInstance = useRef<ReactFlowInstance<FlowNode, FlowEdge> | null>(null);
  const [writing, setWriting] = useState(false);
  const [voicePick, setVoicePick] = useState<{
    validate: (asset: ProjectAsset) => string | undefined;
    apply: (asset: ProjectAsset) => void;
  }>();
  const [exchangeStage, setExchangeStage] = useState("");
  const exportAttempt = useRef<AbortController | null>(null);
  useEffect(() => () => exportAttempt.current?.abort(), [projectHandle]);
  const assetBatchLock = useRef(false);
  const [assetBatchBusy, setAssetBatchBusy] = useState(false);
  useEffect(() => {
    if (!outpaintTarget || outpaintBusy || writing || outpaintAttempt.current?.canvasWrite) return;
    const selected = nodes.filter((node) => node.selected);
    if (
      selected.length !== 1 ||
      selected[0]?.type !== "creative" ||
      selected[0].id !== outpaintTarget.nodeId ||
      selected[0].data.assetId !== outpaintTarget.asset.assetId
    )
      setOutpaintTarget(undefined);
  }, [outpaintTarget, outpaintBusy, nodes, writing]);
  useEffect(() => {
    if (!splitTarget || writing) return;
    const selected = nodes.filter((node) => node.selected);
    const current = selected[0];
    if (
      selected.length !== 1 ||
      current?.id !== splitTarget.nodeId ||
      current.type !== "creative" ||
      current.data.assetId !== splitTarget.asset.assetId
    )
      setSplitTarget(undefined);
  }, [splitTarget, writing, nodes]);
  useEffect(() => {
    if (!frameTarget?.nodeId || writing) return;
    const selected = nodes.filter((node) => node.selected);
    if (
      selected.length !== 1 ||
      selected[0]?.id !== frameTarget.nodeId ||
      selected[0]?.type !== "creative" ||
      selected[0].data.assetId !== frameTarget.asset.assetId
    )
      setFrameTarget(undefined);
  }, [nodes, frameTarget, writing]);
  const nodeMedia = useMemo(
    () =>
      projectHandle
        ? {
            assets,
            projectHandle,
            writing,
            models: {
              image: nodeModels(generationProviders, "image"),
              video: nodeModels(generationProviders, "video"),
            },
          }
        : null,
    [assets, projectHandle, writing, generationProviders],
  );
  const [recoveryError, setRecoveryError] = useState("");
  const transientUploads = useMemo(
    () =>
      new Set(
        nodes
          .filter((node) => node.type === "creative" && node.data.uploadProgress !== undefined)
          .map((node) => node.id),
      ),
    [nodes],
  );
  const assetProgress = useMemo(
    () =>
      new Map(
        nodes.flatMap((node) =>
          node.type === "creative" && node.data.uploadProgress !== undefined
            ? [
                [
                  node.id,
                  node.data.uploadInterrupted ? ("interrupted" as const) : node.data.uploadProgress,
                ] as const,
              ]
            : [],
        ),
      ),
    [nodes],
  );
  const uploadingNodes = nodes.some(
    (node) =>
      node.type === "creative" &&
      node.data.uploadProgress !== undefined &&
      !node.data.uploadInterrupted,
  );
  const historyCanvas: ProjectCanvasView = useMemo(
    () => ({
      nodes: nodes.map((node) => {
        const {
          id,
          position: { x, y },
          type,
        } = node;
        const shared = { id, position: { x, y } };
        if (type === "group")
          return {
            ...shared,
            type,
            width: node.width ?? 320,
            height: node.height ?? 240,
            data: { ...node.data },
          };
        const parent = node.parentId ? { parentId: node.parentId } : {};
        if (type === "unknown")
          return { ...shared, ...parent, type, data: { label: node.data.label } };
        const {
          kind,
          label,
          text,
          assetId,
          outputs,
          manualReferenceIds,
          mediaAspect,
          generation,
          videoDuration,
          videoMode,
          activeOutputId,
          uploaded,
          character,
          drama,
          storyboard,
          shotId,
          director,
        } = node.data;
        return {
          ...shared,
          ...parent,
          type,
          data: {
            kind,
            label,
            text,
            ...(assetId ? { assetId } : {}),
            ...(uploaded ? { uploaded } : {}),
            ...(node.data.uploadFailed && { uploadFailed: true as const }),
            ...(node.data.textStatus && { textStatus: node.data.textStatus }),
            ...(node.data.textStatus === "error" &&
              node.data.textError !== undefined && { textError: node.data.textError }),
            ...(node.data.textStatus === "error" &&
              node.data.textFailureTask && {
                textFailureTask: node.data.textFailureTask,
              }),
            ...(transientUploads.has(id) && { uploadPending: true as const }),
            ...(outputs ? { outputs } : {}),
            ...(manualReferenceIds?.length ? { manualReferenceIds } : {}),
            ...(mediaAspect !== undefined && { mediaAspect }),
            ...(generation && { generation }),
            ...(videoDuration && { videoDuration }),
            ...(videoMode && { videoMode }),
            ...(activeOutputId ? { activeOutputId } : {}),
            ...(node.data.pendingMediaVersion && {
              pendingMediaVersion: node.data.pendingMediaVersion,
            }),
            ...(character ? { character } : {}),
            ...(drama && { drama }),
            ...(storyboard ? { storyboard } : {}),
            ...(shotId ? { shotId } : {}),
            ...(director ? { director } : {}),
            ...(director &&
              node.data.directorThumbnailId && {
                directorThumbnailId: node.data.directorThumbnailId,
              }),
          },
        };
      }),
      edges: edges.map(({ id, source, target, data }) => ({
        id,
        source,
        target,
        ...(data?.readOnly ? { readOnly: true } : {}),
      })),
      viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom },
    }),
    [nodes, edges, viewport, transientUploads],
  );
  const canvas: ProjectCanvasView = useMemo(
    () =>
      transientUploads.size
        ? {
            ...historyCanvas,
            nodes: historyCanvas.nodes.filter((node) => !transientUploads.has(node.id)),
            edges: historyCanvas.edges.filter(
              (edge) => !transientUploads.has(edge.source) && !transientUploads.has(edge.target),
            ),
          }
        : historyCanvas,
    [historyCanvas, transientUploads],
  );
  const updateRevision = useCallback((projectHandle: string, revision: number) => {
    setProjectSession((current) =>
      current?.projectHandle === projectHandle && revision > current.revision
        ? { ...current, revision }
        : current,
    );
  }, []);
  const uploadCallbacks: Parameters<typeof useCanvasUploads>[1] = {
    progress: (id, percent) =>
      setNodes((current) =>
        current.map((node) =>
          node.id === id && node.type === "creative" && node.data.uploadProgress !== percent
            ? { ...node, data: { ...node.data, uploadProgress: percent } }
            : node,
        ),
      ),
    failed: (id) =>
      setNodes((current) =>
        current.map((node) =>
          node.id === id && node.type === "creative"
            ? {
                ...node,
                data: {
                  ...node.data,
                  uploadProgress: undefined,
                  uploadFailed: node.data.character ? undefined : true,
                },
              }
            : node,
        ),
      ),
    remove: (id) => setNodes((current) => current.filter((node) => node.id !== id)),
    done: (id, asset, revision) => {
      if (!projectHandle) return;
      updateRevision(projectHandle, revision);
      setAssets((current) => [asset, ...current.filter((item) => item.assetId !== asset.assetId)]);
      setNodes((current) =>
        current.map((node) => {
          if (node.id !== id || node.type !== "creative") return node;
          const data = node.data.character
            ? node.data.assetId || node.data.outputs?.length
              ? node.data
              : bindNodeMedia(node.data, asset.assetId)
            : { ...node.data, kind: asset.mediaType, assetId: asset.assetId };
          return { ...node, data: { ...data, uploadFailed: undefined, uploadProgress: undefined } };
        }),
      );
    },
  };
  const canvasUploads = useCanvasUploads(projectHandle, uploadCallbacks);
  const doodleUploads = useDoodleUploads(projectHandle, {
    ...uploadCallbacks,
    remove: (id) => {
      uploadCallbacks.remove(id);
      setEdges((current) => current.filter((edge) => edge.source !== id && edge.target !== id));
    },
  });
  const forgetUpload = (id: string) => {
    canvasUploads.forget(id);
    doodleUploads.forget(id);
  };
  const forgetRemovedUpload = useEffectEvent(forgetUpload);
  const previousUploadIds = useRef<string[]>([]);
  useLayoutEffect(() => {
    const ids = nodes
      .filter(
        (node) =>
          node.type === "creative" &&
          (node.data.uploadProgress !== undefined || node.data.uploadFailed),
      )
      .map((node) => node.id);
    for (const id of previousUploadIds.current) if (!ids.includes(id)) forgetRemovedUpload(id);
    previousUploadIds.current = ids;
  }, [nodes]);
  const persistence = useCanvasSave(
    projectSession,
    canvas,
    dragging,
    importing || writing,
    updateRevision,
  );
  const { dirty, saving, error: saveError, save: saveCanvas } = persistence;
  const closeCanvas = useRef<() => Promise<boolean>>(async () => true);
  closeCanvas.current = async () => {
    if (!projectSession) return true;
    if (importing || uploadingNodes || writing || dragging) {
      setProjectError("请完成当前操作后关闭窗口");
      return false;
    }
    if (flushDrama.current && !(await flushDrama.current())) return false;
    setWriting(true);
    const saved = await saveCanvas(projectSession);
    if (!saved) setWriting(false);
    return Boolean(saved);
  };
  useEffect(() => window.desktop.canvasWindow.onSaveBeforeClose(() => closeCanvas.current()), []);
  useEffect(() => {
    window.desktop.canvasWindow.setPending(
      Boolean(
        projectSession &&
          (dramaHandle === projectSession.projectHandle ||
            dirty ||
            saving ||
            importing ||
            uploadingNodes ||
            writing ||
            dragging),
      ),
    );
  }, [projectSession, dramaHandle, dirty, saving, importing, uploadingNodes, writing, dragging]);
  const restoreCanvas = (next: ProjectCanvasView) => {
    setNodes(flowNodes(next));
    setEdges(flowEdges(next));
    setViewport(next.viewport);
  };
  const historySelection = useMemo(
    () => ({ nodes: selectedIds(nodes), edges: selectedIds(edges) }),
    [nodes, edges],
  );
  const history = useCanvasHistory(
    historyCanvas,
    (next, selection) => {
      const live = new Map(nodes.map((node) => [node.id, node]));
      setNodes(
        flowNodes(next).map((node) => {
          const old = live.get(node.id);
          const view = {
            selected: selection?.nodes.has(node.id) ?? false,
            measured: old?.type === node.type ? old.measured : undefined,
          };
          if (node.type === "creative" && "uploadPending" in node.data) {
            const { uploadPending: _pending, ...data } = node.data;
            const progress = old?.type === "creative" ? old.data.uploadProgress : undefined;
            return {
              ...node,
              ...view,
              data: {
                ...data,
                uploadProgress: progress ?? 0,
                uploadInterrupted:
                  progress === undefined ||
                  (old?.type === "creative" && old.data.uploadInterrupted),
              },
            };
          }
          return { ...node, ...view };
        }),
      );
      setEdges(flowEdges(next, selection?.edges));
      setViewport(next.viewport);
    },
    dragging,
    jobs,
    historySelection,
  );
  const absoluteNodeRect = (node: FlowNode, source = nodes): Rect | undefined => {
    if (node.type !== "creative") return undefined;
    const parent = node.parentId ? source.find((item) => item.id === node.parentId) : undefined;
    return {
      x: node.position.x + (parent?.position.x ?? 0),
      y: node.position.y + (parent?.position.y ?? 0),
      width: node.measured?.width ?? 280,
      height: node.measured?.height ?? 200,
    };
  };
  const onNodeDragStart = (_event: unknown, node: FlowNode, dragged: FlowNode[]) => {
    if (node.type === "group") setDraggedGroupId(node.id);
    if (dragged.length !== 1) return;
    const rect = absoluteNodeRect(node);
    if (!rect) return;
    const targets: SnapTarget[] = [];
    const rects = new Map<string, Rect>();
    for (const candidate of nodes) {
      if (candidate.id === node.id) continue;
      const candidateRect = absoluteNodeRect(candidate);
      if (!candidateRect) continue;
      targets.push({ id: candidate.id, rect: candidateRect });
      rects.set(candidate.id, candidateRect);
    }
    alignmentSession.current = {
      nodeId: node.id,
      start: { ...node.position },
      rect,
      targets,
      rects,
      locks: {},
      lastDelta: { x: 0, y: 0 },
    };
  };
  const adjustAlignmentChanges = (changes: NodeChange<FlowNode>[]) => {
    const session = alignmentSession.current;
    const change = changes.find(
      (item): item is Extract<NodeChange<FlowNode>, { type: "position" }> =>
        item.type === "position" && item.id === session?.nodeId && Boolean(item.position),
    );
    if (!session || !change?.position) return changes;
    const position = change.position;
    if (change.dragging === false) {
      setAlignmentGuidesState([]);
      return changes.map((item) =>
        item === change
          ? {
              ...change,
              position: {
                x: position.x + session.lastDelta.x,
                y: position.y + session.lastDelta.y,
              },
            }
          : item,
      );
    }
    const zoom = flowInstance.current?.getZoom() ?? 1;
    const moving: Rect = {
      ...session.rect,
      x: session.rect.x + position.x - session.start.x,
      y: session.rect.y + position.y - session.start.y,
    };
    const x = findAxisSnap(
      moving,
      session.targets,
      "x",
      ALIGN_ENTER_PX / zoom,
      ALIGN_RELEASE_PX / zoom,
      session.locks.x,
    );
    const y = findAxisSnap(
      moving,
      session.targets,
      "y",
      ALIGN_ENTER_PX / zoom,
      ALIGN_RELEASE_PX / zoom,
      session.locks.y,
    );
    session.locks = { x: x?.lock, y: y?.lock };
    session.lastDelta = { x: x?.delta ?? 0, y: y?.delta ?? 0 };
    const snapped = {
      ...moving,
      x: moving.x + session.lastDelta.x,
      y: moving.y + session.lastDelta.y,
    };
    setAlignmentGuidesState(
      (
        [
          ["x", x],
          ["y", y],
        ] as const
      ).flatMap(([axis, snap]) => {
        const target = snap ? session.rects.get(snap.lock.targetId) : undefined;
        return target ? alignmentGuides(snapped, target, axis) : [];
      }),
    );
    return changes.map((item) =>
      item === change
        ? {
            ...change,
            position: {
              x: position.x + session.lastDelta.x,
              y: position.y + session.lastDelta.y,
            },
          }
        : item,
    );
  };
  const highlightGroupTargets = (targets: Set<string>) => {
    const surface = canvasArea.current;
    if (!surface) return;
    for (const group of surface.querySelectorAll<HTMLElement>(".react-flow__node-group")) {
      group.toggleAttribute("data-drop-target", targets.has(group.dataset.id ?? ""));
    }
  };
  const onNodeDrag = (_event: unknown, _node: FlowNode, dragged: FlowNode[]) => {
    const targets = groupDropTargets(nodes, dragged.map(withMeasuredSize));
    highlightGroupTargets(
      new Set(
        Array.from(targets.values()).flatMap((target) =>
          target.parentId ? [target.parentId] : [],
        ),
      ),
    );
  };
  function withMeasuredSize<NodeType extends FlowNode>(node: NodeType) {
    return {
      ...node,
      measured: flowInstance.current?.getInternalNode(node.id)?.measured ?? node.measured,
    };
  }
  const onNodeDragStop = (_event: unknown, _node: FlowNode, dragged: FlowNode[]) => {
    setDraggedGroupId(undefined);
    highlightGroupTargets(new Set());
    alignmentSession.current = null;
    setAlignmentGuidesState([]);
    const moved = new Set(dragged.map((node) => node.id));
    setNodes((current) => {
      const placements = groupDropTargets(
        current,
        current.filter((node) => moved.has(node.id)).map(withMeasuredSize),
      );
      if (
        !current.some(
          (node) => placements.has(node.id) && placements.get(node.id)?.parentId !== node.parentId,
        )
      )
        return current;
      return flowOrder(
        current.map((node) => {
          const placement = placements.get(node.id);
          return placement && placement.parentId !== node.parentId
            ? { ...node, ...placement }
            : node;
        }),
      );
    });
  };
  const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
    changes = adjustAlignmentChanges(changes);
    for (const change of changes) {
      if (change.type === "dimensions" && change.resizing !== undefined) {
        setDragging(change.resizing);
      }
      if (change.type === "position" && change.dragging !== undefined) {
        setDragging(change.dragging);
      }
    }
    applyNodeChanges(writing ? changes.filter(({ type }) => type === "dimensions") : changes);
    const removed = new Set(
      changes.flatMap((change) => (change.type === "remove" ? [change.id] : [])),
    );
    if (!writing) for (const id of removed) forgetUpload(id);
    if (!writing && removed.size) {
      setNodes((current) =>
        current.map((node) => {
          if (node.type !== "creative" || !node.data.storyboard) return node;
          let changed = false;
          const storyboard = node.data.storyboard.map((shot) => {
            const removeImage = !!shot.imageNodeId && removed.has(shot.imageNodeId);
            const removeVideo = !!shot.videoNodeId && removed.has(shot.videoNodeId);
            if (!removeImage && !removeVideo) return shot;
            changed = true;
            const next = { ...shot };
            if (removeImage) delete next.imageNodeId;
            if (removeVideo) delete next.videoNodeId;
            return next;
          });
          return changed ? { ...node, data: { ...node.data, storyboard } } : node;
        }),
      );
    }
  };
  const [duplicate, setDuplicate] = useState<{
    displayName: string;
    resolve: (choice: "reuse" | "independent" | "cancel") => void;
  } | null>(null);

  const refreshRecent = useCallback(async () => {
    const result = await window.desktop.projects.listRecent({});
    if (result.ok) setRecentProjects(result.value.projects);
    else setProjectError(result.error.messageKey);
  }, []);
  useEffect(() => {
    void refreshRecent();
  }, [refreshRecent]);
  const hasBackgroundTasks = recentProjects.some((project) => project.activity);
  useEffect(() => {
    if (!hasBackgroundTasks) return;
    const timer = setInterval(() => void refreshRecent(), 1500);
    return () => clearInterval(timer);
  }, [hasBackgroundTasks, refreshRecent]);

  const assetScope = useRef<string>(undefined);
  const refreshAssets = useCallback(async (projectHandle: string) => {
    const result = await window.desktop.projects.listAssets({ projectHandle });
    if (assetScope.current !== projectHandle) return;
    if (result.ok) setAssets(result.value.assets);
    else setProjectError(result.error.messageKey);
  }, []);
  const trimVideo = async (
    nodeId: string,
    asset: ProjectAsset,
    startMs: number,
    endMs: number,
    removeAudio: boolean,
  ) => {
    if (!projectSession || asset.mediaType !== "video" || trimBusy) return;
    const source = nodes.find((node) => node.id === nodeId);
    const rect = source && absoluteNodeRect(source);
    if (
      !rect ||
      source?.type !== "creative" ||
      source.data.assetId !== asset.assetId ||
      splitCapacity < 1
    ) {
      setProjectError("源节点已变更或画布没有空位。");
      return;
    }
    setTrimBusy(true);
    setWriting(true);
    setProjectError("");
    try {
      const saved = await saveCanvas(projectSession);
      if (!saved) {
        setProjectError("请先保存画布，再裁切视频。");
        return;
      }
      const operationId = crypto.randomUUID();
      setMediaOperationId(operationId);
      const result = await window.desktop.projects.trimAsset({
        projectHandle: saved.projectHandle,
        operationId,
        expectedRevision: saved.revision,
        assetId: asset.assetId,
        startMs,
        endMs,
        removeAudio,
      });
      if (!result.ok) {
        setProjectError(
          assetErrors[result.error.code] ?? "视频裁切失败，请检查时间范围和磁盘空间。",
        );
        return;
      }
      const targetId = crypto.randomUUID();
      const output = result.value.asset;
      setNodes((current) => [
        ...current,
        {
          id: targetId,
          type: "creative",
          position: { x: Math.min(1e7, rect.x + rect.width + 64), y: rect.y },
          data: { kind: "video", label: output.displayName, text: "", assetId: output.assetId },
        },
      ]);
      setEdges((current) => [
        ...current,
        { id: crypto.randomUUID(), source: nodeId, target: targetId },
      ]);
      updateRevision(projectSession.projectHandle, result.value.revision);
      await refreshAssets(projectSession.projectHandle);
      setTrimTarget(undefined);
    } catch {
      setProjectError("视频裁切未完成，请重试。");
    } finally {
      setMediaOperationId(undefined);
      setMediaCancelling(false);
      setWriting(false);
      setTrimBusy(false);
    }
  };

  const syncGeneratedCanvas = useRef(
    async (
      _handle: string,
      _revision: number,
      _splits: Map<string, GenerationJob>,
      _jobs: GenerationJob[],
    ) => {},
  );
  syncGeneratedCanvas.current = async (handle, revision, splits, completedJobs) => {
    if (
      projectSession?.projectHandle !== handle ||
      writing ||
      saving ||
      dragging ||
      importing ||
      uploadingNodes ||
      !persistence.canvasRevision ||
      revision <= persistence.canvasRevision
    )
      return;
    setWriting(true);
    try {
      const merged = await persistence.recover(projectSession, false, revision);
      if (merged) {
        setNodes((current) => {
          const live = new Map(current.map((node) => [node.id, node]));
          return flowNodes(merged).map((node) => {
            const previous = live.get(node.id);
            return previous?.type === node.type
              ? { ...node, measured: previous.measured, selected: previous.selected }
              : node;
          });
        });
        setEdges((current) => flowEdges(merged, selectedIds(current)));
        let splitRestored = false;
        const priorNodes = merged.nodes.map((node) => {
          const job = splits.get(node.id);
          const old = nodes.find((candidate) => candidate.id === node.id);
          if (
            node.type !== "creative" ||
            old?.type !== "creative" ||
            !old.data.storyboard ||
            !job?.storyboardShotIds?.length
          )
            return node;
          const savedRows = node.data.storyboard ?? [];
          const previousRows = old.data.storyboard;
          const expectedIds =
            job.storyboardSplitMode === "append"
              ? [...previousRows.map((shot) => shot.id), ...job.storyboardShotIds]
              : job.storyboardShotIds;
          if (
            savedRows.length !== expectedIds.length ||
            !savedRows.every((shot, index) => shot.id === expectedIds[index]) ||
            previousRows.some((shot) => job.storyboardShotIds!.includes(shot.id))
          )
            return node;
          splitRestored = true;
          if (job.storyboardSplitMode === "replace" && previousRows.length)
            setSplitNotice({ board: node.id, count: savedRows.length });
          return { ...node, data: { ...node.data, storyboard: previousRows } };
        });
        splits.clear();
        if (splitRestored)
          history.recordSynced({ ...merged, nodes: priorNodes }, merged, completedJobs);
        else history.syncGenerated(merged, completedJobs);
      }
    } finally {
      setWriting(false);
    }
  };
  const activeHandle = projectSession?.projectHandle;
  const marks = useMemo(() => createAgentMarks(), [activeHandle]);
  useEffect(() => () => marks.dispose(), [marks]);
  useEffect(() => {
    setJobs([]);
    setJobsLoadedFor(undefined);
    setVersionNodeId(undefined);
    setSplitHighlights({});
    setSplitNotice(undefined);
    setGenerationNodeId(undefined);
    if (!activeHandle) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    let previous = "";
    let previousRevision = -1;
    let seenSplits: Set<string> | undefined;
    const pendingSplits = new Map<string, GenerationJob>();
    const poll = async () => {
      const result = await window.desktop.projects.listJobs({ projectHandle: activeHandle });
      if (!mounted) return;
      if (result.ok) {
        const completedSplits = result.value.jobs.filter(
          (job) => job.status === "succeeded" && job.storyboardShotIds?.length,
        );
        if (seenSplits) {
          const incoming: Record<string, string[]> = {};
          for (const job of completedSplits.toSorted((left, right) =>
            left.updatedAt.localeCompare(right.updatedAt),
          )) {
            if (!seenSplits.has(job.id)) {
              incoming[job.nodeId] = job.storyboardShotIds!;
              pendingSplits.set(job.nodeId, job);
            }
          }
          if (Object.keys(incoming).length)
            setSplitHighlights((current) => ({ ...current, ...incoming }));
        }
        seenSplits = new Set(completedSplits.map((job) => job.id));
        const signature = JSON.stringify(result.value.jobs);
        if (signature !== previous) {
          previous = signature;
          setJobs(result.value.jobs);
          setJobsLoadedFor(activeHandle);
        }
        if (result.value.revision !== previousRevision) {
          previousRevision = result.value.revision;
          void refreshAssets(activeHandle);
        }
        updateRevision(activeHandle, result.value.revision);
        await syncGeneratedCanvas.current(
          activeHandle,
          result.value.canvasRevision,
          pendingSplits,
          result.value.jobs,
        );
      }
      if (mounted) timer = setTimeout(() => void poll(), 600);
    };
    void poll();
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [activeHandle, refreshAssets, updateRevision]);

  const enterProject = async (session: ProjectSession, recentId?: string) => {
    setActiveRecentId(recentId);
    setWithDramaAssistant(false);
    setDramaHandle(
      (session.projectKind ?? localStorage.getItem(`workspace:${session.projectId}`)) === "drama"
        ? session.projectHandle
        : "",
    );
    const { projectHandle } = session;
    assetScope.current = projectHandle;
    setAssets([]);
    setLibraryNode(undefined);
    setManageLibrary(false);
    setNewLibraryFolder(false);
    setImportMode("copy");
    setSidePanel(null);
    setHand(false);
    setShowMap(false);
    setTasksOpen(false);
    setShowGuide(false);
    setAddMenu(undefined);
    setAssetPlacement(undefined);
    setAssetTarget(undefined);
    setGenerationNodeId(undefined);
    persistence.load(null);
    setRecoveryError("");
    setDragging(false);
    setDraggedGroupId(undefined);
    const result = await window.desktop.projects.getCanvas({ projectHandle });
    if (result.ok) {
      const restored = result.value.canvas;
      restoreCanvas(restored);
      history.reset(restored);
      persistence.load(result.value);
    } else {
      setNodes([]);
      setEdges([]);
      setProjectError("当前版本无法载入画布");
    }
    setProjectSession(
      result.ok
        ? { ...session, revision: Math.max(session.revision, result.value.revision) }
        : session,
    );
    await refreshAssets(projectHandle);
    if (session.projectKind === "drama") {
      const result = await window.desktop.projects.listRecent({});
      if (result.ok) {
        setRecentProjects(result.value.projects);
        const entry = result.value.projects.find((project) =>
          recentId ? project.recentEntryId === recentId : project.projectId === session.projectId,
        );
        setActiveRecentId(entry?.recentEntryId);
        if (entry)
          setDramaTabs((previous) =>
            previous.includes(entry.recentEntryId) ? previous : [...previous, entry.recentEntryId],
          );
      }
    }
  };

  const homeAction = async (action: () => Promise<void>) => {
    if (projectBusy) return;
    setProjectError("");
    setProjectBusy(true);
    try {
      await action();
    } catch {
      setProjectError("无法访问本地项目，请检查目录权限后重试。");
    } finally {
      setProjectBusy(false);
    }
  };
  const homeError = (code: string) =>
    setProjectError(
      (
        {
          PROJECT_PATH_DENIED: "无法访问项目位置，请重新选择目录。",
          TOKEN_INVALID_OR_EXPIRED: "授权已过期，请关闭预览并重新选择项目。",
          PROJECT_IN_USE: "另一应用实例正在使用此项目。请在原实例中继续，或关闭那里的项目后重试。",
          PROJECT_NAME_INVALID: "请输入有效项目名称，不包含路径分隔符。",
          PROJECT_CORRUPT: "项目文件损坏，请检查备份。",
          PROJECT_VERSION_UNSUPPORTED: "当前版本无法打开此项目。",
        } as Record<string, string>
      )[code] ?? `项目操作失败（${code}），请检查本地目录后重试。`,
    );
  const createProject = (mode: CreationMode, name: string) =>
    homeAction(async () => {
      const selected = await window.desktop.dialogs.selectProjectParent();
      if (!selected.ok) return homeError(selected.error.code);
      if (selected.value.cancelled) return;
      const result = await window.desktop.projects.create({
        directoryToken: selected.value.directoryToken,
        operationId: crypto.randomUUID(),
        name: name.trim() || "未命名项目",
        projectKind: mode,
      });
      if (!result.ok) return homeError(result.error.code);
      await enterProject(result.value);
    });
  const importNewCanvas = (file: File) =>
    homeAction(async () => {
      try {
        if (file.size > 10 * 1024 * 1024) throw new Error("交换文件超过 10 MB 限制");
        const raw = JSON.parse(await file.text());
        const upstream = raw?.format === "video-canvas/canvas";
        const initial = upstream
          ? prepareVideoCanvasExchange(raw, [])
          : prepareCanvasExchange(parseCanvasExchange(raw), new Set());
        const needed = new Set(initial.report.missingAssetIds);
        const matches: ProjectAsset[] = [];
        let before: number | undefined;
        while (needed.size) {
          const page = await window.desktop.projects.globalLibrary(before ? { before } : {});
          if (!page.ok) throw new Error("无法核对个人资产库，请重试。");
          for (const { asset } of page.value.items)
            if (needed.delete(upstream ? asset.sha256 : asset.assetId)) matches.push(asset);
          if (!page.value.next || (before && page.value.next >= before)) break;
          before = page.value.next;
        }
        const prepared = !matches.length
          ? initial
          : upstream
            ? prepareVideoCanvasExchange(raw, matches)
            : prepareCanvasExchange(
                parseCanvasExchange(raw),
                new Set(matches.map((asset) => asset.assetId)),
              );
        const { missingAssetIds, droppedEdgeCount } = prepared.report;
        const report = `缺失素材 ${missingAssetIds.length} 个，跳过无效连线 ${droppedEdgeCount} 条`;
        if (
          (missingAssetIds.length || droppedEdgeCount) &&
          !window.confirm(`${report}。继续导入为独立画布？`)
        )
          return;
        const seed = canvasSeed(prepared.document, undefined, true);
        const location = await window.desktop.dialogs.selectProjectParent();
        if (!location.ok) return homeError(location.error.code);
        if (location.value.cancelled) return;
        const created = await window.desktop.projects.create({
          directoryToken: location.value.directoryToken,
          operationId: crypto.randomUUID(),
          projectKind: "canvas",
          name: (sanitizeFileName(prepared.document.title).trim() || "导入画布").slice(0, 100),
          canvasSeed: seed,
        });
        if (!created.ok) return homeError(created.error.code);
        await enterProject(created.value);
        setProjectError(`已导入为新画布：${report}。`);
      } catch (error) {
        setProjectError(error instanceof Error ? error.message : "导入失败");
      }
    });
  const openProject = () =>
    homeAction(async () => {
      const selected = await window.desktop.dialogs.selectProject();
      if (!selected.ok) return homeError(selected.error.code);
      if (selected.value.cancelled) return;
      const result = await window.desktop.projects.open({
        directoryToken: selected.value.directoryToken,
        allowReadOnly: true,
      });
      if (!result.ok) return homeError(result.error.code);
      if (result.value.disposition === "readOnly") return setReadonlyView(result.value);
      if (result.value.disposition === "opened") await enterProject(result.value.session);
    });
  const openRecentProject = (recentEntryId: string, asDrama = false) =>
    homeAction(async () => {
      const result = await window.desktop.projects.openRecent({
        recentEntryId,
        allowReadOnly: true,
      });
      if (!result.ok) return homeError(result.error.code);
      if (result.value.disposition === "readOnly") return setReadonlyView(result.value);
      if (result.value.disposition === "opened") {
        if (asDrama && !result.value.session.projectKind)
          localStorage.setItem(`workspace:${result.value.session.projectId}`, "drama");
        await enterProject(result.value.session, recentEntryId);
      }
    });

  useEffect(() => window.desktop.canvasWindow.onActivateProject(setActivation), []);
  const activateProject = useEffectEvent(async (target: ProjectActivation) => {
    setShowSettings(false);
    if (projectSession?.projectHandle === target.projectHandle) return;
    await homeAction(async () => {
      if (projectSession) {
        if (flushDrama.current && !(await flushDrama.current())) return;
        await leaveCanvas(
          false,
          () => window.desktop.projects.open({ directoryToken: target.directoryToken }),
          target.recentEntryId,
        );
      } else {
        const result = await window.desktop.projects.open({
          directoryToken: target.directoryToken,
        });
        if (!result.ok) return homeError(result.error.code);
        if (result.value.disposition === "opened")
          await enterProject(result.value.session, target.recentEntryId);
      }
    });
  });
  useEffect(() => {
    if (!activation || projectBusy || writing || importing || uploadingNodes || dragging || saving)
      return;
    setActivation(undefined);
    void activateProject(activation);
  }, [activation, projectBusy, writing, importing, uploadingNodes, dragging, saving]);

  const importMedia = async (
    target?: DropPlacement | { nodeId: string; kind: NodeKind; extra?: boolean; dramaDrop?: true },
    files?: File[],
    imported?: (asset: ProjectAsset) => void,
    signal?: AbortSignal,
  ) => {
    const session = projectSession;
    const reportImportError = target?.dramaDrop ? reportFillError : setProjectError;
    if (!session || importing || writing) {
      if (target?.dramaDrop) reportImportError("项目正忙，请稍后再拖入文件");
      return;
    }
    if (target && "nodeId" in target && target.kind !== "script") {
      const { nodeId, kind } = target,
        { projectHandle } = session;
      const getTarget = () => liveNodes.current.find((item) => item.id === nodeId);
      const node = getTarget();
      if (node?.type !== "creative" || node.data.kind !== kind) return;
      if (
        (!node.data.character || target.dramaDrop) &&
        !node.data.director &&
        !node.data.storyboard
      ) {
        const unavailable = () => {
          const current = getTarget();
          if (
            current?.type !== "creative" ||
            current.data.kind !== kind ||
            !!current.data.character !== !!node.data.character ||
            current.data.director ||
            current.data.storyboard ||
            current.data.assetId ||
            current.data.outputs?.length ||
            current.data.uploadProgress !== undefined ||
            jobsRef.current.some((job) => job.nodeId === nodeId && !jobIsTerminal(job.status))
          )
            return "只有空节点能上传";
          if (
            !node.data.character &&
            flowInstance.current
              ?.getEdges()
              .some((edge) => edge.target === nodeId && edge.data?.readOnly)
          )
            return "此节点的输入连线不可编辑";
        };
        const reason = unavailable();
        if (reason) {
          reportImportError(reason);
          return;
        }
        if (!files) {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = `${kind}/*`;
          input.onchange = () => {
            const file = input.files?.[0];
            if (file && currentProjectHandle.current === projectHandle)
              void importMedia(target, [file]);
          };
          input.click();
          return;
        }
        const file = files[0];
        if (!file) return;
        if (!file.type.startsWith(`${kind}/`)) {
          reportImportError(`这个节点只收${NODE_LABELS[kind]}`);
          return;
        }
        const accepted = canvasUploadKind(file);
        if ("error" in accepted) {
          reportImportError(accepted.error);
          return;
        }
        setProjectError("");
        try {
          const granted = await window.desktop.dialogs.droppedMedia(projectHandle, [file]);
          if (!granted.ok) {
            if (currentProjectHandle.current === projectHandle)
              reportImportError(granted.error.messageKey);
            return;
          }
          const selection = !granted.value.cancelled && granted.value.files[0];
          if (!selection) return;
          const changed = unavailable();
          if (currentProjectHandle.current !== projectHandle || changed) {
            await window.desktop.projects.discardMedia({
              projectHandle,
              fileToken: selection.fileToken,
            });
            if (currentProjectHandle.current === projectHandle && changed)
              reportImportError(changed);
            return;
          }
          canvasUploads.forget(nodeId);
          flushSync(() => {
            if (!node.data.character)
              setEdges((current) => current.filter((edge) => edge.target !== nodeId));
            setNodes((current) =>
              current.map((item) =>
                item.id === nodeId && item.type === "creative"
                  ? {
                      ...item,
                      data: {
                        ...item.data,
                        ...(!item.data.character && { uploaded: true as const }),
                        uploadProgress: 0,
                        uploadFailed: undefined,
                        uploadInterrupted: undefined,
                      },
                    }
                  : item,
              ),
            );
          });
          const result = await canvasUploads.start({
            id: nodeId,
            selection,
            session,
            mode: importMode,
            controller: new AbortController(),
          });
          if (result === "failed" && currentProjectHandle.current === projectHandle)
            reportImportError(
              node.data.character ? "上传失败，请重新拖入文件" : "上传失败，可以在节点上重试",
            );
        } catch {
          if (currentProjectHandle.current === projectHandle)
            reportImportError("导入中断，请重新选择文件");
        }
        return;
      }
    }
    if (target && "position" in target) {
      const { projectHandle } = session;
      setProjectError("");
      setAssetPlacement(undefined);
      setAssetTarget(undefined);
      if (!files) {
        uploadPlacement.current = { target, projectHandle };
        uploadInput.current?.click();
        return;
      }
      if (!files.length) return;
      try {
        const rejected: string[] = [];
        const summarize = () =>
          rejected.length === 1 ? rejected[0]! : `${rejected.length} 个文件没收下：${rejected[0]}`;
        const drop = target.dramaDrop;
        const accepted = files.flatMap((file) => {
          if (drop && !file.type.startsWith(`${drop.kind}/`)) {
            rejected.push(`这个节点只收${NODE_LABELS[drop.kind]}`);
            return [];
          }
          const result = canvasUploadKind(file);
          if ("error" in result) {
            rejected.push(result.error);
            return [];
          }
          return [{ file, kind: result.kind }];
        });
        if (!accepted.length) {
          reportImportError(summarize());
          return;
        }
        if (drop && rejected.length) {
          reportImportError(summarize());
          rejected.length = 0;
        }
        let sources: (CanvasUploadSelection | ClipboardUploadSelection)[];
        if (target.clipboard)
          sources = accepted.map(({ file, kind }) => ({
            clipboard: file,
            kind,
            displayName: clipboardFileName(file),
          }));
        else {
          const selection = await window.desktop.dialogs.droppedMedia(
            projectHandle,
            accepted.map((item) => item.file),
          );
          if (!selection.ok) {
            if (currentProjectHandle.current === projectHandle)
              reportImportError(selection.error.messageKey);
            return;
          }
          if (selection.value.cancelled) return;
          sources = selection.value.files;
        }
        const discard = (source: CanvasUploadSelection | ClipboardUploadSelection) =>
          "fileToken" in source &&
          window.desktop.projects.discardMedia({ projectHandle, fileToken: source.fileToken });
        const aspects = accepted.map(({ file, kind }) =>
          canvasFileAspect(file, kind).catch(() => undefined),
        );
        if (!target.clipboard) await Promise.all(aspects);
        const results = await Promise.all(
          accepted.map(async ({ kind }, index) => {
            const selection = sources[index],
              aspect = await aspects[index];
            if (!selection) {
              rejected.push("文件未获得授权");
              return "rejected";
            }
            if (currentProjectHandle.current !== projectHandle) {
              await discard(selection);
              return "aborted";
            }
            const id = crypto.randomUUID();
            let placed = false;
            flushSync(() =>
              setNodes((current) => {
                if (current.length >= 1000) return current;
                const character = drop?.scope.type === "character";
                const label = availableNodeLabel(
                  drop
                    ? character
                      ? defaultCharacter.name
                      : NODE_LABELS[kind]
                    : assetNodeLabel(selection.displayName, NODE_LABELS[kind]),
                  current.map((node) => node.data.label),
                );
                placed = true;
                return [
                  ...current.map((node) => (node.selected ? { ...node, selected: false } : node)),
                  {
                    id,
                    type: "creative",
                    selected: true,
                    position: droppedPosition(target, index),
                    data: {
                      kind,
                      label,
                      text: "",
                      ...(character
                        ? { character: { ...defaultCharacter, name: label } }
                        : { uploaded: true as const }),
                      ...(drop && { drama: scopedDramaData(drop.scope, label) }),
                      uploadProgress: 0,
                      ...newNodeModel(character ? "character" : kind),
                      ...(aspect && { mediaAspect: aspect }),
                    },
                  },
                ];
              }),
            );
            if (!placed) {
              rejected.push("画布节点数量已达上限");
              await discard(selection);
              return "rejected";
            }
            return canvasUploads.start({
              id,
              selection,
              session,
              mode: importMode,
              controller: new AbortController(),
            });
          }),
        );
        if (currentProjectHandle.current !== projectHandle) return;
        const failed = results.filter((status) => status === "failed").length,
          done = results.filter((status) => status === "done").length;
        if (rejected[0]) reportImportError(summarize());
        else if (failed)
          reportImportError(
            drop?.scope.type === "character"
              ? `${failed} 个文件上传失败，请重新拖入文件`
              : failed === 1
                ? "上传失败，可以在节点上重试"
                : `${failed} 个文件上传失败，可以在节点上重试`,
          );
        else if (done && target.pending)
          reportLinkNotice(
            `${done === 1 ? NODE_LABELS[accepted[0]!.kind] : `${done} 个节点`}接不到刚才那根线上，已单独放下`,
          );
      } catch {
        if (currentProjectHandle.current === projectHandle)
          reportImportError("导入中断，请重新选择文件");
      }
      return;
    }
    setProjectError("");
    setImporting(true);
    if (target) {
      setAssetPlacement(undefined);
      setAssetTarget(undefined);
      if (!files) setSidePanel("assets");
    }
    const { projectHandle } = session;
    let revision = session.revision;
    try {
      const selected = files
        ? await window.desktop.dialogs.droppedMedia(projectHandle, files)
        : await window.desktop.dialogs.selectMedia({
            projectHandle,
            multiSelect: !target,
            ...(target &&
              "nodeId" in target &&
              target.kind !== "script" && { mediaType: target.kind }),
          });
      if (!selected.ok) return setProjectError(selected.error.messageKey);
      if (selected.value.cancelled) return;
      for (const { fileToken, displayName } of selected.value.files) {
        if (signal?.aborted) {
          await window.desktop.projects.discardMedia({ projectHandle, fileToken });
          continue;
        }
        const started = await window.desktop.projects.startImport({
          projectHandle,
          operationId: crypto.randomUUID(),
          expectedRevision: revision,
          fileToken,
          importMode,
        });
        if (!started.ok) {
          await window.desktop.projects.discardMedia({ projectHandle, fileToken });
          setProjectError(`${displayName} · ${assetErrors[started.error.code] ?? "导入失败"}`);
          continue;
        }
        const query = { projectHandle, importSessionId: started.value.importSessionId };
        let result = await window.desktop.projects.getImport(query);
        while (result.ok) {
          const status = result.value;
          if (signal?.aborted && status.phase !== "imported") {
            await window.desktop.projects.cancelImport(query);
            break;
          }
          setActiveImport({
            id: query.importSessionId,
            name: displayName,
            status,
            nodeId: target && "nodeId" in target ? target.nodeId : undefined,
          });
          if (status.phase === "imported") {
            revision = status.revision;
            if (!signal?.aborted) imported?.(status.asset);
            if (target) {
              if (status.asset.mediaType === target.kind) {
                fillNodeAsset(target.nodeId, status.asset, target.extra);
              } else
                setProjectError(
                  `素材已导入当前项目，请为此节点选择${NODE_LABELS[target.kind]}素材。`,
                );
            }
            break;
          }
          if (status.phase === "cancelled") break;
          if (status.phase === "failed") {
            setProjectError(`${displayName} · ${assetErrors[status.code] ?? "导入失败"}`);
            break;
          }
          if (status.phase === "duplicate" || status.phase === "conflict") {
            const choice =
              status.phase === "duplicate"
                ? await new Promise<"reuse" | "independent" | "cancel">((resolve) => {
                    const cancel = () => resolve("cancel");
                    signal?.addEventListener("abort", cancel, { once: true });
                    setDuplicate({
                      displayName,
                      resolve: (choice) => {
                        signal?.removeEventListener("abort", cancel);
                        resolve(choice);
                      },
                    });
                  })
                : undefined;
            setDuplicate(null);
            if (choice === "cancel") {
              await window.desktop.projects.cancelImport(query);
              break;
            }
            if (status.phase === "conflict") {
              const latest = await window.desktop.projects.getState({ projectHandle });
              if (!latest.ok) {
                await window.desktop.projects.cancelImport(query);
                setProjectError("项目已更新，请重新打开项目");
                break;
              }
              revision = latest.value.session.revision;
            }
            result = await window.desktop.projects.commitImport({
              ...query,
              operationId: crypto.randomUUID(),
              expectedRevision: revision,
              ...(choice ? { choice } : {}),
            });
          } else {
            await new Promise((resolve) => setTimeout(resolve, 100));
            result = await window.desktop.projects.getImport(query);
          }
        }
        if (!result.ok) {
          setProjectError(`${displayName} · ${assetErrors[result.error.code] ?? "导入失败"}`);
        }
        setActiveImport(null);
      }
      await refreshAssets(projectHandle);
    } catch {
      setProjectError("导入中断，请重新选择文件");
    } finally {
      setActiveImport(null);
      updateRevision(projectHandle, revision);
      setImporting(false);
    }
  };

  const onCanvasEdgesChange = (changes: EdgeChange<FlowEdge>[]) => {
    const allowed = changes.filter(
      (change) =>
        change.type !== "remove" || !edges.find((edge) => edge.id === change.id)?.data?.readOnly,
    );
    onEdgesChange(allowed);
  };

  const linkPlan = (source: LinkKind, target: LinkKind, data?: CreativeData) =>
    !canLinkKinds(source, target) || data?.uploaded
      ? false
      : mediaLinkMode(source, target, generationProviders, data ?? newNodeModel(target));
  const acceptsMenuKind = (pending: PendingLink | undefined, kind: LinkKind) => {
    if (!pending) return true;
    const endpoint = nodes.find((node) => node.id === pending.id);
    return (
      endpoint?.type === "creative" &&
      endpoint.data.uploadProgress === undefined &&
      (pending.type === "source"
        ? linkPlan(pending.kind, kind)
        : linkPlan(kind, pending.kind, endpoint.data)) !== false
    );
  };
  const applyLinkMode = (target: string, mode: ReturnType<typeof linkPlan>) => {
    if (mode)
      setNodes((current) =>
        current.map((node) =>
          node.id === target && node.type === "creative"
            ? { ...node, data: { ...node.data, videoMode: mode } }
            : node,
        ),
      );
  };
  const validManualLink = ({ source, target }: Pick<Connection, "source" | "target">) => {
    if (source === target) return false;
    const from = nodes.find((node) => node.id === source);
    const to = nodes.find((node) => node.id === target);
    return (
      from?.type === "creative" &&
      from.data.uploadProgress === undefined &&
      to?.type === "creative" &&
      linkPlan(linkKind(from.data), linkKind(to.data), to.data) !== false
    );
  };

  const onConnect = (connection: Connection, withTyping = false) => {
    if (writing || !persistence.loaded || !validManualLink(connection)) return;
    const { source, target } = connection;
    const duplicate = edges.some((edge) => edge.source === source && edge.target === target);
    if (edges.length >= 4000 && !duplicate) return;
    const from = nodes.find((node) => node.id === source);
    const to = nodes.find((node) => node.id === target);
    if (from?.type === "creative" && to?.type === "creative")
      applyLinkMode(target, linkPlan(linkKind(from.data), linkKind(to.data), to.data));
    if (duplicate) return;
    const id = crypto.randomUUID();
    if (withTyping) history.absorbTyping(id);
    setEdges((current) =>
      current.length >= 4000 ||
      current.some((edge) => edge.source === source && edge.target === target)
        ? current
        : [...current, { id, source, target }],
    );
  };

  const disconnectEdge = (id: string) => {
    if (writing || !persistence.loaded) return;
    setEdges((current) =>
      current.some((edge) => edge.id === id && !edge.data?.readOnly)
        ? current.filter((edge) => edge.id !== id || edge.data?.readOnly)
        : current,
    );
  };
  const disconnectEdges = useCallback(
    (ids: readonly string[]) => {
      if (writing || !persistence.loaded || !ids.length) return;
      const targets = new Set(ids);
      setEdges((current) => current.filter((edge) => !targets.has(edge.id) || edge.data?.readOnly));
    },
    [persistence.loaded, setEdges, writing],
  );
  useEffect(() => {
    if (!sweepMode) {
      setSweepPoints([]);
      return;
    }
    const surface = canvasArea.current;
    if (!surface) return;
    let drawing = false;
    let points: Point[] = [];
    const localPoint = (event: PointerEvent) => {
      const rect = surface.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const down = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        !(event.target instanceof Element) ||
        !event.target.closest(".react-flow__pane") ||
        event.target.closest(".react-flow__node,.react-flow__controls")
      )
        return;
      drawing = true;
      points = [localPoint(event)];
      setSweepPoints(points);
      event.preventDefault();
    };
    const move = (event: PointerEvent) => {
      if (!drawing) return;
      const next = localPoint(event);
      const previous = points.at(-1);
      if (!previous || Math.hypot(next.x - previous.x, next.y - previous.y) >= 3) {
        points = [...points, next];
        setSweepPoints(points);
      }
      event.preventDefault();
    };
    const up = () => {
      if (!drawing) return;
      drawing = false;
      const rect = surface.getBoundingClientRect();
      const candidates = [...surface.querySelectorAll<SVGPathElement>(".react-flow__edge-path")]
        .map((path) => {
          const edgeId = path.closest<SVGGElement>(".react-flow__edge")?.dataset.id;
          const matrix = path.getScreenCTM();
          if (!edgeId || !matrix) return undefined;
          const length = path.getTotalLength();
          const samples = Array.from({ length: 33 }, (_, index) => {
            const point = path.getPointAtLength((length * index) / 32);
            const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
            return { x: screen.x - rect.left, y: screen.y - rect.top };
          });
          const edge = edges.find(({ id }) => id === edgeId);
          return edge ? { ...edge, points: samples } : undefined;
        })
        .filter((edge): edge is FlowEdge & { points: Point[] } => !!edge);
      const hit = edgeIdsHitBySweep(candidates, points);
      disconnectEdges(hit);
      points = [];
      setSweepPoints([]);
    };
    surface.addEventListener("pointerdown", down, true);
    surface.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    return () => {
      surface.removeEventListener("pointerdown", down, true);
      surface.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
    };
  }, [disconnectEdges, edges, sweepMode]);
  useEffect(() => {
    const disconnect = (event: Event) => {
      const id = (event as CustomEvent<unknown>).detail;
      if (typeof id === "string") disconnectEdge(id);
    };
    window.addEventListener("link-studio:disconnect-edge", disconnect);
    return () => window.removeEventListener("link-studio:disconnect-edge", disconnect);
  });

  const menuGroupSelected = nodes.some((node) => node.id === groupMenuId && node.selected);
  useEffect(() => {
    if (!menuGroupSelected) setGroupMenuId(undefined);
  }, [menuGroupSelected]);
  if (!projectSession) {
    return (
      <>
        {settingsPage()}
        <div hidden={showSettings}>
          {readonlyView && (
            <ReadonlyCanvas
              view={readonlyView}
              busy={projectBusy}
              error={projectError}
              close={() => setReadonlyView(undefined)}
              retry={() =>
                void homeAction(async () => {
                  const result = await window.desktop.projects.open({
                    directoryToken: readonlyView.directoryToken,
                    allowReadOnly: true,
                  });
                  if (!result.ok) return homeError(result.error.code);
                  if (result.value.disposition === "readOnly") {
                    setReadonlyView(result.value);
                    setProjectError("项目仍在使用，已刷新已提交快照。");
                    return;
                  }
                  setReadonlyView(undefined);
                  if (result.value.disposition === "opened")
                    await enterProject(result.value.session);
                })
              }
            />
          )}
          <CreationHome
            recent={recentProjects}
            busy={projectBusy}
            error={projectError}
            importCanvas={importNewCanvas}
            create={createProject}
            open={openProject}
            resume={openRecentProject}
            settings={() => setShowSettings(true)}
            remove={(id) =>
              homeAction(async () => {
                const result = await window.desktop.projects.removeRecent({ recentEntryId: id });
                if (!result.ok) return homeError(result.error.code);
                await refreshRecent();
              })
            }
          />
        </div>
      </>
    );
  }
  const busy = importing || writing || saving || dragging;
  const selected = nodes.filter((node) => node.selected);
  const inspected = selected.length === 1 ? selected[0] : undefined;
  const textNode = nodes.find((node) => node.id === textNodeId && node.type === "creative");
  const doodling = !!doodleTarget && inspected?.id === doodleTarget.nodeId;
  const framing = !!frameTarget?.nodeId && inspected?.id === frameTarget.nodeId;
  const splitting = !!splitTarget && inspected?.id === splitTarget.nodeId;
  const visualNode =
    inspected?.type === "creative" && isGenerationMedia(inspected.data.kind)
      ? inspected
      : undefined;
  const characterNode = nodes.find(
    (node): node is CreativeNode => node.id === characterNodeId && node.type === "creative",
  );
  const storyboardNode = nodes.find(
    (node): node is CreativeNode => node.id === storyboardNodeId && node.type === "creative",
  );
  const directorNode = nodes.find(
    (node): node is CreativeNode => node.id === directorNodeId && node.type === "creative",
  );
  const inspectedAsset =
    inspected?.type === "creative"
      ? assets.find(
          (item) => item.assetId === inspected.data.assetId && item.availability === "ready",
        )
      : undefined;
  const inspectedKind = inspected?.type === "creative" ? linkKind(inspected.data) : undefined;
  const stripKind =
    inspectedKind !== "character" && inspectedKind !== "director" ? inspectedKind : undefined;
  const splitCapacity = Math.min(1000 - nodes.length, 4000 - edges.length);
  const openTrim = async (asset: ProjectAsset, nodeId: string) => {
    const result = await window.desktop.projects.getAssetPreview({
      projectHandle: projectSession.projectHandle,
      assetId: asset.assetId,
    });
    if (!result.ok) {
      setProjectError(assetErrors[result.error.code] ?? "无法打开视频预览");
      return;
    }
    setProjectError("");
    setTrimTarget({ asset, nodeId, url: result.value.url });
  };
  const openFrame = async (asset: ProjectAsset, nodeId?: string) => {
    const result = await window.desktop.projects.getAssetPreview({
      projectHandle: projectSession.projectHandle,
      assetId: asset.assetId,
    });
    if (!result.ok) {
      setProjectError(assetErrors[result.error.code] ?? "无法打开视频预览");
      return;
    }
    setFrameError("");
    setFrameTarget({ asset, nodeId, url: result.value.url });
  };
  const extractVideoFrame = async (
    timesMs: number[],
    quick?: { asset: ProjectAsset; nodeId: string; choice: Exclude<FrameChoice, "自定义"> },
  ) => {
    const target = quick ?? frameTarget;
    if (
      !target ||
      importing ||
      writing ||
      dragging ||
      extractingFrame.current ||
      !timesMs.length ||
      timesMs.length > 9
    )
      return;
    const { asset, nodeId } = target;
    const reportError = quick ? setProjectError : setFrameError;
    const source = nodeId ? nodes.find((node) => node.id === nodeId) : undefined;
    const position = source && absoluteNodeRect(source);
    if (
      nodeId &&
      (!position ||
        source?.type !== "creative" ||
        source.data.assetId !== asset.assetId ||
        splitCapacity < timesMs.length)
    ) {
      reportError("源节点已变更或画布没有空位。");
      return;
    }
    const boxes = (all: FlowNode[]) =>
      all.map(
        (node) =>
          absoluteNodeRect(node, all) ?? {
            ...node.position,
            width: node.measured?.width ?? node.width ?? 280,
            height: node.measured?.height ?? node.height ?? 200,
          },
      );
    const pendingId = crypto.randomUUID();
    const pendingEdgeId = crypto.randomUUID();
    if (quick && position && source?.type === "creative") {
      const plan = planFramePlacement(
        position,
        boxes(nodes),
        new Set(nodes.map((node) => node.data.label)),
        source.data.label,
        quick.choice,
      );
      setPendingFrame({
        node: {
          id: pendingId,
          type: "creative",
          position: plan.position,
          draggable: false,
          selectable: false,
          connectable: false,
          deletable: false,
          data: { kind: "image", uploaded: true, text: "", label: plan.label, framePending: true },
        },
        edge: { id: pendingEdgeId, source: quick.nodeId, target: pendingId, deletable: false },
      });
    }
    extractingFrame.current = true;
    const { projectHandle } = projectSession;
    setWriting(true);
    reportError("");
    try {
      if (!(await saveCanvas(projectSession))) {
        reportError("画布保存失败，请处理保存错误后重试。");
        return;
      }
      const ids: string[] = [];
      for (const timeMs of timesMs) {
        const result = await window.desktop.projects.inspectAsset({
          projectHandle,
          assetId: asset.assetId,
          timeMs,
        });
        if (!result.ok) {
          reportError(
            assetErrors[result.error.code] ?? "无法提取此位置的视频帧，请尝试前移播放位置。",
          );
          return;
        }
        updateRevision(projectHandle, result.value.revision);
        ids.push(result.value.assetId);
      }
      const latest = await window.desktop.projects.listAssets({ projectHandle });
      const frames = latest.ok
        ? ids.flatMap((id) => latest.value.assets.filter((asset) => asset.assetId === id))
        : [];
      if (!latest.ok || frames.length !== ids.length) {
        reportError("截帧已保存，暂时无法刷新项目文件列表，请重试。");
        return;
      }
      setAssets(latest.value.assets);
      if (nodeId && position) {
        const live = flowInstance.current;
        const all = live?.getNodes().filter((node) => node.id !== pendingId) ?? [];
        const video = all.find((node) => node.id === nodeId);
        if (
          !live ||
          video?.type !== "creative" ||
          video.data.assetId !== asset.assetId ||
          all.length + frames.length > 1000 ||
          live.getEdges().filter((edge) => edge.id !== pendingEdgeId).length + frames.length > 4000
        ) {
          setFrameTarget(undefined);
          setProjectError("截帧已保存到项目文件，源节点或画布容量已变化，未创建连线。");
          return;
        }
        const origin = absoluteNodeRect(video, all) ?? position;
        const taken = boxes(all);
        const labels = new Set(all.map((node) => node.data.label));
        const children: CreativeNode[] = frames.map((frame) => {
          const plan = planFramePlacement(
            origin,
            taken,
            labels,
            video.data.label,
            quick?.choice ?? Number(frame.metadata.timeMs),
          );
          return {
            id: quick ? pendingId : crypto.randomUUID(),
            type: "creative",
            position: plan.position,
            data: {
              kind: "image",
              label: plan.label,
              text: "",
              assetId: frame.assetId,
              uploaded: true,
            },
          };
        });
        setNodes((current) => [...current, ...children]);
        setEdges((current) => [
          ...current,
          ...children.map(({ id }) => ({
            id: quick ? pendingEdgeId : crypto.randomUUID(),
            source: nodeId,
            target: id,
          })),
        ]);
      } else if (frames[0]) {
        await openPreview(frames[0]);
      }
      setFrameTarget(undefined);
    } catch {
      reportError("提取视频帧未完成，请重试。");
    } finally {
      extractingFrame.current = false;
      setPendingFrame(undefined);
      setWriting(false);
    }
  };
  const openSplit = (nodeId: string, asset: ProjectAsset, rows: number, columns: number) => {
    setSplitError("");
    setSplitTarget({ nodeId, asset, rows, columns });
  };
  const openDoodle = async (nodeId: string, asset: ProjectAsset) => {
    const result = await window.desktop.projects.getAssetPreview({
      projectHandle: projectSession.projectHandle,
      assetId: asset.assetId,
    });
    if (!result.ok) {
      setProjectError(assetErrors[result.error.code] ?? "无法打开图片标注");
      return;
    }
    setDoodleError("");
    setDoodleTarget({ nodeId, asset, url: result.value.url });
  };
  const openOutpaint = async (nodeId: string, asset: ProjectAsset) => {
    const result = await window.desktop.projects.getAssetPreview({
      projectHandle: projectSession.projectHandle,
      assetId: asset.assetId,
    });
    if (!result.ok) {
      setProjectError(assetErrors[result.error.code] ?? "无法打开扩图预览");
      return;
    }
    outpaintAttempt.current = {
      assetOperationId: crypto.randomUUID(),
      canvasOperationId: crypto.randomUUID(),
      jobId: crypto.randomUUID(),
      nodeId: crypto.randomUUID(),
    };
    setOutpaintError("");
    setOutpaintTarget({ nodeId, asset, url: result.value.url });
  };
  const submitOutpaint = async ({ pngData, ...draft }: OutpaintDraft) => {
    const attempt = outpaintAttempt.current;
    if (!outpaintTarget || !attempt || outpaintBusy) return;
    const { nodeId: sourceId, asset } = outpaintTarget;
    const source = nodes.find(({ id }) => id === sourceId);
    const rect = source && absoluteNodeRect(source);
    if (
      !rect ||
      source?.type !== "creative" ||
      source.data.assetId !== asset.assetId ||
      (!attempt.canvasWrite && splitCapacity < 1)
    ) {
      setOutpaintError("源节点已变更或画布没有空位。");
      return;
    }
    setOutpaintBusy(true);
    setWriting(true);
    setOutpaintError("");
    try {
      const saved = await saveCanvas(projectSession);
      if (!saved) return setOutpaintError("请先处理画布保存错误。");
      const { projectHandle } = saved;
      const current = await window.desktop.projects.getCanvas({ projectHandle });
      if (!current.ok) return setOutpaintError("无法读取画布，请重试。");
      if (!attempt.referenceId) {
        const reference = await window.desktop.projects.annotateAsset({
          projectHandle,
          expectedRevision: current.value.revision,
          operationId: attempt.assetOperationId,
          assetId: asset.assetId,
          pngData,
          purpose: "outpaint",
        });
        if (!reference.ok)
          return setOutpaintError(
            assetErrors[reference.error.code] ?? "扩图底图保存失败，请重试。",
          );
        attempt.referenceId = reference.value.asset.assetId;
        updateRevision(projectHandle, reference.value.revision);
        await refreshAssets(projectHandle);
      }
      let canvasRevision = current.value.canvasRevision;
      if (!current.value.canvas.nodes.some(({ id }) => id === attempt.nodeId)) {
        attempt.canvasWrite ??= {
          expectedCanvasRevision: canvasRevision,
          operations: [
            {
              type: "putNode",
              node: {
                type: "creative",
                id: attempt.nodeId,
                position: { x: Math.min(1e7, rect.x + rect.width + 64), y: rect.y },
                data: {
                  kind: "image",
                  label: `${source.data.label.slice(0, 250)}-扩图`,
                  text: draft.prompt,
                },
              },
            },
            {
              type: "putEdge",
              edge: { id: crypto.randomUUID(), source: sourceId, target: attempt.nodeId },
            },
          ],
        };
        const written = await window.desktop.projects.applyCanvasOperations({
          projectHandle,
          operationId: attempt.canvasOperationId,
          ...attempt.canvasWrite,
        });
        if (!written.ok) {
          if (written.error.code === "CANVAS_REVISION_CONFLICT") attempt.canvasWrite = undefined;
          return setOutpaintError("扩图节点保存失败，请重试。");
        }
        canvasRevision = written.value.canvasRevision;
      }
      const persisted = await window.desktop.projects.getCanvas({ projectHandle });
      if (!persisted.ok) return setOutpaintError("无法刷新扩图节点，请重试。");
      restoreCanvas(persisted.value.canvas);
      setNodes((items) => items.map((item) => ({ ...item, selected: item.id === attempt.nodeId })));
      persistence.load(persisted.value);
      updateRevision(projectHandle, persisted.value.revision);
      attempt.generation ??= {
        ...draft,
        nodeId: attempt.nodeId,
        referenceAssetIds: [attempt.referenceId],
        expectedCanvasRevision: Math.max(canvasRevision, persisted.value.canvasRevision),
      };
      const job = await window.desktop.projects.submitJob({
        projectHandle,
        confirmed: true,
        operationId: attempt.jobId,
        generation: attempt.generation,
      });
      if (!job.ok) {
        if (job.error.code === "CANVAS_REVISION_CONFLICT") attempt.generation = undefined;
        return setOutpaintError(
          job.error.code === "JOB_MODEL_UNAVAILABLE"
            ? "模型配置已变更，请关闭扩图并重新选择模型。"
            : "无法提交扩图任务，请检查模型配置后重试。",
        );
      }
      setOutpaintTarget(undefined);
      setSidePanel("jobs");
    } catch {
      setOutpaintError("扩图提交未完成，请重试。");
    } finally {
      setOutpaintBusy(false);
      setWriting(false);
    }
  };
  const saveDoodle = (render: () => Promise<string>, aspect: number) => {
    if (!doodleTarget || !projectSession) return false;
    const source = nodes.find((node) => node.id === doodleTarget.nodeId);
    const size = imageFrameSize(aspect, 1);
    if (
      !size ||
      source?.type !== "creative" ||
      source.data.assetId !== doodleTarget.asset.assetId ||
      nodes.length >= 1000 ||
      edges.length >= 4000
    ) {
      setDoodleError("源图片或画布状态已变化，请关闭后重新打开标注。");
      return false;
    }
    const id = crypto.randomUUID();
    setNodes((current) => {
      const rectOf = (node: FlowNode): Rect => {
        const internal = flowInstance.current?.getInternalNode(node.id);
        const parent = node.parentId
          ? current.find((item) => item.id === node.parentId)
          : undefined;
        return {
          ...(internal?.internals.positionAbsolute ?? {
            x: node.position.x + (parent?.position.x ?? 0),
            y: node.position.y + (parent?.position.y ?? 0),
          }),
          width: internal?.measured.width ?? node.measured?.width ?? node.width ?? 576,
          height: internal?.measured.height ?? node.measured?.height ?? node.height ?? 324,
        };
      };
      const { x, y } = placeBeside(rectOf(source), current.map(rectOf), size);
      const label = availableNodeLabel(
        `${source.data.label.slice(0, 245)} 标注`,
        current.map((node) => node.data.label),
      );
      return [
        ...current,
        {
          id,
          type: "creative",
          position: { x, y },
          data: {
            kind: "image",
            label,
            text: "",
            uploadProgress: 0,
            mediaAspect: aspect,
            uploaded: true,
          },
        },
      ];
    });
    setEdges((current) => [
      ...current,
      { id: crypto.randomUUID(), source: doodleTarget.nodeId, target: id },
    ]);
    setDoodleTarget(undefined);
    void doodleUploads.start(id, doodleTarget.asset.assetId, render);
    return true;
  };
  const splitImage = async ({ xLines, yLines }: GridSplitDraft) => {
    const columns = xLines.length + 1;
    const rows = yLines.length + 1;
    if (!splitTarget || busy || rows * columns > splitCapacity) return;
    const { nodeId, asset } = splitTarget;
    const source = nodes.find((node) => node.id === nodeId);
    const rect = source && absoluteNodeRect(source);
    if (!rect || source?.type !== "creative" || source.data.assetId !== asset.assetId) {
      setSplitError("图片节点的素材已变更，请重新打开拆图。");
      return;
    }
    setWriting(true);
    setSplitError("");
    try {
      const horizontal = gridBounds(xLines, rect.width);
      const vertical = gridBounds(yLines, rect.height);
      const sizes = Array.from({ length: rows * columns }, (_, index) => {
        const col = index % columns;
        const row = Math.floor(index / columns);
        return (
          imageFrameSize(
            (horizontal[col + 1] ?? rect.width) - (horizontal[col] ?? 0),
            (vertical[row + 1] ?? rect.height) - (vertical[row] ?? 0),
          ) ?? { width: 324, height: 324 }
        );
      });
      const positions = planGridPlacement(
        rect,
        nodes.map(
          (node) =>
            absoluteNodeRect(node) ?? {
              ...node.position,
              width: node.measured?.width ?? node.width ?? 280,
              height: node.measured?.height ?? node.height ?? 200,
            },
        ),
        sizes,
        columns,
      );
      const labels = new Set(nodes.map((node) => node.data.label));
      const planned: CreativeNode[] = sizes.map((size, index) => ({
        id: crypto.randomUUID(),
        type: "creative",
        position: positions[index] ?? rect,
        draggable: false,
        selectable: false,
        connectable: false,
        data: {
          kind: "image",
          label: gridNodeLabel(source.data.label, index, columns, labels),
          text: "",
          uploaded: true,
          splitPending: size,
        },
      }));
      const links = planned.map(({ id: target }) => ({
        id: crypto.randomUUID(),
        source: nodeId,
        target,
      }));
      setPendingGrid({ nodes: planned, edges: links });
      const saved = await saveCanvas(projectSession);
      if (!saved) {
        setSplitError("画布保存失败，请处理保存错误后重试。");
        return;
      }
      const operationId = crypto.randomUUID();
      setMediaOperationId(operationId);
      const result = await window.desktop.projects.splitAsset({
        projectHandle: saved.projectHandle,
        operationId,
        expectedRevision: saved.revision,
        assetId: asset.assetId,
        rows,
        columns,
        xLines,
        yLines,
      });
      if (!result.ok) {
        setSplitError(assetErrors[result.error.code] ?? "无法拆图，请检查图片尺寸和分割线。");
        return;
      }
      const tiles: CreativeNode[] = planned.map((node, index) => ({
        id: node.id,
        type: "creative",
        position: node.position,
        data: {
          kind: "image",
          label: node.data.label,
          text: "",
          assetId: result.value.assets[index]?.assetId,
          uploaded: true,
        },
      }));
      setNodes((current) => [...current, ...tiles]);
      setEdges((current) => [...current, ...links]);
      setAssets((current) => [...current, ...result.value.assets]);
      updateRevision(saved.projectHandle, result.value.revision);
      setSplitTarget(undefined);
    } catch {
      setSplitError("拆图未完成，请重试。");
    } finally {
      setPendingGrid(undefined);
      setMediaOperationId(undefined);
      setMediaCancelling(false);
      setWriting(false);
    }
  };
  const editableSelection = selected.filter((node) => node.type === "creative");
  const fragment = captureSelection(historyCanvas, new Set(selected.map(({ id }) => id)));
  const selectionBusy = writing || importing || dragging || !persistence.loaded;
  const insertClones = (source: CanvasFragment | undefined, position?: Point, offset?: number) => {
    if (!source || selectionBusy || nodes.length + source.nodes.length > 1000) return;
    const copies = cloneSelection(source, canvas, () => crypto.randomUUID(), position, offset);
    const newParents = new Set(
      copies.nodes.filter((node) => node.type === "group").map((node) => node.id),
    );
    if (edges.length + copies.edges.length > 4000) return;
    setAddMenu(undefined);
    setGenerationNodeId(undefined);
    setNodes((current) =>
      flowOrder([
        ...current.map((node) => (node.selected ? { ...node, selected: false } : node)),
        ...copies.nodes.map((node) =>
          node.type === "group"
            ? { ...node, selected: true, connectable: false }
            : { ...node, selected: !node.parentId || !newParents.has(node.parentId) },
        ),
      ]),
    );
    setEdges((current) => [
      ...current.map((edge) => (edge.selected ? { ...edge, selected: false } : edge)),
      ...copies.edges,
    ]);
  };
  const duplicateNodes = () => insertClones(fragment);
  const downloadSelection = async () => {
    const files = editableSelection.flatMap(({ data }) => (data.assetId ? [data.assetId] : []));
    if (!files.length) return setProjectError("选中的节点里还没有可下载的素材");
    for (const assetId of files) {
      const result = await window.desktop.projects.saveAssetCopy({
        projectHandle: projectSession.projectHandle,
        assetId,
      });
      if (!result.ok) setProjectError(assetErrors[result.error.code] ?? "无法保存原文件");
    }
  };
  const runArrangement = (
    targets: ReadonlyMap<string, Point>,
    settle: (current: FlowNode[]) => FlowNode[],
  ) => {
    if (!targets.size || cancelArrangement.current) return;
    const origins = new Map(
      nodes.filter((node) => targets.has(node.id)).map((node) => [node.id, node.position]),
    );
    setArrangement(origins);
    cancelArrangement.current = animateArrangement(origins, targets, setArrangement, () => {
      cancelArrangement.current = undefined;
      setNodes(settle);
      setArrangement(undefined);
    });
  };
  const arrangeNodes = (mode: ArrangeMode) => {
    if (selectionBusy) return;
    const parents = new Map(
      nodes.filter((node) => node.type === "group").map(({ id, position }) => [id, position]),
    );
    const positions = arrangeSelection(editableSelection.map(withMeasuredSize), parents, mode);
    runArrangement(positions, (current) =>
      current.map((node) => {
        const position = positions.get(node.id);
        return position ? { ...node, position } : node;
      }),
    );
  };
  const selectedGroup = inspected?.type === "group" ? inspected : undefined;
  const canUngroup =
    selectedGroup &&
    !nodes.some((node) => node.type === "unknown" && node.parentId === selectedGroup.id);
  const arrangeGroup = () => {
    if (!canUngroup || selectionBusy) return;
    const members = nodes
      .filter(
        (node): node is CreativeNode =>
          node.type === "creative" && node.parentId === selectedGroup.id,
      )
      .map(withMeasuredSize);
    if (members.length < 2) return;
    const positions = arrangeSelection(
      members,
      new Map([[selectedGroup.id, selectedGroup.position]]),
      "grid",
    );
    const boxes = members.map((node) => ({
      ...(positions.get(node.id) ?? node.position),
      width: node.measured?.width ?? 576,
      height: node.measured?.height ?? 324,
    }));
    const left = Math.min(...boxes.map((box) => box.x)) - 48;
    const top = Math.min(...boxes.map((box) => box.y)) - 72;
    const width = Math.max(200, ...boxes.map((box) => box.x + box.width - left + 48));
    const height = Math.max(140, ...boxes.map((box) => box.y + box.height - top + 48));
    runArrangement(positions, (current) =>
      current.map((node) => {
        if (node.id === selectedGroup.id)
          return {
            ...node,
            position: { x: node.position.x + left, y: node.position.y + top },
            width,
            height,
          };
        const target = positions.get(node.id);
        return target ? { ...node, position: { x: target.x - left, y: target.y - top } } : node;
      }),
    );
  };
  const editNode = (id: string, update: (node: FlowNode) => FlowNode) => {
    setNodes((current) => current.map((node) => (node.id === id ? update(node) : node)));
  };
  function enterDirector(id: string) {
    if (writing || directorNodeId === id) return;
    let available = false;
    try {
      const context = document.createElement("canvas").getContext("webgl2");
      available = !!context;
      context?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {}
    if (!available)
      return setProjectError("当前浏览器不支持 3D（WebGL2），请用新版 Chrome / Edge 打开导演台");
    setOutpaintTarget(undefined);
    setFrameTarget(undefined);
    setTrimTarget(undefined);
    setDirectorNodeId(id);
  }
  function writeDirectorScene(handle: string, id: string, scene: DirectorScene) {
    if (currentProjectHandle.current !== handle) return;
    editNode(id, (node) =>
      node.type === "creative" && node.data.director && node.data.director !== scene
        ? { ...node, data: { ...node.data, director: scene } }
        : node,
    );
  }
  async function attachDirectorThumbnail(handle: string, id: string, scene: DirectorScene) {
    const sameScene = () => {
      const node = flowInstance.current?.getNode(id);
      return (
        currentProjectHandle.current === handle &&
        node?.type === "creative" &&
        JSON.stringify(node.data.director) === JSON.stringify(scene)
      );
    };
    try {
      const { directorThumbnail } = await import("./director-export");
      const bytes = await directorThumbnail(scene);
      if (!bytes || !sameScene()) return;
      const result = await window.desktop.projects.attachImage({
        projectHandle: handle,
        operationId: crypto.randomUUID(),
        name: "director-thumb.jpg",
        bytes,
      });
      if (!result.ok) throw Error(assetErrors[result.error.code] ?? "无法保存导演台缩略图");
      if (currentProjectHandle.current !== handle) return;
      const { asset, revision } = result.value;
      updateRevision(handle, revision);
      setAssets((current) => [...current.filter((item) => item.assetId !== asset.assetId), asset]);
      editNode(id, (node) =>
        node.type === "creative" && JSON.stringify(node.data.director) === JSON.stringify(scene)
          ? { ...node, data: { ...node.data, directorThumbnailId: asset.assetId } }
          : node,
      );
    } catch (error) {
      if (sameScene())
        setProjectError(error instanceof Error ? error.message : "无法保存导演台缩略图");
    }
  }
  const fillNodeAsset = (id: string, asset: ProjectAsset, extra?: boolean) => {
    const node = flowInstance.current?.getNode(id);
    if (node?.type !== "creative" || node.data.kind !== asset.mediaType) return;
    if (!node.data.character) {
      if (
        flowInstance.current?.getEdges().some((edge) => edge.target === id && edge.data?.readOnly)
      ) {
        setProjectError("此节点的输入连线不可编辑");
        return;
      }
      if (
        node.data.assetId ||
        node.data.outputs?.length ||
        jobsRef.current.some((job) => job.nodeId === id && !jobIsTerminal(job.status))
      ) {
        setProjectError("只有空节点能上传");
        return;
      }
      setEdges((current) => current.filter((edge) => edge.target !== id));
    }
    editNode(id, (current) =>
      current.type === "creative"
        ? { ...current, data: bindNodeMedia(current.data, asset.assetId, extra) }
        : current,
    );
  };
  const bindAsset = (target: VisualMediaTarget, asset: ProjectAsset) => {
    if (asset.mediaType !== target.kind || asset.availability !== "ready") return;
    if (target.replaceAssetId) {
      const node = flowInstance.current?.getNode(target.nodeId);
      if (
        node?.type !== "creative" ||
        node.data.assetId !== target.replaceAssetId ||
        node.data.uploadProgress !== undefined ||
        jobsRef.current.some((job) => job.nodeId === target.nodeId && !jobIsTerminal(job.status))
      ) {
        setProjectError("节点已变化或正在生成，请重新选择图片");
        return;
      }
      const createdAt = new Date().toISOString();
      editNode(target.nodeId, (current) =>
        current.type === "creative" && current.data.assetId === target.replaceAssetId
          ? { ...current, data: replaceImageAsset(current.data, asset, createdAt) }
          : current,
      );
    } else fillNodeAsset(target.nodeId, asset, target.extra);
    setAssetTarget(undefined);
    setSidePanel(null);
  };
  const fanSources = (fan: Fan, kind: LinkKind) =>
    nodes.filter(
      (node) =>
        node.type === "creative" &&
        fan.ids.includes(node.id) &&
        node.data.uploadProgress === undefined &&
        linkPlan(linkKind(node.data), kind) !== false,
    );
  const openFan: OpenFan = (fan) => openAddMenu(fan.to, undefined, fan);
  const groupSources = selectedGroup
    ? nodes
        .filter((node) => node.parentId === selectedGroup.id && node.type === "creative")
        .map(({ id }) => id)
    : [];
  const groupNodes = () => {
    if (
      selectionBusy ||
      editableSelection.length !== selected.length ||
      editableSelection.length < 2 ||
      nodes.length >= 1000
    )
      return;
    const id = crypto.randomUUID();
    const children = new Map(
      editableSelection.map((node) => {
        const parent = node.parentId && nodes.find(({ id }) => id === node.parentId);
        const { measured } = withMeasuredSize(node);
        return [
          node.id,
          {
            x: node.position.x + (parent ? parent.position.x : 0),
            y: node.position.y + (parent ? parent.position.y : 0),
            width: measured?.width ?? 576,
            height: measured?.height ?? 324,
          },
        ];
      }),
    );
    const boxes = [...children.values()];
    const x = Math.min(...boxes.map((box) => box.x)) - 48;
    const y = Math.min(...boxes.map((box) => box.y)) - 72;
    const width = Math.max(200, ...boxes.map((box) => box.x + box.width - x + 48));
    const height = Math.max(140, ...boxes.map((box) => box.y + box.height - y + 48));
    const used = new Set(
      nodes.filter((node) => node.type === "group").map((node) => node.data.label),
    );
    let label = "组";
    for (let index = 2; used.has(label); index++) label = `组 ${index}`;
    setRenamingId(id);
    setGroupMenuId(id);
    setNodes((current) =>
      flowOrder([
        {
          id,
          type: "group",
          position: { x, y },
          width,
          height,
          data: { label },
          zIndex: -2000,
          selected: true,
          connectable: false,
        },
        ...current.map((node) => {
          const child = children.get(node.id);
          return child
            ? {
                ...node,
                parentId: id,
                selected: false,
                position: { x: child.x - x, y: child.y - y },
              }
            : { ...node, selected: false };
        }),
      ]),
    );
  };
  const ungroup = () => {
    if (!canUngroup || selectionBusy) return;
    setNodes((current) =>
      current
        .filter((node) => node.id !== selectedGroup.id)
        .map((node) =>
          node.parentId === selectedGroup.id
            ? {
                ...node,
                parentId: undefined,
                selected: true,
                position: {
                  x: node.position.x + selectedGroup.position.x,
                  y: node.position.y + selectedGroup.position.y,
                },
              }
            : node,
        ),
    );
  };
  const defaultPlacement = () => {
    const center = { x: window.innerWidth / 2, y: window.innerHeight * 0.4 };
    const point = flowInstance.current?.screenToFlowPosition(center) ?? center;
    return canvasAnchorPosition(point, 0.5, 0.5);
  };
  const pastePosition = (point?: Point) => {
    const flow = flowInstance.current;
    return flow && point ? flow.screenToFlowPosition(point) : defaultPlacement();
  };
  const openAddMenu = (point: Point, pending?: PendingLink, fan?: Fan) => {
    const bounds = canvasArea.current?.getBoundingClientRect();
    const flow = flowInstance.current;
    if (!bounds || !flow || !persistence.loaded || writing) return;
    setAddMenu({
      pending,
      fan,
      position: flow.screenToFlowPosition(point),
      anchor: point,
    });
  };
  const addNode = (
    kind: NodeKind | "character" | "storyboard" | "director",
    position = defaultPlacement(),
    dramaScope?: DramaScope,
    placed = false,
  ) => {
    if (!persistence.loaded || writing || nodes.length >= 1000) return;
    const id = crypto.randomUUID();
    const names = {
      ...NODE_LABELS,
      storyboard: "分镜表",
      director: "导演台",
      character: defaultCharacter.name,
    };
    setNodes((current) => {
      const label = availableNodeLabel(
        names[kind],
        current.map((node) => node.data.label),
      );
      const data: CreativeData = { kind: "script", label, text: "", ...newNodeModel(kind) };
      switch (kind) {
        case "character":
          data.kind = "image";
          data.character = { ...defaultCharacter, name: label };
          break;
        case "storyboard":
          data.storyboard = [];
          break;
        case "director":
          data.director = defaultDirectorScene();
          break;
        default:
          data.kind = kind;
      }
      const scope =
        dramaScope ??
        (dramaCanvasSlot
          ? { type: kind === "character" ? ("character" as const) : undefined, episodes: [] }
          : undefined);
      if (scope) data.drama = scopedDramaData(scope, label);
      return [
        ...current.map((node) => (node.selected ? { ...node, selected: false } : node)),
        { id, type: "creative", position, selected: true, data },
      ];
    });
    if (kind === "character" || isGenerationMedia(kind)) {
      setPlacedGenerationId(placed ? id : undefined);
      setGenerationNodeId(id);
    }
    return id;
  };

  const chooseMenuNode = (kind: LinkKind) => {
    if (!addMenu || !acceptsMenuKind(addMenu.pending, kind)) return;
    const { position, pending, fan } = addMenu;
    const sources = fan ? fanSources(fan, kind) : [];
    if (fan && (!sources.length || edges.length + sources.length > 4000)) return;
    if (pending && !nodes.some((node) => node.id === pending.id)) return setAddMenu(undefined);
    const id = addNode(
      kind,
      fan ? canvasAnchorPosition(position, 0, 0.5) : droppedPosition({ position, pending }),
      undefined,
      !addMenu.toolbar,
    );
    if (id && fan) {
      const nextMode = sources.reduce<CreativeData["videoMode"]>((mode, source) => {
        if (source.type !== "creative" || kind !== "video") return mode;
        return (
          mediaLinkMode(linkKind(source.data), kind, generationProviders, {
            ...newNodeModel(kind),
            videoMode: mode,
          }) || mode
        );
      }, undefined);
      applyLinkMode(id, nextMode);
      setEdges((current) => [
        ...current,
        ...sources.map(({ id: source }) => ({ id: crypto.randomUUID(), source, target: id })),
      ]);
      const skipped = fan.ids.length - sources.length;
      if (skipped) {
        const label =
          kind in NODE_LABELS
            ? NODE_LABELS[kind as NodeKind]
            : nodeMenuItems.find(([value]) => value === kind)?.[1];
        reportLinkNotice(`${skipped} 个节点接不到${label}上，已跳过`);
      }
    }
    if (id && pending) {
      const source = pending.type === "source" ? pending.id : id;
      const target = pending.type === "source" ? id : pending.id;
      const endpoint = nodes.find((node) => node.id === pending.id);
      if (endpoint?.type === "creative")
        applyLinkMode(
          target,
          pending.type === "source"
            ? linkPlan(pending.kind, kind)
            : linkPlan(kind, pending.kind, endpoint.data),
        );
      setEdges((current) => [...current, { id: crypto.randomUUID(), source, target }]);
    }
    setAddMenu(undefined);
  };

  const linkedShotNodes = (sourceId: string, kind: "image" | "video") => {
    const board = nodes.find((node) => node.id === sourceId);
    const rows = board?.type === "creative" ? (board.data.storyboard ?? []) : [];
    const explicit = new Map(
      rows.map((row) => [kind === "image" ? row.imageNodeId : row.videoNodeId, row.id]),
    );
    const children = new Set(
      edges
        .filter((edge) => edge.source === sourceId && !edge.data?.readOnly)
        .map(({ target }) => target),
    );
    return nodes.flatMap((node) => {
      if (node.type !== "creative" || node.data.kind !== kind) return [];
      const shotId =
        explicit.get(node.id) ?? (children.has(node.id) ? node.data.shotId : undefined);
      return shotId ? [{ ...node, data: { ...node.data, shotId } }] : [];
    });
  };

  const upstreamScriptText = (sourceId: string) => {
    const parts = edges
      .filter((edge) => edge.target === sourceId)
      .map((edge) => nodes.find((node) => node.id === edge.source))
      .filter(
        (node): node is CreativeNode =>
          node?.type === "creative" &&
          node.data.kind === "script" &&
          !node.data.storyboard &&
          !node.data.director,
      )
      .map((node) => node.data.text.trim());
    return { connected: parts.length > 0, text: parts.filter(Boolean).join("\n\n") };
  };

  const submitStoryboardSplit = async (
    source: CreativeNode,
    prompt: string,
    provider: ProviderView,
    mode: "replace" | "append",
  ) => {
    if (!projectSession || writing) return "画布正在更新，请稍后重试。";
    setWriting(true);
    try {
      const session = await saveCanvas(projectSession);
      if (!session) return "画布保存失败，请保存后重试。";
      const current = await window.desktop.projects.getCanvas({
        projectHandle: session.projectHandle,
      });
      if (!current.ok) return "无法读取最新画布，请重试。";
      const result = await window.desktop.projects.submitJob({
        projectHandle: session.projectHandle,
        confirmed: true,
        operationId: crypto.randomUUID(),
        generation: {
          nodeId: source.id,
          prompt,
          purpose: "storyboard-split",
          storyboardSplitMode: mode,
          referenceAssetIds: [],
          providerId: provider.id,
          expectedProviderRevision: provider.revision,
          expectedCanvasRevision: current.value.canvasRevision,
        },
      });
      if (!result.ok) return result.error.code;
      setJobs((current) => [result.value, ...current.filter((job) => job.id !== result.value.id)]);
    } finally {
      setWriting(false);
    }
  };

  const prepareShotNode = (
    source: CreativeNode,
    shotId: string,
    kind: "video" | "image",
    reserved: Rect[] = [],
  ): { error?: string; nodeId?: string; prompt?: string } => {
    const rows = source.data.storyboard ?? [];
    const index = rows.findIndex((row) => row.id === shotId);
    const row = rows[index];
    if (!row) return {};
    const number = String(index + 1).padStart(2, "0");
    if (!row.scene.trim()) return { error: `先写第 ${number} 镜的画面描述` };
    const image = linkedShotNodes(source.id, "image").find((node) => node.data.shotId === shotId);
    const existing =
      kind === "image"
        ? image
        : linkedShotNodes(source.id, "video").find((node) => node.data.shotId === shotId);
    const priorJob =
      existing &&
      jobs
        .filter((job) => job.nodeId === existing.id)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    const providerId =
      existing?.data.generation?.providerId ??
      existing?.data.generation?.modelKey ??
      priorJob?.providerId ??
      newNodeModel(kind).generation?.providerId;
    const seed =
      kind === "video"
        ? seedShotVideo(row, generationProviders, image, providerId)
        : { data: { text: shotImagePrompt(row) }, imageSource: undefined };
    if (existing) {
      editNode(existing.id, (node) => {
        if (node.type !== "creative") return node;
        const data = { ...node.data, ...seed.data };
        if ("videoDuration" in seed.data && data.generation) {
          const { durationInput: _manual, params, ...configuration } = data.generation;
          const { duration: _seconds, ...otherParams } = params ?? {};
          data.generation = { ...configuration, params: otherParams };
        }
        return { ...node, data };
      });
      return { nodeId: existing.id, prompt: seed.data.text };
    }
    if (
      nodes.length + reserved.length >= 1000 ||
      edges.length + reserved.length + 1 + Number(!!seed.imageSource) > 4000
    )
      return { error: "画布节点或连线数量已达上限" };
    const origin = absoluteNodeRect(source);
    if (!origin) return {};
    const base = `镜头 ${number}${kind === "video" ? " 视频" : ""}`;
    const labels = new Set(nodes.map((node) => node.data.label));
    let label = base;
    for (let suffix = 2; labels.has(label); suffix++) label = `${base} ${suffix}`;
    const left = origin.x + origin.width + 80;
    let top = origin.y + index * 364;
    const boxes = [...nodes.flatMap((node) => absoluteNodeRect(node) ?? []), ...reserved];
    while (
      boxes.some(
        (box) =>
          left < box.x + box.width + 40 &&
          box.x < left + 616 &&
          top < box.y + box.height + 40 &&
          box.y < top + 364,
      )
    )
      top += 364;
    reserved.push({ x: left, y: top, width: 576, height: 324 });
    const id = crypto.randomUUID();
    const linkField = kind === "video" ? "videoNodeId" : "imageNodeId";
    setNodes((current) => [
      ...current.map((node) =>
        node.id === source.id && node.type === "creative"
          ? {
              ...node,
              data: {
                ...node.data,
                storyboard: node.data.storyboard?.map((item) =>
                  item.id === shotId ? { ...item, [linkField]: id } : item,
                ),
              },
            }
          : node,
      ),
      {
        id,
        type: "creative",
        position: { x: left, y: top },
        data: {
          kind,
          label,
          shotId,
          ...seed.data,
          ...(providerId && { generation: { providerId } }),
        },
      },
    ]);
    const sources = seed.imageSource ? [source.id, seed.imageSource] : [source.id];
    setEdges((current) => [
      ...current,
      ...sources.map((sourceId) => ({ id: crypto.randomUUID(), source: sourceId, target: id })),
    ]);
    return { nodeId: id, prompt: seed.data.text };
  };

  const submitNodeJobs = async (
    targets: (Pick<
      GenerationInput,
      "nodeId" | "prompt" | "purpose" | "afterImageJobId" | "duration"
    > & {
      provider: ProviderView;
      id?: string;
      referenceAssetIds?: string[];
    })[],
  ) => {
    if (!projectSession || writing) return "画布正在更新，请稍后重试。";
    setWriting(true);
    try {
      const session = await saveCanvas(projectSession);
      if (!session) return "画布保存失败，请保存后重试。";
      const { projectHandle } = session;
      const current = await window.desktop.projects.getCanvas({ projectHandle });
      if (!current.ok) return "无法读取最新画布，请重试。";
      const result = await window.desktop.projects.submitJobs({
        projectHandle,
        confirmed: true,
        entries: targets.map(({ provider, id, ...target }) => ({
          id: id ?? crypto.randomUUID(),
          input: {
            ...target,
            referenceAssetIds: target.referenceAssetIds ?? [],
            providerId: provider.id,
            expectedProviderRevision: provider.revision,
            expectedCanvasRevision: current.value.canvasRevision,
          },
        })),
      });
      if (!result.ok) {
        const messages: Record<string, string> = {
          JOB_INPUT_INVALID:
            result.error.message ??
            `${result.error.code}：参数与模型不匹配，或节点已有同类任务。请检查提示词与模型。`,
          JOB_MODEL_UNAVAILABLE: "模型当前不可用，请检查模型设置。",
          CANVAS_REVISION_CONFLICT: "画布刚刚更新，请重试。",
        };
        return (
          result.error.message ??
          messages[result.error.code] ??
          `${result.error.code}：生成任务提交失败，请重试。`
        );
      }
      setJobs((current) => [
        ...result.value.filter(({ id }) => !current.some((job) => job.id === id)),
        ...current,
      ]);
      showSubmissionWarning(result.value);
    } finally {
      setWriting(false);
    }
  };

  const addAssetNode = (asset: ProjectAsset, position = defaultPlacement()) => {
    if (!persistence.loaded) return;
    const node = {
      id: crypto.randomUUID(),
      type: "creative" as const,
      position,
      selected: true,
      data: {
        kind: asset.mediaType,
        label: assetNodeLabel(asset.displayName, NODE_LABELS[asset.mediaType]),
        text: "",
        assetId: asset.assetId,
        uploaded: true as const,
      },
    };
    setNodes((current) =>
      current.length >= 1000
        ? current
        : [
            ...current.map((item) => (item.selected ? { ...item, selected: false } : item)),
            {
              ...node,
              data: {
                ...node.data,
                label: availableNodeLabel(
                  node.data.label,
                  current.map((item) => item.data.label),
                ),
              },
            },
          ],
    );
    return node.id;
  };

  const recoverCanvas = async (discard: boolean) => {
    if (discard && !window.confirm("放弃当前未保存的画布改动并重新载入？")) return;
    setWriting(true);
    setRecoveryError("");
    try {
      const recovered = await persistence.recover(projectSession, discard);
      if (!recovered) {
        setRecoveryError("无法自动合并这些改动。当前画布已保留，可先复制需要的节点内容。");
        return;
      }
      restoreCanvas(recovered);
      history.reset(recovered);
      setCanvasMount((current) => current + 1);
    } finally {
      setWriting(false);
    }
  };

  const preserveConflict = async () => {
    if (busy) return;
    setWriting(true);
    setRecoveryError("");
    setExchangeStage("正在保全本地画布…");
    try {
      const seed = canvasSeed(canvas, projectSession.projectHandle);
      const location = await window.desktop.dialogs.selectProjectParent();
      if (!location.ok) throw new Error(location.error.code);
      if (location.value.cancelled) return;
      const name = `${projectSession.name.slice(0, 90)}（本地副本）`;
      const result = await window.desktop.projects.create({
        directoryToken: location.value.directoryToken,
        operationId: crypto.randomUUID(),
        projectKind: "canvas",
        name,
        canvasSeed: seed,
      });
      if (!result.ok) throw new Error(`无法创建副本（${result.error.code}），未放弃本地修改。`);
      const closed = await window.desktop.projects.close({
        projectHandle: result.value.projectHandle,
      });
      const recovered = await persistence.recover(projectSession, true);
      if (!recovered) {
        setRecoveryError(`已另存「${name}」，原项目重新载入失败。`);
        return;
      }
      restoreCanvas(recovered);
      history.reset(recovered);
      setCanvasMount((value) => value + 1);
      setProjectError(
        `已将本地版本另存为「${name}」，原项目已加载最新版本。${closed.ok ? "" : "副本仍在此窗口打开。"}`,
      );
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : "另存失败，本地修改已保留。");
    } finally {
      setWriting(false);
      setExchangeStage("");
    }
  };
  const relocate = async (asset: ProjectAsset) => {
    setWriting(true);
    setProjectError("");
    const { projectHandle } = projectSession;
    try {
      const selected = await window.desktop.dialogs.selectMedia({
        projectHandle,
        multiSelect: false,
      });
      if (!selected.ok) return setProjectError(assetErrors[selected.error.code] ?? "无法选择文件");
      if (selected.value.cancelled || !selected.value.files[0]) return;
      const result = await window.desktop.projects.relocateAsset({
        projectHandle,
        assetId: asset.assetId,
        fileToken: selected.value.files[0].fileToken,
      });
      if (!result.ok) setProjectError(assetErrors[result.error.code] ?? "重新定位失败");
      await refreshAssets(projectHandle);
    } finally {
      setWriting(false);
    }
  };

  const openPreview = async (asset: ProjectAsset) => {
    setProjectError("");
    const { projectHandle } = projectSession;
    const result = await window.desktop.projects.getAssetPreview({
      projectHandle,
      assetId: asset.assetId,
    });
    if (result.ok) setPreview({ asset, url: result.value.url });
    else {
      setProjectError(assetErrors[result.error.code] ?? "无法预览素材");
      await refreshAssets(projectHandle);
    }
  };
  const openComposition = async () => {
    if (!projectSession || busy) return;
    setProjectError("");
    setWriting(true);
    try {
      if (!(await saveCanvas(projectSession))) return;
      setCompositionOpen(true);
    } finally {
      setWriting(false);
    }
  };
  const exportCanvasExchange = async () => {
    if (busy || exportAttempt.current) return;
    const attempt = new AbortController();
    exportAttempt.current = attempt;
    setWriting(true);
    setExchangeStage("正在保存画布…");
    try {
      if (!(await saveCanvas(projectSession)) || attempt.signal.aborted) return;
      setExchangeStage("正在生成画布交换文件…");
      const exported = await runCanvasExport([canvas, projectSession.name, assets], attempt.signal);
      if (attempt.signal.aborted) return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([exported.json], { type: "application/json" }));
      link.download = `${sanitizeFileName(projectSession.name.trim()) || "未命名画布"}.canvas.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      setProjectError(exported.skippedAssets ? `已跳过 ${exported.skippedAssets} 个缺失素材` : "");
    } catch (error) {
      if (!attempt.signal.aborted)
        setProjectError(error instanceof Error ? error.message : "导出失败");
    } finally {
      exportAttempt.current = null;
      setExchangeStage("");
      setWriting(false);
    }
  };
  const importCanvasExchange = () => {
    if (!projectSession || writing) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      void (async () => {
        setWriting(true);
        setProjectError("");
        try {
          if (!(await saveCanvas(projectSession))) return;
          if (file.size > 10 * 1024 * 1024) throw new Error("交换文件超过 10 MB 限制");
          const raw = JSON.parse(await file.text());
          const prepared =
            raw?.format === "video-canvas/canvas"
              ? prepareVideoCanvasExchange(raw, assets)
              : prepareCanvasExchange(
                  parseCanvasExchange(raw),
                  new Set(assets.map(({ assetId }) => assetId)),
                );
          if (prepared.document.nodes.length + nodes.length > 1000)
            throw new Error("导入后节点数量超过 1000 个上限");
          if (prepared.document.edges.length + edges.length > 4000)
            throw new Error("导入后连线数量超过 4000 条上限");
          restoreCanvas(mergeCanvasExchange(canvas, prepared.document, () => crypto.randomUUID()));
          const notices = [
            ...(prepared.report.missingAssetIds.length
              ? [`${prepared.report.missingAssetIds.length} 个素材引用无法在当前项目中定位`]
              : []),
            ...(prepared.report.droppedEdgeCount
              ? [`已跳过 ${prepared.report.droppedEdgeCount} 条无效连线`]
              : []),
          ];
          if (notices.length) setProjectError(`已合并画布，${notices.join("，")}。`);
        } catch (error) {
          setProjectError(error instanceof Error ? error.message : "画布交换文件无效");
        } finally {
          setWriting(false);
        }
      })();
    };
    input.click();
  };
  const outputAsset = (output: CreativeOutput) =>
    output.assetId ? assets.find(({ assetId }) => assetId === output.assetId) : undefined;
  const downloadOutput = async (output: CreativeOutput, name?: string) => {
    const asset = outputAsset(output);
    if (!asset || !projectSession) return;
    const result = await window.desktop.projects.getAssetPreview({
      projectHandle: projectSession.projectHandle,
      assetId: asset.assetId,
    });
    if (!result.ok) return;
    const link = document.createElement("a");
    const fileName = sanitizeFileName(
      name ? name + (asset.displayName.match(/\.[a-z0-9]{1,8}$/i)?.[0] ?? "") : asset.displayName,
    );
    link.href = `${result.value.url}/download/${encodeURIComponent(fileName)}`;
    link.download = fileName;
    link.click();
  };

  const versionNode = nodes.find((node) => node.type === "creative" && node.id === versionNodeId);
  const generationNode = canvas.nodes.find(
    (node): node is Extract<typeof node, { type: "creative" }> =>
      node.id === generationNodeId &&
      node.type === "creative" &&
      !node.data.uploaded &&
      characterShowsGenerator(node.data),
  );
  const inlineGeneration =
    !!generationNode && generationNode.id === inspected?.id && sidePanel !== "jobs";
  const submitGeneration = async (
    input: Omit<GenerationInput, "expectedCanvasRevision">,
    operationId: string,
    stayOnNode = false,
    voice?: {
      id: string;
      input: Pick<GenerationInput, "prompt" | "providerId" | "expectedProviderRevision">;
    },
  ) => {
    setWriting(true);
    try {
      const session = await saveCanvas(projectSession);
      if (!session) return "请先保存画布";
      const current = await window.desktop.projects.getCanvas({
        projectHandle: session.projectHandle,
      });
      if (!current.ok) return current.error.code;
      const result = await window.desktop.projects.submitJobs({
        projectHandle: session.projectHandle,
        confirmed: true,
        entries: [
          {
            id: operationId,
            input: { ...input, expectedCanvasRevision: current.value.canvasRevision },
          },
          ...(voice
            ? [
                {
                  id: voice.id,
                  input: {
                    ...voice.input,
                    nodeId: input.nodeId,
                    expectedCanvasRevision: current.value.canvasRevision,
                    referenceAssetIds: [],
                    purpose: "character-voice" as const,
                    afterImageJobId: operationId,
                  },
                },
              ]
            : []),
        ],
      });
      if (!result.ok) return result.error.message ?? result.error.code;
      setJobs((previous) => [
        ...result.value,
        ...previous.filter((job) => !result.value.some((member) => member.id === job.id)),
      ]);
      showSubmissionWarning(result.value);
      if (!stayOnNode) {
        setGenerationNodeId(undefined);
        setSidePanel("jobs");
      }
    } finally {
      setWriting(false);
    }
  };
  const generateDramaAssets = async (ids: string[], withVoice: boolean) => {
    if (assetBatchLock.current || writing || importing) return;
    assetBatchLock.current = true;
    setAssetBatchBusy(true);
    setWriting(true);
    const handle = projectSession.projectHandle,
      blocked: string[] = [];
    let started = 0,
      voiced = 0;
    try {
      const session = await saveCanvas(projectSession);
      if (!session) {
        reportFillError("画布保存失败，请保存后重试。");
        return;
      }
      for (const id of new Set(ids)) {
        if (currentProjectHandle.current !== handle) return;
        try {
          const current = await window.desktop.projects.getCanvas({ projectHandle: handle });
          if (!current.ok) {
            blocked.push(current.error.message ?? current.error.code);
            continue;
          }
          const graph = current.value.canvas,
            node = graph.nodes.find((item) => item.id === id);
          if (
            node?.type !== "creative" ||
            node.data.kind !== "image" ||
            !node.data.drama?.episodes ||
            !(
              node.data.character ||
              ("type" in node.data.drama && ["scene", "prop"].includes(node.data.drama.type))
            ) ||
            node.data.uploaded ||
            (node.data.character && !characterShowsGenerator(node.data))
          ) {
            blocked.push("该资产已不可生成");
            continue;
          }
          const running = new Set(
            jobsRef.current
              .filter((job) => job.purpose !== "character-voice" && !jobIsTerminal(job.status))
              .map((job) => job.nodeId),
          );
          if (running.has(id)) {
            blocked.push("该节点已有任务在运行");
            continue;
          }
          const image = assetImageInput({
            id,
            data: node.data,
            settings: generationProviders,
            assets,
            graph,
            runningNodes: running,
          });
          if ("error" in image) {
            blocked.push(image.error);
            continue;
          }
          const voiceJobs = jobsRef.current.filter(
            (job) => job.nodeId === id && job.purpose === "character-voice",
          );
          const voice = withVoice
            ? voiceJobs.some((job) => !jobIsTerminal(job.status))
              ? { error: "音色正在生成" }
              : voiceJobs[0]?.status === "outcome_unknown"
                ? { error: "请在生成任务中核对原任务" }
                : assetVoiceInput(node.data, generationProviders)
            : undefined;
          const parent = crypto.randomUUID(),
            expectedCanvasRevision = current.value.canvasRevision;
          const entries = [
            { id: parent, input: { ...image.input, expectedCanvasRevision } },
            ...(voice && "provider" in voice && voice.provider
              ? [
                  {
                    id: crypto.randomUUID(),
                    input: {
                      nodeId: id,
                      prompt: voice.prompt,
                      providerId: voice.provider.id,
                      expectedProviderRevision: voice.provider.revision,
                      purpose: "character-voice" as const,
                      afterImageJobId: parent,
                      referenceAssetIds: [],
                      expectedCanvasRevision,
                    },
                  },
                ]
              : []),
          ];
          const result = await window.desktop.projects.submitJobs({
            projectHandle: handle,
            confirmed: true,
            entries,
          });
          if (!result.ok) {
            blocked.push(result.error.message ?? result.error.code);
            continue;
          }
          if (currentProjectHandle.current !== handle) return;
          setJobs((previous) => [
            ...result.value,
            ...previous.filter((job) => !result.value.some((member) => member.id === job.id)),
          ]);
          showSubmissionWarning(result.value);
          started++;
          if (voice?.error) blocked.push(`音色：${voice.error}`);
          else if (voice) voiced++;
        } catch {
          blocked.push("生成任务提交失败，请重试。");
        }
      }
      if (currentProjectHandle.current !== handle) return;
      if (started)
        toast.success(
          withVoice
            ? `已提交 ${started} 个形象，其中 ${voiced} 个出图后生成音色`
            : `已提交 ${started} 个生成任务`,
          canvasNotice,
        );
      if (blocked.length)
        toast.warning(`有 ${blocked.length} 项没能提交：${blocked[0]}`, canvasNotice);
    } finally {
      assetBatchLock.current = false;
      setAssetBatchBusy(false);
      setWriting(false);
    }
  };
  const generationForm = generationNode && !isGenerationMedia(generationNode.data.kind) && (
    <GenerationForm
      key={generationNode.id}
      inline={inlineGeneration}
      node={generationNode}
      settings={generationProviders}
      assets={assets}
      close={() => setGenerationNodeId(undefined)}
      submit={(input, key) => submitGeneration(input, key)}
    />
  );
  const togglePanel = (panel: NonNullable<typeof sidePanel>) => {
    if (panel === "assets" && sidePanel !== panel && activeHandle) void refreshAssets(activeHandle);
    setAddMenu(undefined);
    setAssetPlacement(undefined);
    setAssetTarget(undefined);
    setSidePanel(sidePanel === panel ? null : panel);
  };
  const revealGeneration = (id: string, visual = false) => {
    setPlacedGenerationId(undefined);
    setGenerationNodeId(id);
    if (sidePanel === "jobs") setSidePanel(null);
    const bounds = canvasArea.current?.getBoundingClientRect();
    const flow = flowInstance.current;
    if (!flow || !bounds) return;
    const node = flow.getNodesBounds([id]);
    if (dramaCanvasSlot && visual && node.height > 0 && node.width > 0) {
      const top = 88,
        panel = Math.min(265, bounds.height * 0.42),
        zoom = Math.min(
          flow.getZoom(),
          Math.max(0.15, (bounds.height - top - panel) / node.height),
          (bounds.width - 24) / node.width,
        );
      void flow.setViewport({
        x: bounds.width / 2 - (node.x + node.width / 2) * zoom,
        y: top - node.y * zoom,
        zoom,
      });
      return;
    }
    const zoom = flow.getZoom();
    const corner = flow.flowToScreenPosition({ x: node.x, y: node.y + node.height });
    const halfWidth = 190;
    const center = visual
      ? corner.x + (node.width * zoom) / 2
      : Math.max(
          bounds.left + halfWidth,
          Math.min(corner.x + (node.width * zoom) / 2, bounds.right - halfWidth),
        );
    const panelHeight = visual
      ? Math.min(300, bounds.height * 0.44)
      : Math.min(445, bounds.height * 0.58);
    const bottom = Math.max(bounds.top + 70, Math.min(corner.y, bounds.bottom - panelHeight - 50));
    if (Math.abs(center - (corner.x + (node.width * zoom) / 2)) < 1 && bottom === corner.y) return;
    const view = flow.getViewport();
    void flow.setViewport({
      x: view.x + center - (corner.x + (node.width * zoom) / 2),
      y: view.y + bottom - corner.y,
      zoom,
    });
  };
  const retryGeneration = (id: string, purpose?: GenerationJob["purpose"]) => {
    const node = nodes.find((item) => item.id === id);
    if (node?.type !== "creative") return;
    if (purpose === "character-voice") {
      if (node.data.character) setCharacterNodeId(id);
      return;
    }
    if (isGenerationMedia(node.data.kind)) {
      setNodes((current) => current.map((item) => ({ ...item, selected: item.id === id })));
      revealGeneration(id, true);
    } else setGenerationNodeId(id);
  };

  const changeView = (action: "in" | "out" | "fit" | "reset") => {
    const flow = flowInstance.current;
    if (!flow) return;
    const options = { duration: 300 };
    if (action === "in") void flow.zoomIn(options);
    else if (action === "out") void flow.zoomOut(options);
    else if (action === "reset") void flow.zoomTo(1, options);
    else void flow.fitView({ ...options, padding: 0.2 });
  };

  const splitResultNotice = splitNotice && (
    <div role="status" className="shot-batch-notice">
      已覆盖为 {splitNotice.count} 个镜头{" "}
      <button
        type="button"
        onClick={() => {
          history.restore("undo");
          setSplitNotice(undefined);
        }}
      >
        撤销
      </button>
    </div>
  );
  const attachFiled = async ({ channel, image }: FiledChoice["filed"]) => {
    const { projectHandle } = projectSession;
    const result = await window.desktop.projects.attachFiledImage({
      projectHandle,
      operationId: crypto.randomUUID(),
      channelId: channel.id,
      channelRevision: channel.revision,
      imageId: image.id,
    });
    if (!result.ok) throw new Error(result.error.messageKey);
    const { asset, revision } = result.value;
    setAssets((current) => [...current.filter((item) => item.assetId !== asset.assetId), asset]);
    updateRevision(projectHandle, revision);
    return asset;
  };
  const applyCharacterAssets = (
    id: string,
    purpose: CharacterPurpose | "human",
    batch: ProjectAsset[],
  ) => {
    const ids = batch
      .filter((item) => item.mediaType === (purpose === "voice" ? "audio" : "image"))
      .map((item) => item.assetId);
    if (!ids.length) return;
    const now = new Date().toISOString();
    editNode(id, (node) => {
      if (node.type !== "creative" || !node.data.character) return node;
      return {
        ...node,
        data: bindCharacterMedia(
          node.data,
          purpose,
          ids,
          now,
          batch.find((asset) => asset.assetId === ids[0])?.displayName,
        ),
      };
    });
  };
  const uploadPickerFile: PickerUpload = async (file, signal, progress, duplicate) => {
    const imported = await importPickerFile(
      projectSession,
      importMode,
      file,
      signal,
      progress,
      duplicate,
      assetErrors,
    );
    if (!imported || currentProjectHandle.current !== projectSession.projectHandle) return;
    const { asset, revision } = imported;
    setAssets((current) => [asset, ...current.filter((item) => item.assetId !== asset.assetId)]);
    updateRevision(projectSession.projectHandle, revision);
    return asset;
  };
  const attachOfficialVoice = async (file: string) => {
    const { projectHandle } = projectSession;
    const result = await window.desktop.projects.attachOfficialVoice({
      projectHandle,
      file,
      operationId: crypto.randomUUID(),
    });
    if (!result.ok || currentProjectHandle.current !== projectHandle)
      throw new Error("无法引入官方音色");
    const { asset, revision } = result.value;
    setAssets((current) => [asset, ...current.filter((item) => item.assetId !== asset.assetId)]);
    updateRevision(projectHandle, revision);
    return asset;
  };
  const attachLibrary = async (itemId: string) => {
    const { projectHandle } = projectSession;
    const result = await window.desktop.projects.attachLibrary({
      projectHandle,
      itemId,
      operationId: crypto.randomUUID(),
    });
    if (!result.ok || currentProjectHandle.current !== projectHandle)
      throw new Error("个人库素材引入失败");
    const { asset, revision } = result.value;
    setAssets((current) => [asset, ...current.filter((item) => item.assetId !== asset.assetId)]);
    updateRevision(projectHandle, revision);
    return asset;
  };
  const renderMediaForm = (
    visualNode: CreativeNode,
    closeDialog?: () => void,
    locate?: (id: string) => void,
  ) => {
    const character = visualNode.data.character;
    const model = character && characterVoiceModel(character, generationProviders);
    const prompt = character?.voicePrompt?.trim();
    const voiceJobs = character
      ? jobs.filter((job) => job.nodeId === visualNode.id && job.purpose === "character-voice")
      : [];
    const pending = voiceJobs.find((job) => !jobIsTerminal(job.status));
    const voiceReason = pending
      ? pending.status === "queued" && pending.afterImageJobId
        ? "出图后会接着生成音色"
        : "音色正在生成"
      : voiceJobs[0]?.status === "outcome_unknown"
        ? "请在生成任务中核对原任务"
        : !prompt
          ? "还没有音色描述"
          : !model?.voiceModel
            ? "没有可用的音频模型"
            : model.requiresImageURL
              ? "音色模型需要公网参考图地址"
              : undefined;
    return (
      <GenerationForm
        voiceSubmission={
          model && {
            reason: voiceReason,
            credits: model.credits,
            input:
              prompt && model.voiceModel
                ? {
                    prompt,
                    providerId: model.voiceModel.id,
                    expectedProviderRevision: model.voiceModel.revision,
                  }
                : undefined,
          }
        }
        editCharacter={character && (() => setCharacterNodeId(visualNode.id))}
        key={visualNode.id}
        formRef={closeDialog ? undefined : mediaForm}
        dialogOnly={!!closeDialog}
        reportDraft={closeDialog ? undefined : setMountedDraft}
        inline
        node={visualNode}
        settings={generationProviders}
        assets={assets}
        linkedSources={linkedMediaSources(
          canvas,
          visualNode.id,
          runningReferenceNodes,
          pendingVoiceNodes,
        )}
        graph={canvas}
        projectHandle={projectSession.projectHandle}
        onVoicePicker={(validate, apply) => setVoicePick({ validate, apply })}
        onUploadReference={async (file) => {
          let uploaded = false;
          await importMedia(undefined, [file], (asset) => {
            editNode(visualNode.id, (current) => {
              if (current.type !== "creative") return current;
              const ids = current.data.manualReferenceIds ?? [];
              if (ids.includes(asset.assetId)) return current;
              return {
                ...current,
                data: { ...current.data, manualReferenceIds: [...ids, asset.assetId] },
              };
            });
            uploaded = true;
          });
          if (!uploaded) throw new Error("导入未完成");
        }}
        onManualReferencesChange={(ids) =>
          editNode(visualNode.id, (current) =>
            current.type === "creative"
              ? { ...current, data: { ...current.data, manualReferenceIds: ids } }
              : current,
          )
        }
        onSettingsChange={(patch) =>
          editNode(visualNode.id, (current) =>
            current.type === "creative"
              ? { ...current, data: { ...current.data, ...patch } }
              : current,
          )
        }
        runningNodes={busyGenerationTargets}
        runningReferenceNodes={runningReferenceNodes}
        onMentionLink={(source, withTyping) =>
          onConnect(
            { source, target: visualNode.id, sourceHandle: null, targetHandle: null },
            withTyping,
          )
        }
        onLocateReference={(id) => {
          if (locate) locate(id);
          else
            void flowInstance.current?.fitView({
              nodes: [{ id }],
              duration: 320,
              padding: 0.8,
              maxZoom: 1,
            });
        }}
        onUnlinkReference={(sourceId) => {
          editNode(visualNode.id, (node) => {
            if (node.type !== "creative") return node;
            const text = removePromptRef(node.data.text, sourceId);
            return text === node.data.text
              ? node
              : {
                  ...node,
                  data: {
                    ...node.data,
                    text,
                    ...(!node.data.character &&
                      !isPlainGeneratedMedia(node.data) && { activeOutputId: undefined }),
                  },
                };
          });
          setEdges((current) =>
            current.filter(
              (edge) =>
                edge.data?.readOnly || edge.target !== visualNode.id || edge.source !== sourceId,
            ),
          );
        }}
        blocked={writing || importing}
        generating={
          character
            ? jobs.some(
                (job) =>
                  job.nodeId === visualNode.id &&
                  job.kind === "image" &&
                  !jobIsTerminal(job.status),
              )
            : busyGenerationTargets.has(visualNode.id)
        }
        onPromptChange={(text) => {
          setNodes((current) =>
            current.map((item) =>
              item.id === visualNode.id && item.type === "creative"
                ? {
                    ...item,
                    data: {
                      ...item.data,
                      text,
                      ...(!item.data.character &&
                        !isPlainGeneratedMedia(item.data) && { activeOutputId: undefined }),
                    },
                  }
                : item,
            ),
          );
        }}
        close={closeDialog ?? (() => undefined)}
        submit={(input, key, voice) => submitGeneration(input, key, true, voice)}
      />
    );
  };
  const focusCanvasNode = (id: string) => {
    const flow = flowInstance.current;
    if (!flow?.getNode(id)) return false;
    setNodes((current) =>
      current.map((node) =>
        node.selected || node.id === id ? { ...node, selected: node.id === id } : node,
      ),
    );
    void flow.fitView({ nodes: [{ id }], duration: 320, padding: 0.8, maxZoom: 1 });
    return true;
  };
  const renameCanvas = async (name: string) => {
    setWriting(true);
    setProjectError("");
    try {
      const saved = await saveCanvas(projectSession);
      if (!saved) return;
      const result = await window.desktop.projects.rename({
        projectHandle: saved.projectHandle,
        operationId: crypto.randomUUID(),
        expectedRevision: saved.revision,
        name,
      });
      if (!result.ok) {
        setProjectError(result.error.messageKey);
        return;
      }
      setProjectSession((current) =>
        current?.projectHandle === saved.projectHandle
          ? {
              ...current,
              name: result.value.name,
              revision: Math.max(current.revision, result.value.revision),
            }
          : current,
      );
    } finally {
      setWriting(false);
    }
  };
  async function leaveCanvas(
    create = false,
    openNext?: () => ReturnType<typeof window.desktop.projects.open>,
    recentId?: string,
  ) {
    if (!projectSession || writing || importing || dragging || uploadingNodes) return false;
    setWriting(true);
    setProjectError("");
    try {
      if (!(await saveCanvas(projectSession))) return;
      let next: ProjectSession | undefined;
      if (openNext) {
        const result = await openNext();
        if (!result.ok) return homeError(result.error.code);
        if (result.value.disposition !== "opened") return;
        next = result.value.session;
        if (next.projectHandle === projectSession.projectHandle) return true;
      } else if (create) {
        const location = await window.desktop.dialogs.selectProjectParent();
        if (!location.ok) {
          setProjectError(location.error.messageKey);
          return;
        }
        if (location.value.cancelled) return;
        const result = await window.desktop.projects.create({
          directoryToken: location.value.directoryToken,
          operationId: crypto.randomUUID(),
          name: "未命名画布",
        });
        if (!result.ok) {
          setProjectError(result.error.messageKey);
          return;
        }
        next = result.value;
      }
      const closed = await window.desktop.projects.close({
        projectHandle: projectSession.projectHandle,
        ...(projectSession.projectKind === "drama" && { keepWorking: true }),
      });
      if (!closed.ok) {
        if (next)
          await window.desktop.projects.close({
            projectHandle: next.projectHandle,
            ...(openNext && next.projectKind === "drama" && { keepWorking: true }),
          });
        setProjectError(closed.error.messageKey);
        return;
      }
      if (next) await enterProject(next, recentId);
      else {
        assetScope.current = undefined;
        persistence.load(null);
        setProjectSession(null);
      }
      await refreshRecent();
      return true;
    } finally {
      setWriting(false);
    }
  }
  const pickerServices = {
    assets,
    jobs,
    handle: projectSession.projectHandle,
    projectName: projectSession.name,
    importing,
    attachFiled,
    attachLibrary,
    upload: uploadPickerFile,
    feedback: projectError && <p role="alert">{projectError}</p>,
  };
  const target = assetPlacement && "target" in assetPlacement ? assetPlacement.target : undefined;
  const targetNode = target && nodes.find((item) => item.id === target.nodeId);
  const characterPick: CharacterPick | undefined =
    targetNode?.type === "creative" && targetNode.data.character
      ? {
          purpose: target?.extra ? "extra" : "main",
          primary: targetNode.data.assetId,
          extras: targetNode.data.character.extraAssetIds,
        }
      : undefined;
  const menuActions = {
    label: addMenu?.fan
      ? `引用选中的 ${addMenu.fan.ids.length} 个节点生成`
      : addMenu?.pending
        ? "引用该节点生成"
        : "添加节点",
    disabled: (kind: LinkKind) => {
      const sources = addMenu?.fan && fanSources(addMenu.fan, kind);
      return (
        busy ||
        nodes.length >= 1000 ||
        (!!addMenu?.pending && edges.length >= 4000) ||
        (!!sources && (!sources.length || edges.length + sources.length > 4000)) ||
        !acceptsMenuKind(addMenu?.pending, kind)
      );
    },
    uploadDisabled:
      busy ||
      nodes.length >= 1000 ||
      !!addMenu?.fan ||
      !(["image", "video", "audio"] as const).some((kind) =>
        acceptsMenuKind(addMenu?.pending, kind),
      ),
    choose: chooseMenuNode,
    upload: () => {
      if (addMenu) void importMedia(addMenu);
      setAddMenu(undefined);
    },
    assets: () => {
      if (!addMenu) return;
      setProjectError("");
      setAssetPlacement(addMenu.position);
      setAssetTarget(undefined);
      setSidePanel(null);
      void refreshAssets(projectSession.projectHandle);
      setAddMenu(undefined);
    },
  };
  return (
    <AgentMarks.Provider value={marks}>
      {voicePick && (
        <AssetPickerDialog
          {...pickerServices}
          attachOfficialVoice={attachOfficialVoice}
          voicesFirst
          lockedKind="audio"
          capacity={1}
          close={() => setVoicePick(undefined)}
          confirm={async (batch) => {
            const asset = batch[0];
            if (!asset) return "请选择音色";
            const issue = voicePick.validate(asset);
            if (issue) return issue;
            voicePick.apply(asset);
            setVoicePick(undefined);
          }}
        />
      )}
      {exchangeStage && (
        <CanvasExportProgress
          stage={exchangeStage}
          cancel={exportAttempt.current ? () => exportAttempt.current?.abort() : undefined}
        />
      )}
      {settingsPage((request) => (
        <FilingAssetPicker
          request={{
            ...request,
            done: (message) => {
              request.done(message);
              void refreshAssets(projectSession.projectHandle);
            },
          }}
          services={pickerServices}
        />
      ))}
      {!inlineGeneration && generationForm}
      {assetPlacement && (
        <AssetPickerDialog
          attachOfficialVoice={attachOfficialVoice}
          {...pickerServices}
          lockedKind={target?.kind}
          dialogTitle={target?.replaceAssetId ? "从资产库替换" : undefined}
          confirmLabel={target?.replaceAssetId ? "替换主图" : undefined}
          character={characterPick}
          capacity={target ? 4 : 1000 - nodes.length}
          close={() => setAssetPlacement(undefined)}
          confirm={(picked) => {
            if (
              !persistence.loaded ||
              importing ||
              writing ||
              !picked.length ||
              (!("target" in assetPlacement) && picked.length + nodes.length > 1000)
            )
              return;
            if (target && characterPick) {
              applyCharacterAssets(target.nodeId, characterPick.purpose, picked);
              setAssetPlacement(undefined);
              return;
            }
            const batch = picked.filter((asset) => asset.availability === "ready");
            if (batch.length !== picked.length)
              return setProjectError("所选素材已变更，请取消选择后重试");
            if ("target" in assetPlacement) {
              if (batch[0]) bindAsset(assetPlacement.target, batch[0]);
              setAssetPlacement(undefined);
              return;
            }
            const created = planAssetNodes(
              batch,
              assetPlacement,
              nodes.map((node) => node.data.label),
            ).map((node) => ({ ...node, data: { ...node.data, ...newNodeModel(node.data.kind) } }));
            setNodes((current) => [
              ...current.map((node) => (node.selected ? { ...node, selected: false } : node)),
              ...created,
            ]);
            setAssetPlacement(undefined);
            setAssetBatchNotice({ count: created.length });
          }}
        />
      )}
      {enrollAsset && dramaHandle === projectSession.projectHandle && (
        <HumanEnroll
          projectHandle={projectSession.projectHandle}
          asset={enrollAsset}
          close={() => setEnrollAsset(undefined)}
          done={() => {
            void refreshAssets(projectSession.projectHandle);
          }}
        />
      )}
      {dramaHandle === projectSession.projectHandle && (
        <DramaStudio
          key={dramaHandle}
          activeRecentId={activeRecentId}
          flushBeforeClose={flushDrama}
          projectTabs={dramaTabs.flatMap(
            (id) => recentProjects.find((project) => project.recentEntryId === id) ?? [],
          )}
          navigateProject={async (entry, remove) => {
            if (projectBusy || writing) return;
            const current = entry.recentEntryId === activeRecentId;
            if (current && !remove) return;
            if (!remove) {
              await leaveCanvas(
                false,
                () => window.desktop.projects.openRecent({ recentEntryId: entry.recentEntryId }),
                entry.recentEntryId,
              );
              return;
            }
            if (current && !(await leaveCanvas())) return;
            setDramaTabs((previous) => previous.filter((id) => id !== entry.recentEntryId));
          }}
          projectHandle={dramaHandle}
          projectId={projectSession.projectId}
          withAssistant={withDramaAssistant}
          providers={generationProviders.providers}
          loadingModels={generationProviders.status === "loading"}
          refreshModels={() => setCatalogRevision((value) => value + 1)}
          plugins={generationProviders.plugins}
          toggleTheme={() =>
            changeViewPreferences({
              theme:
                viewPreferences.theme === "dark" ||
                (viewPreferences.theme === "system" &&
                  matchMedia("(prefers-color-scheme: dark)").matches)
                  ? "light"
                  : "dark",
            })
          }
          returnLabel={projectSession.projectKind === "canvas" ? "返回画布" : "返回首页"}
          close={() =>
            projectSession.projectKind === "canvas" ? setDramaHandle("") : void leaveCanvas()
          }
          assetEditor={{
            assets,
            graph: historyCanvas,
            canvasRevision: persistence.canvasRevision,
            enroll: setEnrollAsset,
            ready: persistence.loaded,
            jobs: assetJobs,
            progress: assetProgress,
            activeImport:
              activeImport?.nodeId && ["copying", "committing"].includes(activeImport.status.phase)
                ? {
                    id: activeImport.nodeId,
                    percent: Math.floor(
                      (100 * activeImport.status.copiedBytes) /
                        (activeImport.status.totalBytes || 1),
                    ),
                  }
                : undefined,
            selected: inspected?.id,
            mount: setDramaCanvasSlot,
            focus: focusCanvasNode,
            save: async () => {
              if (writing || dragging || importing) return false;
              if (await saveCanvas(projectSession)) return true;
              const merged = await persistence.recover(projectSession, false);
              if (!merged) return false;
              flushSync(() => {
                restoreCanvas(merged);
                history.syncGenerated(merged, []);
              });
              return !!(await saveCanvas(projectSession));
            },
            character: setCharacterNodeId,
            canCreate: persistence.loaded && !writing && nodes.length < 1000,
            batching: assetBatchBusy || writing || importing,
            generate: generateDramaAssets,
            estimate: (node) => {
              const models = nodeModels(generationProviders, "image"),
                key = node.data.generation?.providerId ?? node.data.generation?.modelKey;
              return assetUnit(
                models.find((model) => model.id === key || model.modelKey === key) ?? models[0],
              );
            },
            voiceUnit: assetUnit(nodeModels(generationProviders, "audio")[0]),
            create: (type, episode) => {
              const kind =
                type === "text" ? "script" : type === "scene" || type === "prop" ? "image" : type;
              const id = addNode(kind, undefined, dramaAssetScope(type, episode));
              if (id) reportLinkNotice("已在短剧画布上新建节点，列表同步出现");
            },
            drop: (type, episode, files, node) => {
              const kind = type === "audio" || type === "video" ? type : "image";
              void importMedia(
                node
                  ? { nodeId: node.id, kind, dramaDrop: true }
                  : {
                      position: defaultPlacement(),
                      dramaDrop: { kind, scope: dramaAssetScope(type, episode) },
                    },
                files,
              );
            },
            clearSelection: () => {
              setGenerationNodeId(undefined);
              setNodes((current) =>
                current.map((node) => (node.selected ? { ...node, selected: false } : node)),
              );
            },
            classify: (id, drama) =>
              editNode(id, (node) =>
                node.type === "creative" ? { ...node, data: { ...node.data, drama } } : node,
              ),
            prompt: (id, close, locate) => {
              const node = nodes.find((item) => item.id === id);
              return node?.type === "creative" && renderMediaForm(node, close, locate);
            },
            fill: (node, source) => {
              if (node.data.kind === "script") return;
              const target = { nodeId: node.id, kind: node.data.kind };
              if (source === "upload") void importMedia(target);
              else {
                setProjectError("");
                setAssetPlacement({ target });
                void refreshAssets(projectSession.projectHandle);
              }
            },
          }}
        />
      )}
      <div
        ref={normalCanvasSlot}
        hidden={showSettings || dramaHandle === projectSession.projectHandle}
      />
      {createPortal(
        <div
          className="canvas-workspace"
          hidden={
            showSettings || (dramaHandle === projectSession.projectHandle && !dramaCanvasSlot)
          }
          data-panel={sidePanel ?? "closed"}
        >
          <main className="canvas-area" ref={canvasArea} aria-label="创作画布">
            {!dramaCanvasSlot && (
              <CanvasViewSettings
                preferences={viewPreferences}
                change={changeViewPreferences}
                failed={viewPreferenceError}
                openGuide={() => setShowGuide(true)}
                modelGroups={preferenceModels}
              />
            )}
            <input
              key={`upload-${projectHandle}`}
              ref={uploadInput}
              type="file"
              accept="image/*,video/*,audio/*"
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []),
                  placement = uploadPlacement.current;
                event.currentTarget.value = "";
                uploadPlacement.current = null;
                if (files.length && placement?.projectHandle === projectSession.projectHandle)
                  void importMedia(placement.target, files);
              }}
            />
            {!showSettings && dramaHandle !== projectSession.projectHandle && (
              <CanvasShortcuts
                key={`shortcuts-${projectHandle}`}
                handle={projectSession.projectHandle}
                projectId={projectSession.projectId}
                reportError={setProjectError}
                receiveAssets={(received, revision) => {
                  updateRevision(projectSession.projectHandle, revision);
                  const ids = new Set(received.map((asset) => asset.assetId));
                  setAssets((current) => [
                    ...current.filter((asset) => !ids.has(asset.assetId)),
                    ...received,
                  ]);
                }}
                surface={canvasArea}
                selectTool={setHand}
                changeView={changeView}
                openGuide={() => setShowGuide(true)}
                toggleAssistant={() => togglePanel("assistant")}
                capture={() => (selectionBusy ? undefined : fragment)}
                paste={(source, point, offset) => {
                  if (selectionBusy) return;
                  const position = point
                    ? flowInstance.current?.screenToFlowPosition(point)
                    : undefined;
                  if (Array.isArray(source)) {
                    const origin = pastePosition(point);
                    void importMedia({ position: origin, clipboard: true }, source);
                  } else if (typeof source !== "string") insertClones(source, position, offset);
                  else if (nodes.length < 1000) {
                    const chars = [...source];
                    if (chars.length > 20000) setProjectError("文字太长，只放进了前 20000 个字");
                    const labels = new Set(nodes.map((node) => node.data.label));
                    let label = "文本";
                    for (let index = 2; labels.has(label); index++) label = `文本 ${index}`;
                    setAddMenu(undefined);
                    setGenerationNodeId(undefined);
                    setNodes((current) => [
                      ...current.map((node) =>
                        node.selected ? { ...node, selected: false } : node,
                      ),
                      {
                        id: crypto.randomUUID(),
                        type: "creative",
                        position: pastePosition(point),
                        selected: true,
                        data: {
                          kind: "script",
                          label,
                          text: chars.slice(0, 20000).join(""),
                        },
                      },
                    ]);
                  }
                }}
                duplicate={duplicateNodes}
                group={groupNodes}
                renameGroup={() => {
                  if (!selectedGroup || selectionBusy) return false;
                  setRenamingId(selectedGroup.id);
                  return true;
                }}
                deselectNodes={() =>
                  setNodes((current) =>
                    current.map((node) => (node.selected ? { ...node, selected: false } : node)),
                  )
                }
                ungroup={ungroup}
                history={(direction) => {
                  if (!selectionBusy) history.restore(direction);
                }}
                save={() => {
                  if (!selectionBusy) void saveCanvas(projectSession);
                }}
              />
            )}
            <CanvasProjectBar
              key={projectSession.projectHandle}
              title={projectSession.name}
              rename={(name) => void renameCanvas(name)}
              state={
                !persistence.loaded
                  ? "loading"
                  : saveError === "CANVAS_REVISION_CONFLICT"
                    ? "conflict"
                    : saveError
                      ? "error"
                      : saving || dirty
                        ? "saving"
                        : "saved"
              }
              retry={() => void saveCanvas(projectSession)}
              locked={writing || importing || dragging || uploadingNodes || !persistence.loaded}
              leave={() => void leaveCanvas()}
              create={() => void leaveCanvas(true)}
              exportGraph={() => void exportCanvasExchange()}
              extras={[
                { label: "保存项目", disabled: busy, run: () => void saveCanvas(projectSession) },
                { label: "导入画布", disabled: busy, run: importCanvasExchange },
                { label: "项目文件", run: () => togglePanel("assets") },
                { label: "生成任务", run: () => togglePanel("jobs") },
                { label: "导出成片", disabled: busy, run: () => void openComposition() },
                {
                  label: "扫线断开",
                  disabled: busy,
                  run: () => {
                    setSweepMode((current) => !current);
                    setHand(false);
                  },
                },
                ...(inspected && inspected.type !== "group"
                  ? [{ label: "所选节点属性", run: () => togglePanel("properties") }]
                  : []),
                ...(["短剧工作室", "短剧助手"] as const).map((label) => ({
                  label,
                  run: () => {
                    setWithDramaAssistant(label === "短剧助手");
                    if (!projectSession.projectKind)
                      localStorage.setItem(`workspace:${projectSession.projectId}`, "drama");
                    setDramaHandle(projectSession.projectHandle);
                  },
                })),
                { label: "模型设置", run: () => setShowSettings(true) },
                { label: "运行环境", run: () => togglePanel("runtime") },
              ]}
            />
            <CanvasEditToolbar
              orientation={dramaCanvasSlot ? "horizontal" : "vertical"}
              addMenu={{
                ...menuActions,
                open: !!addMenu?.toolbar,
                onOpenChange: (open) => {
                  if (open)
                    setAddMenu({
                      toolbar: true,
                      anchor: { x: 0, y: 0 },
                      position: defaultPlacement(),
                    });
                  else setAddMenu((current) => (current?.toolbar ? undefined : current));
                },
              }}
              locked={!persistence.loaded || writing}
              hand={handTool}
              chooseHand={setHand}
              canUndo={!writing && history.canUndo}
              canRedo={!writing && history.canRedo}
              undo={() => history.restore("undo")}
              redo={() => history.restore("redo")}
              assetsDisabled={!persistence.loaded || busy}
              openAssets={() => {
                setAddMenu(undefined);
                setAssetTarget(undefined);
                setProjectError("");
                setSidePanel(null);
                setAssetPlacement(defaultPlacement());
                void refreshAssets(projectSession.projectHandle);
              }}
              tasksOpen={tasksOpen}
              openTasks={() => setTasksOpen(true)}
            />
            <CanvasTaskHistory
              open={tasksOpen}
              setOpen={setTasksOpen}
              nodes={nodes}
              jobs={jobs}
              inventoryReady={jobsLoadedFor === activeHandle}
              projectHandle={projectSession.projectHandle}
              pick={focusCanvasNode}
            />
            <CanvasStatsBar
              key={`stats-${projectSession.projectHandle}`}
              {...stats}
              edgeCount={edges.length}
              focus={focusCanvasNode}
            />
            <section
              className="asset-strip canvas-surface canvas-library"
              aria-label="项目文件"
              hidden={!!assetPlacement || (sidePanel !== "assets" && !importing)}
            >
              <div className="asset-strip-heading">
                <strong>项目文件</strong>
                {!assetTarget && (
                  <button type="button" onClick={() => setNewLibraryFolder(true)}>
                    新建资产库文件夹
                  </button>
                )}
                {!assetTarget && (
                  <button type="button" onClick={() => setManageLibrary(true)}>
                    管理个人资产库
                  </button>
                )}
                <span>
                  {assetTarget ? `选择${NODE_LABELS[assetTarget.kind]}素材` : `${assets.length} 项`}
                </span>
                <label className="asset-mode">
                  <span>导入方式</span>
                  <select
                    value={importMode}
                    disabled={busy}
                    onChange={(event) =>
                      setImportMode(event.target.value === "reference" ? "reference" : "copy")
                    }
                  >
                    <option value="copy">复制到项目</option>
                    <option value="reference">引用外部文件</option>
                  </select>
                </label>
                <button type="button" disabled={busy} onClick={() => void importMedia(assetTarget)}>
                  {importing ? "正在导入…" : "导入素材"}
                </button>
                <button
                  type="button"
                  disabled={importing}
                  aria-label="关闭项目文件"
                  onClick={() => {
                    setAssetTarget(undefined);
                    setSidePanel(null);
                  }}
                >
                  <X size={16} />
                </button>
              </div>
              {enrollNotice && <p role="status">{enrollNotice}</p>}
              {newLibraryFolder && (
                <LibraryFolderForm
                  handle={projectSession.projectHandle}
                  close={() => setNewLibraryFolder(false)}
                />
              )}
              {manageLibrary && (
                <LibraryManagement
                  handle={projectSession.projectHandle}
                  close={() => setManageLibrary(false)}
                />
              )}
              {enrollAsset && dramaHandle !== projectSession.projectHandle && (
                <HumanEnroll
                  projectHandle={projectSession.projectHandle}
                  asset={enrollAsset}
                  close={() => setEnrollAsset(undefined)}
                  done={(message) => {
                    setEnrollNotice(message);
                    void refreshAssets(projectSession.projectHandle);
                  }}
                />
              )}
              {!assets.some((asset) => !assetTarget || asset.mediaType === assetTarget.kind) &&
                !importing && <p className="muted">导入图片、视频或音频，即可在画布中使用。</p>}
              {activeImport && ["copying", "committing"].includes(activeImport.status.phase) && (
                <div className="asset-strip-heading asset-progress">
                  <span>
                    {activeImport.name} ·{" "}
                    {activeImport.status.phase === "committing"
                      ? "正在提交"
                      : importMode === "reference"
                        ? "正在校验"
                        : "正在复制"}
                  </span>
                  <progress
                    aria-label="素材导入进度"
                    max={activeImport.status.totalBytes || 1}
                    value={
                      activeImport.status.totalBytes ? activeImport.status.copiedBytes : undefined
                    }
                  />
                  <button
                    type="button"
                    disabled={cancelling}
                    onClick={async () => {
                      setCancelling(true);
                      try {
                        await window.desktop.projects.cancelImport({
                          projectHandle: projectSession.projectHandle,
                          importSessionId: activeImport.id,
                        });
                      } finally {
                        setCancelling(false);
                      }
                    }}
                  >
                    {cancelling ? "正在取消…" : "取消此文件"}
                  </button>
                </div>
              )}
              {duplicate && (
                <fieldset className="asset-strip-heading asset-duplicate" aria-label="处理重复素材">
                  <span role="status">{duplicate.displayName} 已存在</span>
                  <button type="button" onClick={() => duplicate.resolve("reuse")}>
                    复用现有素材
                  </button>
                  <button type="button" onClick={() => duplicate.resolve("independent")}>
                    保留独立记录
                  </button>
                  <button type="button" onClick={() => duplicate.resolve("cancel")}>
                    跳过此文件
                  </button>
                </fieldset>
              )}
              {projectError && (
                <p className="error" role="alert">
                  {projectError}
                </p>
              )}
              {assets.length > 0 && (
                <div className="asset-list">
                  {assets
                    .filter((asset) => !assetTarget || asset.mediaType === assetTarget.kind)
                    .map((asset) => (
                      <article key={asset.assetId} className="asset-item">
                        <strong title={asset.displayName}>{asset.displayName}</strong>
                        <span>
                          {asset.mediaType} ·{" "}
                          {asset.metadata.width && asset.metadata.height
                            ? `${asset.metadata.width}×${asset.metadata.height}`
                            : asset.metadata.durationMs
                              ? `${(Number(asset.metadata.durationMs) / 1000).toFixed(1)} 秒`
                              : "本地副本"}
                        </span>
                        <small>
                          {asset.importMode === "reference" ? "外部引用" : "项目副本"} ·{" "}
                          {(asset.sizeBytes / 1024 / 1024).toFixed(1)} MB
                          {asset.availability === "missing" && " · 文件不可用"}
                        </small>
                        <div className="asset-actions">
                          {asset.availability === "ready" && (
                            <>
                              <button
                                type="button"
                                aria-label={`预览${asset.displayName}`}
                                disabled={busy}
                                onClick={() => void openPreview(asset)}
                              >
                                预览
                              </button>
                              {asset.mediaType === "video" && (
                                <button
                                  type="button"
                                  aria-label={`提取${asset.displayName}关键帧`}
                                  disabled={busy}
                                  onClick={() => void openFrame(asset)}
                                >
                                  提取帧
                                </button>
                              )}
                              {asset.mediaType === "image" &&
                                !assetTarget &&
                                asset.metadata.filingEnabled === true &&
                                (typeof asset.metadata.filingHumanName === "string" ? (
                                  <span className="asset-human-badge">
                                    <UserRound size={12} />
                                    真人 · {asset.metadata.filingHumanName}
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => {
                                      setEnrollAsset(asset);
                                      setEnrollNotice("");
                                    }}
                                  >
                                    加入真人库
                                  </button>
                                ))}
                              <button
                                type="button"
                                aria-label={
                                  assetTarget
                                    ? `将${asset.displayName}用于节点`
                                    : `将${asset.displayName}加入画布`
                                }
                                disabled={
                                  busy ||
                                  !persistence.loaded ||
                                  (!assetTarget && nodes.length >= 1000)
                                }
                                onClick={() => {
                                  if (assetTarget) return bindAsset(assetTarget, asset);
                                  addAssetNode(asset);
                                }}
                              >
                                {assetTarget ? "用于节点" : "加入画布"}
                              </button>
                            </>
                          )}
                          {asset.importMode === "reference" && (
                            <button
                              type="button"
                              aria-label={`重新定位${asset.displayName}`}
                              disabled={busy}
                              onClick={() => void relocate(asset)}
                            >
                              重新定位
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={`移除${asset.displayName}`}
                            onClick={async () => {
                              setWriting(true);
                              setProjectError("");
                              try {
                                const session = await saveCanvas(projectSession);
                                if (!session) return;
                                const result = await window.desktop.projects.removeAsset({
                                  projectHandle: session.projectHandle,
                                  operationId: crypto.randomUUID(),
                                  expectedRevision: session.revision,
                                  assetId: asset.assetId,
                                });
                                if (result.ok) {
                                  updateRevision(session.projectHandle, result.value.revision);
                                  await refreshAssets(session.projectHandle);
                                } else
                                  setProjectError(assetErrors[result.error.code] ?? "无法移除素材");
                              } finally {
                                setWriting(false);
                              }
                            }}
                          >
                            移除
                          </button>
                        </div>
                      </article>
                    ))}
                </div>
              )}
            </section>
            <section
              aria-label="节点画布"
              className="flow-container"
              data-hand={hand}
              onDragOver={(event) => {
                if (
                  !event.dataTransfer.types.includes("Files") ||
                  !event.currentTarget.contains(event.target as HTMLElement)
                )
                  return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setFileOver(true);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as HTMLElement | null))
                  setFileOver(false);
              }}
              onDrop={(event) => {
                setFileOver(false);
                const element = event.target;
                if (
                  !(element instanceof Element) ||
                  !event.currentTarget.contains(element) ||
                  !event.dataTransfer.types.includes("Files")
                )
                  return;
                event.preventDefault();
                const files = Array.from(event.dataTransfer.files);
                if (!files.length || busy) return;
                const node = flowInstance.current?.getNode(
                  element.closest(".react-flow__node")?.getAttribute("data-id") ?? "",
                );
                if (
                  files.length === 1 &&
                  node?.type === "creative" &&
                  node.data.kind !== "script" &&
                  node.data.uploadProgress === undefined &&
                  !node.data.assetId &&
                  !node.data.outputs?.length &&
                  !jobs.some((job) => job.nodeId === node.id && !jobIsTerminal(job.status))
                ) {
                  const file = files[0];
                  if (file && !file.type.startsWith(`${node.data.kind}/`)) {
                    setProjectError(`这个节点只收${NODE_LABELS[node.data.kind]}`);
                    return;
                  }
                  void importMedia({ nodeId: node.id, kind: node.data.kind }, files);
                  return;
                }
                const position = pastePosition({ x: event.clientX, y: event.clientY });
                void importMedia({ position: { x: position.x - 288, y: position.y - 162 } }, files);
              }}
            >
              {fileOver && <div aria-hidden="true" className="canvas-file-over" />}
              <CanvasUploadContext.Provider
                value={(id) => doodleUploads.retry(id) ?? canvasUploads.retry(id)}
              >
                <NodeMedia.Provider value={nodeMedia}>
                  <VisualMediaActions.Provider
                    value={{
                      busy,
                      running: (id) =>
                        jobs.some((job) => job.nodeId === id && !jobIsTerminal(job.status)),
                      upload: (target) => void importMedia(target),
                      editCharacter: setCharacterNodeId,
                      enterDirector,
                      imageJob: (id) =>
                        jobs.find((job) => job.nodeId === id && job.kind === "image"),
                      mediaJob: (id, data) => mediaNodeJob(jobs, id, data),
                      versions: (id, data) => versionBadge(data, versionJobs(jobs, id, data.kind)),
                      openVersions: setVersionNodeId,
                      retryHint: (id, data) =>
                        mountedDraft?.id === id
                          ? mountedDraft.reason
                          : mediaGenerationDraft({
                              id,
                              data,
                              assets,
                              settings: generationProviders,
                              graph: canvas,
                              runningNodes: busyGenerationTargets,
                              referenceRunningNodes: runningReferenceNodes,
                              pendingVoices: pendingVoiceNodes,
                              draft: data.text,
                              template: promptPresets(data.text).some(
                                (item) => item.kind === "tpl",
                              ),
                            }).blockedReason,
                      actOnTask: async (job, character) => {
                        try {
                          if (job.status === "failed") {
                            if (!character) {
                              flushSync(() => retryGeneration(job.nodeId));
                              if (mediaForm.current?.dataset.generationNode === job.nodeId)
                                mediaForm.current.requestSubmit();
                              else setProjectError("请先打开此节点的生成面板。");
                              return;
                            }
                            const saved = await saveCanvas(projectSession);
                            if (!saved) return;
                            const canvas = await window.desktop.projects.getCanvas({
                              projectHandle: saved.projectHandle,
                            });
                            if (!canvas.ok) return setProjectError(canvas.error.messageKey);
                            const result = await window.desktop.projects.retryCharacterImage({
                              projectHandle: saved.projectHandle,
                              jobId: job.id,
                              operationId: crypto.randomUUID(),
                              expectedCanvasRevision: canvas.value.canvasRevision,
                              confirmed: true,
                            });
                            if (!result.ok)
                              return setProjectError(
                                result.error.message ?? result.error.messageKey,
                              );
                            setJobs((current) => [
                              result.value,
                              ...current.filter((item) => item.id !== result.value.id),
                            ]);
                          } else {
                            const result = await window.desktop.projects.cancelJob({
                              projectHandle: projectSession.projectHandle,
                              jobId: job.id,
                            });
                            if (!result.ok)
                              return setProjectError(
                                result.error.message ?? result.error.messageKey,
                              );
                            setJobs((current) =>
                              current.map((item) => (item.id === job.id ? result.value : item)),
                            );
                          }
                        } catch {
                          setProjectError("任务操作失败，请重试。");
                        }
                      },
                      voicePending: (id) => {
                        const latest = jobs.find(
                          (job) => job.nodeId === id && job.purpose === "character-voice",
                        );
                        return !!latest && !jobIsTerminal(latest.status);
                      },
                      library: (target) => {
                        const node = flowInstance.current?.getNode(target.nodeId);
                        if (node?.type !== "creative") return;
                        setProjectError("");
                        setAssetPlacement({ target });
                        setAssetTarget(undefined);
                        setSidePanel(null);
                        void refreshAssets(projectSession.projectHandle);
                      },
                      reportError: setProjectError,
                    }}
                  >
                    <RenameTitle.Provider value={{ id: renamingId, start: setRenamingId }}>
                      <SplitCard.Provider
                        value={(id) => {
                          const script = upstreamScriptText(id);
                          const currentJob = jobs
                            .filter(
                              (job) => job.nodeId === id && job.purpose === "storyboard-split",
                            )
                            .sort((left, right) =>
                              right.createdAt.localeCompare(left.createdAt),
                            )[0];
                          const running = !!currentJob && !jobIsTerminal(currentJob.status);
                          const models = splitModels(generationProviders);
                          const picked = readShotModel();
                          const model = picked
                            ? models.find((item) => item.id === picked.id)
                            : models[0];
                          const reason = !script.connected
                            ? "请先连接剧本节点"
                            : !script.text
                              ? "剧本节点还没有内容"
                              : running
                                ? "正在拆分镜"
                                : !model
                                  ? "请选择可用的 Agent 模型"
                                  : "";
                          return {
                            reason,
                            running,
                            failure:
                              currentJob?.status === "failed"
                                ? jobFailureReason(currentJob)
                                : undefined,
                            start: async () => {
                              const source = nodes.find((node) => node.id === id);
                              if (
                                reason ||
                                !model ||
                                source?.type !== "creative" ||
                                source.data.storyboard?.length
                              )
                                return reason;
                              return submitStoryboardSplit(
                                source,
                                splitPrompt(script.text),
                                model,
                                "replace",
                              );
                            },
                          };
                        }}
                      >
                        <OpenStoryboard.Provider
                          value={(id, focusId) => {
                            firstShotFocus.current = focusId;
                            setStoryboardNodeId(id);
                          }}
                        >
                          <OpenTextEditor.Provider value={setTextNodeId}>
                            <RunningEdgeTargets.Provider value={runningEdgeTargets}>
                              <ReactFlow<FlowNode, CanvasFlowEdge>
                                key={`${projectSession.projectHandle}:${canvasMount}`}
                                nodes={
                                  pendingGrid
                                    ? [...displayedNodes, ...pendingGrid.nodes]
                                    : pendingFrame
                                      ? [...displayedNodes, pendingFrame.node]
                                      : displayedNodes
                                }
                                edges={
                                  pendingGrid
                                    ? [...edges, ...pendingGrid.edges]
                                    : pendingFrame
                                      ? [...edges, pendingFrame.edge]
                                      : edges
                                }
                                nodeTypes={nodeTypes}
                                edgeTypes={edgeTypes}
                                onInit={(instance) => {
                                  flowInstance.current = instance;
                                }}
                                onNodesChange={onNodesChange}
                                onNodeDragStart={onNodeDragStart}
                                onNodeDrag={onNodeDrag}
                                onNodeDragStop={onNodeDragStop}
                                onEdgesChange={onCanvasEdgesChange}
                                onConnect={onConnect}
                                onConnectEnd={(event, state) => {
                                  if (
                                    hand ||
                                    writing ||
                                    state.toNode ||
                                    !state.fromHandle ||
                                    !state.from
                                  )
                                    return;
                                  const { nodeId, type } = state.fromHandle;
                                  const node = nodes.find((item) => item.id === nodeId);
                                  if (node?.type !== "creative") return;
                                  const point =
                                    "changedTouches" in event ? event.changedTouches[0] : event;
                                  if (!point) return;
                                  const flow = flowInstance.current;
                                  if (!flow) return;
                                  const drop = flow.screenToFlowPosition({
                                    x: point.clientX,
                                    y: point.clientY,
                                  });
                                  const connectionTo = (other: string) => ({
                                    source: type === "source" ? nodeId : other,
                                    target: type === "source" ? other : nodeId,
                                    sourceHandle: null,
                                    targetHandle: null,
                                  });
                                  const other = linkBodyAt(
                                    nodes,
                                    nodeId,
                                    drop,
                                    (id) => {
                                      const internal = flow.getInternalNode(id);
                                      return (
                                        internal && {
                                          ...internal.internals.positionAbsolute,
                                          ...internal.measured,
                                        }
                                      );
                                    },
                                    (id) => validManualLink(connectionTo(id)),
                                  );
                                  if (other) return onConnect(connectionTo(other));
                                  openAddMenu(
                                    { x: point.clientX, y: point.clientY },
                                    {
                                      id: nodeId,
                                      type,
                                      kind: linkKind(node.data),
                                      from: flow.flowToScreenPosition(state.from),
                                      to: { x: point.clientX, y: point.clientY },
                                    },
                                  );
                                }}
                                onPaneClick={() => {
                                  if (writing) return;
                                  setAddMenu(undefined);
                                  setGenerationNodeId(undefined);
                                }}
                                onMouseDown={(event) => {
                                  if (
                                    !hand &&
                                    event.detail >= 2 &&
                                    isBlankPane(event.target, event.currentTarget)
                                  )
                                    event.preventDefault();
                                }}
                                onDoubleClick={(event) => {
                                  if (!hand && isBlankPane(event.target, event.currentTarget))
                                    openAddMenu({ x: event.clientX, y: event.clientY });
                                }}
                                onNodeClick={(event, node) => {
                                  if (
                                    writing ||
                                    hand ||
                                    (navigator.userAgent.includes("Mac")
                                      ? event.metaKey
                                      : event.ctrlKey)
                                  )
                                    return;
                                  setGroupMenuId(
                                    node.type === "group" && node.selected ? node.id : undefined,
                                  );
                                  if (node.type === "creative" && node.data.character) {
                                    setGenerationNodeId(
                                      characterShowsGenerator(node.data) ? node.id : undefined,
                                    );
                                    return;
                                  }
                                  if (
                                    node.type === "creative" &&
                                    !node.data.uploaded &&
                                    isGenerationMedia(node.data.kind)
                                  )
                                    revealGeneration(node.id, true);
                                  else if (generationNodeId !== node.id)
                                    setGenerationNodeId(undefined);
                                }}
                                onNodeDoubleClick={(event, node) => {
                                  if (hand || writing || node.type !== "creative") return;
                                  if (
                                    (event.target as Element).closest(
                                      "button,input,textarea,a,.nodrag",
                                    )
                                  )
                                    return;
                                  if (node.data.director) enterDirector(node.id);
                                  else if (node.data.character) setCharacterNodeId(node.id);
                                  else if (node.data.storyboard) {
                                    firstShotFocus.current = undefined;
                                    setStoryboardNodeId(node.id);
                                  } else startCanvasPreview(node);
                                }}
                                onMoveStart={() => {
                                  setAddMenu(undefined);
                                  setPaneMoving(true);
                                }}
                                onBeforeDelete={async ({ nodes: doomed }) => {
                                  if (writing || !persistence.loaded || deleteGroupRequest)
                                    return false;
                                  const groups = doomed.filter((node) => node.type === "group");
                                  if (groups.length) {
                                    const groupIds = new Set(groups.map((node) => node.id));
                                    const ids = new Set(doomed.map((node) => node.id));
                                    if (
                                      nodes.some(
                                        (node) =>
                                          node.parentId &&
                                          groupIds.has(node.parentId) &&
                                          !ids.has(node.id),
                                      ) ||
                                      edges.some(
                                        (edge) =>
                                          edge.data?.readOnly &&
                                          (ids.has(edge.source) || ids.has(edge.target)),
                                      )
                                    )
                                      return false;
                                    const confirmed = await new Promise<boolean>((resolve) =>
                                      setDeleteGroupRequest({
                                        name:
                                          groups.length === 1
                                            ? (groups[0]?.data.label ?? "组")
                                            : `${groups.length} 个组`,
                                        members: doomed.length - groups.length,
                                        resolve,
                                      }),
                                    );
                                    if (!confirmed) return false;
                                  }
                                  return true;
                                }}
                                isValidConnection={validManualLink}
                                nodesDraggable={
                                  !hand && !writing && !arrangement && persistence.loaded
                                }
                                nodesConnectable={!hand && !writing && persistence.loaded}
                                elementsSelectable={!hand && !writing}
                                selectionOnDrag={!hand && !writing}
                                selectionMode={SelectionMode.Partial}
                                panOnDrag={hand ? true : [1]}
                                panActivationKeyCode={null}
                                panOnScroll={viewPreferences.wheelMode === "pan"}
                                zoomOnScroll={viewPreferences.wheelMode === "zoom"}
                                zoomActivationKeyCode={
                                  viewPreferences.wheelMode === "zoom" ? null : ["Control", "Meta"]
                                }
                                zoomOnDoubleClick={false}
                                paneClickDistance={3}
                                defaultViewport={viewport}
                                onMoveEnd={(_event, next) => {
                                  setViewport(next);
                                  setPaneMoving(false);
                                }}
                                minZoom={0.14}
                                maxZoom={2}
                                colorMode="light"
                                proOptions={{ hideAttribution: true }}
                              >
                                {sweepPoints.length > 1 && (
                                  <svg className="canvas-sweep-overlay" aria-hidden="true">
                                    <polyline
                                      points={sweepPoints.map(({ x, y }) => `${x},${y}`).join(" ")}
                                    />
                                  </svg>
                                )}
                                <CanvasBackgroundLayer background={viewPreferences.background} />
                                <CanvasViewControls
                                  background={viewPreferences.background}
                                  setBackground={(background) =>
                                    changeViewPreferences({ background })
                                  }
                                  changeView={changeView}
                                  minimap={showMap}
                                  toggleMap={() => setShowMap((current) => !current)}
                                  openShortcuts={() => setShowGuide(true)}
                                />
                                <ViewportPortal>
                                  {selectedGroup &&
                                    draggedGroupId !== selectedGroup.id &&
                                    groupSources.length > 0 && (
                                      <SelectionFan
                                        ids={groupSources}
                                        open={openFan}
                                        anchor={{
                                          x:
                                            selectedGroup.position.x + (selectedGroup.width ?? 200),
                                          y:
                                            selectedGroup.position.y +
                                            (selectedGroup.height ?? 140) / 2,
                                        }}
                                      />
                                    )}
                                  {alignmentGuidesState.map((guide) => (
                                    <span
                                      key={`${guide.axis}-${guide.value}-${guide.from}-${guide.to}`}
                                      className={`canvas-align-guide canvas-align-guide-${guide.axis}`}
                                      style={
                                        guide.axis === "x"
                                          ? {
                                              left: guide.value,
                                              top: guide.from,
                                              height: guide.to - guide.from,
                                            }
                                          : {
                                              left: guide.from,
                                              top: guide.value,
                                              width: guide.to - guide.from,
                                            }
                                      }
                                    />
                                  ))}
                                </ViewportPortal>
                                {showMap && <CanvasMiniMap />}
                                {outpaintTarget && (
                                  <ImageOutpaintDialog
                                    key={`${outpaintTarget.nodeId}:${outpaintTarget.asset.assetId}`}
                                    nodeId={outpaintTarget.nodeId}
                                    assetName={outpaintTarget.asset.displayName}
                                    url={outpaintTarget.url}
                                    settings={generationProviders}
                                    busy={outpaintBusy}
                                    error={outpaintError}
                                    submit={(draft) => void submitOutpaint(draft)}
                                    close={() => setOutpaintTarget(undefined)}
                                  />
                                )}
                                {doodling && doodleTarget && (
                                  <ImageDoodleOverlay
                                    key={doodleTarget.nodeId}
                                    nodeId={doodleTarget.nodeId}
                                    url={doodleTarget.url}
                                    error={doodleError}
                                    onSave={saveDoodle}
                                    onClose={() => setDoodleTarget(undefined)}
                                  />
                                )}
                                {framing && frameTarget?.nodeId && (
                                  <VideoFrameOverlay
                                    key={frameTarget.nodeId}
                                    nodeId={frameTarget.nodeId}
                                    url={frameTarget.url}
                                    busy={busy}
                                    error={frameError}
                                    close={() => setFrameTarget(undefined)}
                                    extract={(times) => void extractVideoFrame(times)}
                                  />
                                )}
                                {splitting && splitTarget && (
                                  <GridSplitOverlay
                                    key={`${splitTarget.nodeId}-${splitTarget.rows}-${splitTarget.columns}`}
                                    nodeId={splitTarget.nodeId}
                                    rows={splitTarget.rows}
                                    columns={splitTarget.columns}
                                    busy={busy}
                                    error={splitError}
                                    unavailable={
                                      splitCapacity < splitTarget.rows * splitTarget.columns
                                        ? "画布剩余容量不足"
                                        : imageDisplaySize(splitTarget.asset.metadata).width <
                                              splitTarget.columns ||
                                            imageDisplaySize(splitTarget.asset.metadata).height <
                                              splitTarget.rows
                                          ? "图片像素不足以切分此宫格"
                                          : ""
                                    }
                                    close={() => setSplitTarget(undefined)}
                                    cancel={
                                      mediaOperationId ? () => void cancelMediaTool() : undefined
                                    }
                                    cancelling={mediaCancelling}
                                    submit={(draft) => void splitImage(draft)}
                                  />
                                )}
                                {selectedGroup &&
                                  canUngroup &&
                                  !writing &&
                                  !importing &&
                                  persistence.loaded &&
                                  draggedGroupId !== selectedGroup.id &&
                                  groupMenuId === selectedGroup.id && (
                                    <GroupToolbar
                                      id={selectedGroup.id}
                                      colors={selectedGroup.data}
                                      memberCount={
                                        nodes.filter((node) => node.parentId === selectedGroup.id)
                                          .length
                                      }
                                      arrange={arrangeGroup}
                                      ungroup={ungroup}
                                      remove={() =>
                                        void flowInstance.current?.deleteElements({
                                          nodes: [{ id: selectedGroup.id }],
                                        })
                                      }
                                      setColor={(field, hue) =>
                                        editNode(selectedGroup.id, (node) => {
                                          if (node.type !== "group") return node;
                                          const data = { ...node.data };
                                          if (hue) data[field] = hue;
                                          else delete data[field];
                                          return { ...node, data };
                                        })
                                      }
                                    />
                                  )}
                                {inspected?.type === "creative" &&
                                  inspected.data.uploadProgress === undefined &&
                                  !inspected.data.uploadFailed &&
                                  stripKind &&
                                  !dragging &&
                                  !doodling &&
                                  !framing &&
                                  !splitting &&
                                  outpaintTarget?.nodeId !== inspected.id &&
                                  trimTarget?.nodeId !== inspected.id && (
                                    <NodeActionAnchor
                                      key={inspected.id}
                                      id={inspected.id}
                                      moving={paneMoving}
                                    >
                                      <NodeActionStrip
                                        kind={stripKind}
                                        label={inspected.data.label}
                                        room={splitCapacity}
                                        running={busyGenerationTargets.has(inspected.id)}
                                        history={!!inspected.data.outputs?.length}
                                        ready={
                                          stripKind === "script"
                                            ? !!inspected.data.text.trim()
                                            : inspectedAsset?.mediaType === stripKind
                                        }
                                        action={async (action) => {
                                          const notice = (message: string) =>
                                            setStripNotice({
                                              handle: projectSession.projectHandle,
                                              message,
                                            });
                                          switch (action) {
                                            case "copy":
                                              try {
                                                await copySettingsText(inspected.data.text);
                                                notice("已复制文本");
                                              } catch {
                                                notice("复制失败，请手动选中复制");
                                              }
                                              return;
                                            case "zoom":
                                              return stripKind === "script"
                                                ? setTextNodeId(inspected.id)
                                                : startCanvasPreview(inspected);
                                            case "storyboard":
                                              firstShotFocus.current = undefined;
                                              return setStoryboardNodeId(inspected.id);
                                            case "download":
                                              return downloadSelection();
                                            case "replace":
                                              if (inspectedAsset)
                                                setAssetPlacement({
                                                  target: {
                                                    nodeId: inspected.id,
                                                    kind: "image",
                                                    replaceAssetId: inspectedAsset.assetId,
                                                  },
                                                });
                                              return;
                                            case "library":
                                              if (inspectedAsset)
                                                setLibraryNode({
                                                  nodeId: inspected.id,
                                                  assetId: inspectedAsset.assetId,
                                                  handle: projectSession.projectHandle,
                                                });
                                              return;
                                            case "edit":
                                              if (inspectedAsset)
                                                await openDoodle(inspected.id, inspectedAsset);
                                              return;
                                            case "outpaint":
                                              if (inspectedAsset)
                                                await openOutpaint(inspected.id, inspectedAsset);
                                              return;
                                            case "trim":
                                              if (stripKind === "audio")
                                                return notice("「音频修剪」敬请期待");
                                              if (inspectedAsset)
                                                await openTrim(inspectedAsset, inspected.id);
                                              return;
                                            case "split":
                                              return notice("「人声分离」敬请期待");
                                          }
                                        }}
                                        grid={(rows, columns) => {
                                          if (inspectedAsset)
                                            openSplit(inspected.id, inspectedAsset, rows, columns);
                                        }}
                                        frame={(choice) => {
                                          if (!inspectedAsset) return;
                                          if (choice === "自定义")
                                            return void openFrame(inspectedAsset, inspected.id);
                                          const duration = Number(
                                            inspectedAsset.metadata.durationMs,
                                          );
                                          if (choice === "尾帧" && !(duration > 0))
                                            return setProjectError("读不出视频时长");
                                          void extractVideoFrame(
                                            [choice === "首帧" ? 0 : duration - 1],
                                            { asset: inspectedAsset, nodeId: inspected.id, choice },
                                          );
                                        }}
                                      />
                                    </NodeActionAnchor>
                                  )}
                                {stripKind &&
                                  inlineGeneration &&
                                  generationForm &&
                                  inspected &&
                                  !dragging && (
                                    <NodeToolbar
                                      nodeId={inspected.id}
                                      position={Position.Bottom}
                                      offset={16}
                                      isVisible
                                    >
                                      {generationForm}
                                    </NodeToolbar>
                                  )}
                                {inspected &&
                                  !stripKind &&
                                  inspectedKind !== "director" &&
                                  inspected.type !== "group" &&
                                  !doodling &&
                                  !framing &&
                                  !splitting && (
                                    <NodeToolbar
                                      nodeId={inspected.id}
                                      position={visualNode ? Position.Top : Position.Bottom}
                                      offset={visualNode ? 5 : 9}
                                      isVisible={!dragging && (!hand || inlineGeneration)}
                                      className={`node-tools-anchor${visualNode ? " media-node-tools" : ""}`}
                                      align={visualNode ? "end" : "center"}
                                    >
                                      <div
                                        className="canvas-surface node-tools"
                                        role="toolbar"
                                        aria-label="所选节点操作"
                                      >
                                        {inspected.type === "creative" &&
                                          inspected.data.character && (
                                            <button
                                              type="button"
                                              disabled={busy}
                                              onClick={() => setCharacterNodeId(inspected.id)}
                                            >
                                              <UserRound size={15} /> 编辑角色
                                            </button>
                                          )}
                                        {inspected.type === "creative" &&
                                          !visualNode &&
                                          !inspected.data.uploaded &&
                                          !inspected.data.storyboard &&
                                          !inspected.data.director && (
                                            <button
                                              type="button"
                                              disabled={busy}
                                              onClick={() => revealGeneration(inspected.id)}
                                            >
                                              <Sparkles size={15} /> 生成内容
                                            </button>
                                          )}
                                        {inspected.type === "creative" &&
                                          inspected.data.kind !== "script" &&
                                          inspected.data.character && (
                                            <button
                                              type="button"
                                              aria-label="导入素材到节点"
                                              disabled={busy}
                                              onClick={() =>
                                                void importMedia({
                                                  nodeId: inspected.id,
                                                  kind: inspected.data.kind,
                                                })
                                              }
                                            >
                                              <Upload size={15} /> 导入
                                            </button>
                                          )}
                                        {inspected.type === "creative" &&
                                          ["video", "audio"].includes(inspected.data.kind) &&
                                          inspected.data.assetId && (
                                            <button
                                              type="button"
                                              disabled={writing}
                                              onClick={() =>
                                                editNode(inspected.id, (current) =>
                                                  current.type === "creative"
                                                    ? {
                                                        ...current,
                                                        data: {
                                                          ...current.data,
                                                          assetId: undefined,
                                                        },
                                                      }
                                                    : current,
                                                )
                                              }
                                            >
                                              解除素材引用
                                            </button>
                                          )}
                                        {inspectedAsset &&
                                        canvasPreviewItem(inspected, inspectedAsset) ? (
                                          <button
                                            type="button"
                                            title="放大"
                                            aria-label="放大"
                                            disabled={busy}
                                            onClick={() => startCanvasPreview(inspected)}
                                          >
                                            <Expand size={16} />
                                          </button>
                                        ) : (
                                          inspectedAsset && (
                                            <button
                                              type="button"
                                              disabled={busy}
                                              onClick={() => void openPreview(inspectedAsset)}
                                            >
                                              预览素材
                                            </button>
                                          )
                                        )}
                                        <button
                                          type="button"
                                          aria-pressed={sidePanel === "properties"}
                                          aria-label="节点属性"
                                          title="节点属性"
                                          onClick={() => togglePanel("properties")}
                                        >
                                          <Settings2 size={15} />
                                        </button>
                                        {inspected.type !== "unknown" && (
                                          <button
                                            type="button"
                                            aria-label="复制节点"
                                            title="复制节点或整组（⌘/Ctrl+D）"
                                            disabled={selectionBusy || !fragment}
                                            onClick={duplicateNodes}
                                          >
                                            <Copy size={15} />
                                          </button>
                                        )}
                                      </div>
                                      {inlineGeneration && generationForm}
                                    </NodeToolbar>
                                  )}
                                {visualNode &&
                                  inlineGeneration &&
                                  outpaintTarget?.nodeId !== visualNode.id &&
                                  trimTarget?.nodeId !== visualNode.id &&
                                  !doodling &&
                                  !framing &&
                                  !splitting && (
                                    <MediaPanelAnchor
                                      id={visualNode.id}
                                      hidden={hand || dragging}
                                      reveal={placedGenerationId !== visualNode.id}
                                    >
                                      {renderMediaForm(visualNode)}
                                    </MediaPanelAnchor>
                                  )}
                                {editableSelection.length >= 2 &&
                                  editableSelection.length === selected.length && (
                                    <SelectionOverlay
                                      openFan={openFan}
                                      ids={editableSelection.map(({ id }) => id)}
                                      visible={!pointerDragging}
                                    >
                                      <div
                                        className="canvas-group-toolbar canvas-selection-tools nodrag nopan"
                                        role="toolbar"
                                        aria-label="多选节点操作"
                                      >
                                        <span className="canvas-selection-count">
                                          {editableSelection.length} 个节点
                                        </span>
                                        <hr
                                          className="group-tools-divider"
                                          data-ui-divider
                                          aria-orientation="vertical"
                                        />
                                        <SelectionButton
                                          label="打组"
                                          shortcut={`${canvasModifier}G`}
                                          disabled={selectionBusy || nodes.length >= 1000}
                                          onClick={groupNodes}
                                        >
                                          <LayoutGrid />
                                          <span>打组</span>
                                        </SelectionButton>
                                        <hr
                                          className="group-tools-divider"
                                          data-ui-divider
                                          aria-orientation="vertical"
                                        />
                                        <ArrangeMenu
                                          disabled={selectionBusy}
                                          choose={arrangeNodes}
                                        />
                                        <hr
                                          className="group-tools-divider"
                                          data-ui-divider
                                          aria-orientation="vertical"
                                        />
                                        <SelectionButton
                                          label="复制"
                                          shortcut={`${canvasModifier}D`}
                                          aria-label="复制选中节点"
                                          disabled={selectionBusy || !fragment}
                                          onClick={duplicateNodes}
                                        >
                                          <Copy size={16} />
                                        </SelectionButton>
                                        <SelectionButton
                                          label="下载素材"
                                          disabled={selectionBusy}
                                          onClick={() => void downloadSelection()}
                                        >
                                          <Download />
                                        </SelectionButton>
                                        <SelectionButton
                                          label="删除"
                                          shortcut="⌫"
                                          className="selection-delete"
                                          aria-label="删除选中节点"
                                          disabled={
                                            selectionBusy ||
                                            editableSelection.some(
                                              (node) => node.deletable === false,
                                            )
                                          }
                                          onClick={() =>
                                            void flowInstance.current?.deleteElements({
                                              nodes: editableSelection.map(({ id }) => ({ id })),
                                            })
                                          }
                                        >
                                          <Trash2 />
                                        </SelectionButton>
                                      </div>
                                    </SelectionOverlay>
                                  )}
                              </ReactFlow>
                            </RunningEdgeTargets.Provider>
                          </OpenTextEditor.Provider>
                        </OpenStoryboard.Provider>
                      </SplitCard.Provider>
                    </RenameTitle.Provider>
                  </VisualMediaActions.Provider>
                </NodeMedia.Provider>
              </CanvasUploadContext.Provider>
            </section>
            {persistence.loaded && !nodes.length && (
              <section className="canvas-empty" aria-labelledby="canvas-empty-title">
                <div className="canvas-empty-heading">
                  <h2 id="canvas-empty-title">从一个节点开始</h2>
                  <p>点下面的卡片，或者双击画布空白处</p>
                </div>
                <div className="canvas-empty-actions">
                  {emptyActions.map(({ kind, label, detail, icon: Icon }) => (
                    <button
                      type="button"
                      key={kind}
                      disabled={busy}
                      data-kind={kind}
                      onClick={() =>
                        kind === "upload"
                          ? void importMedia({ position: defaultPlacement() })
                          : addNode(kind)
                      }
                    >
                      <span className="empty-action-icon">
                        <Icon size={20} />
                      </span>
                      <strong>{label}</strong>
                      <small>{detail}</small>
                    </button>
                  ))}
                </div>
              </section>
            )}
            <AddNodeMenu
              {...menuActions}
              open={!!addMenu && !addMenu.toolbar}
              point={addMenu?.anchor}
              onOpenChange={(open) => {
                if (!open) setAddMenu((current) => (current?.toolbar ? current : undefined));
              }}
            />
            {addMenu?.fan && <FanLines {...addMenu.fan} />}
            {addMenu?.pending?.from && addMenu.pending.to && (
              <FanLines
                exits={[{ id: addMenu.pending.id, ...addMenu.pending.from }]}
                to={addMenu.pending.to}
                reverse={addMenu.pending.type === "target"}
              />
            )}
            <div className="pet-stage" ref={setPetStage} />
            <CanvasShortcutsDialog open={showGuide} onOpenChange={setShowGuide} />
            {characterNode?.data.character &&
              createPortal(
                <div className="canvas-workspace canvas-modal-scope">
                  <CharacterDialog
                    key={characterNode.id}
                    character={characterNode.data.character}
                    episodes={characterNode.data.drama?.episodes}
                    changeVoicePrompt={(voicePrompt) =>
                      editNode(characterNode.id, (node) =>
                        node.type === "creative" && node.data.character
                          ? {
                              ...node,
                              data: {
                                ...node.data,
                                character: { ...node.data.character, voicePrompt },
                              },
                            }
                          : node,
                      )
                    }
                    changeVoiceModel={(voiceModel) =>
                      editNode(characterNode.id, (node) =>
                        node.type === "creative" && node.data.character
                          ? {
                              ...node,
                              data: {
                                ...node.data,
                                character: { ...node.data.character, voiceModel },
                              },
                            }
                          : node,
                      )
                    }
                    cancelVoice={async (job) => {
                      const result = await window.desktop.projects.cancelJob({
                        projectHandle: projectSession.projectHandle,
                        jobId: job.id,
                      });
                      if (!result.ok) return result.error.message ?? result.error.messageKey;
                      if (currentProjectHandle.current === projectSession.projectHandle)
                        setJobs((current) =>
                          current.map((item) => (item.id === job.id ? result.value : item)),
                        );
                    }}
                    changeVoice={(voice) =>
                      editNode(characterNode.id, (node) => {
                        if (node.type !== "creative" || !node.data.character) return node;
                        const character = { ...node.data.character };
                        if (voice) character.voice = voice;
                        else delete character.voice;
                        return { ...node, data: { ...node.data, character } };
                      })
                    }
                    changeIdentity={(patch) =>
                      editNode(characterNode.id, (node) => {
                        if (node.type !== "creative" || !node.data.character) return node;
                        const { character, label } = node.data;
                        return {
                          ...node,
                          data: {
                            ...node.data,
                            character: { ...character, ...patch },
                            label: "name" in patch && label === character.name ? patch.name : label,
                          },
                        };
                      })
                    }
                    removeExtra={(id) =>
                      editNode(characterNode.id, (node) =>
                        node.type === "creative" && node.data.character
                          ? {
                              ...node,
                              data: {
                                ...node.data,
                                character: {
                                  ...node.data.character,
                                  extraAssetIds: node.data.character.extraAssetIds.filter(
                                    (assetId) => assetId !== id,
                                  ),
                                },
                              },
                            }
                          : node,
                      )
                    }
                    projectHandle={projectSession.projectHandle}
                    uploadMedia={async (slot, file) => {
                      let id: string | undefined;
                      await importMedia(undefined, [file], (asset) => {
                        if (
                          asset.mediaType !== (slot === "voice" ? "audio" : "image") ||
                          currentProjectHandle.current !== projectSession.projectHandle
                        )
                          return;
                        if (slot === "voice")
                          editNode(characterNode.id, (node) =>
                            node.type === "creative" && node.data.character
                              ? {
                                  ...node,
                                  data: {
                                    ...node.data,
                                    character: {
                                      ...node.data.character,
                                      voice: characterVoice(
                                        asset.assetId,
                                        "upload",
                                        asset.displayName,
                                      ),
                                    },
                                  },
                                }
                              : node,
                          );
                        else applyCharacterAssets(characterNode.id, slot, [asset]);
                        id = asset.assetId;
                      });
                      return id;
                    }}
                    download={async (assetId) => {
                      const result = await window.desktop.projects.saveAssetCopy({
                        projectHandle: projectSession.projectHandle,
                        assetId,
                      });
                      if (!result.ok)
                        setProjectError(assetErrors[result.error.code] ?? "无法保存原文件");
                    }}
                    assetId={characterNode.data.assetId}
                    assets={assets}
                    jobs={jobs.filter(
                      ({ nodeId, purpose }) =>
                        nodeId === characterNode.id && (purpose === "character-voice" || !purpose),
                    )}
                    settings={generationProviders}
                    importHuman={async (channel, images) => {
                      const batch: ProjectAsset[] = [];
                      for (const image of images) {
                        batch.push(await attachFiled({ channel, image }));
                      }
                      applyCharacterAssets(characterNode.id, "human", batch);
                      return batch.map((asset) => asset.assetId);
                    }}
                    renderPicker={(request, close, confirmed) => (
                      <AssetPickerDialog
                        attachOfficialVoice={attachOfficialVoice}
                        {...pickerServices}
                        character={request}
                        capacity={4}
                        lockedKind={request.purpose === "voice" ? "audio" : "image"}
                        close={close}
                        confirm={(batch) => {
                          applyCharacterAssets(characterNode.id, request.purpose, batch);
                          confirmed(batch);
                        }}
                      />
                    )}
                    generate={(voice) =>
                      submitNodeJobs([
                        { ...voice, nodeId: characterNode.id, purpose: "character-voice" },
                      ])
                    }
                    close={() => setCharacterNodeId(undefined)}
                  />
                </div>,
                document.body,
              )}
            {storyboardNode?.data.storyboard && (
              <StoryboardDialog
                defaultImageProvider={newNodeModel("image").generation?.providerId}
                highlightIds={splitHighlights[storyboardNode.id]}
                resultNotice={splitResultNotice}
                clearHighlights={(ids) =>
                  setSplitHighlights((current) => {
                    if (current[storyboardNode.id] !== ids) return current;
                    const next = { ...current };
                    delete next[storyboardNode.id];
                    return next;
                  })
                }
                initialFocusId={firstShotFocus.current}
                key={storyboardNode.id}
                projectHandle={projectSession.projectHandle}
                locate={(id) => {
                  const target = flowInstance.current?.getNode(id);
                  if (!target) return;
                  setNodes((current) =>
                    current.map((node) => ({ ...node, selected: node.id === id })),
                  );
                  if (
                    target.type === "creative" &&
                    !target.data.uploaded &&
                    isGenerationMedia(target.data.kind)
                  ) {
                    if (sidePanel === "jobs") setSidePanel(null);
                    setGenerationNodeId(id);
                  }
                  void flowInstance.current?.fitView({
                    nodes: [{ id }],
                    duration: 320,
                    padding: 0.8,
                    maxZoom: 1,
                  });
                }}
                initial={storyboardNode.data.storyboard}
                prepareVideo={(shotId) => prepareShotNode(storyboardNode, shotId, "video").error}
                generateImages={async (selection) => {
                  const reserved: Rect[] = [];
                  const errors: string[] = [];
                  const targets = flushSync(() =>
                    selection.flatMap(({ id, provider }) => {
                      const prepared = prepareShotNode(storyboardNode, id, "image", reserved);
                      if (prepared.error || !prepared.nodeId || !prepared.prompt || !provider) {
                        errors.push(prepared.error ?? "图片模型不可用，请在模型设置中启用图片模型");
                        return [];
                      }
                      return [{ nodeId: prepared.nodeId, prompt: prepared.prompt, provider }];
                    }),
                  );
                  for (let offset = 0; offset < targets.length; offset += 100) {
                    const error = await submitNodeJobs(targets.slice(offset, offset + 100));
                    if (error) errors.push(error);
                  }
                  return errors[0];
                }}
                uploadImage={async (shotId, file, progress) => {
                  const boardId = storyboardNode.id;
                  const handle = projectSession.projectHandle;
                  const { asset, revision } = await importShotImage(handle, file, progress);
                  updateRevision(handle, revision);
                  const flow = flowInstance.current;
                  const board = flow?.getNode(boardId);
                  if (!flow || board?.type !== "creative") return;
                  const rows = board.data.storyboard ?? [];
                  const index = rows.findIndex((row) => row.id === shotId);
                  if (index < 0) return;
                  setAssets((current) => [
                    ...current.filter((item) => item.assetId !== asset.assetId),
                    asset,
                  ]);
                  const all = flow.getNodes();
                  const edges = flow.getEdges();
                  const explicit = rows[index]?.imageNodeId;
                  const linked = all.find(
                    (node) =>
                      node.type === "creative" &&
                      node.data.kind === "image" &&
                      (node.id === explicit ||
                        (!explicit &&
                          node.data.shotId === shotId &&
                          edges.some(
                            (edge) => edge.source === boardId && edge.target === node.id,
                          ))),
                  );
                  if (linked) {
                    editNode(linked.id, (node) =>
                      node.type === "creative"
                        ? { ...node, data: appendShotImage(node.data, asset) }
                        : node,
                    );
                    return;
                  }
                  if (all.length >= 1000 || edges.length >= 4000)
                    throw new Error("画布节点或连线数量已达上限");
                  const origin = absoluteNodeRect(board, all);
                  if (!origin) return;
                  const left = origin.x + origin.width + 80;
                  let top = origin.y + index * 364;
                  const boxes = all.flatMap((node) => absoluteNodeRect(node, all) ?? []);
                  for (
                    let step = 0;
                    step < 60 &&
                    boxes.some(
                      (box) =>
                        left < box.x + box.width + 40 &&
                        box.x < left + 616 &&
                        top < box.y + box.height + 40 &&
                        box.y < top + 364,
                    );
                    step++
                  )
                    top += 364;
                  const id = crypto.randomUUID();
                  const base = `镜头 ${String(index + 1).padStart(2, "0")}`;
                  const labels = new Set(all.map((node) => node.data.label));
                  let label = base;
                  for (let suffix = 2; labels.has(label); suffix++) label = `${base} ${suffix}`;
                  setNodes((current) => [
                    ...current.map((node) =>
                      node.id === boardId && node.type === "creative"
                        ? {
                            ...node,
                            data: {
                              ...node.data,
                              storyboard: node.data.storyboard?.map((row) =>
                                row.id === shotId ? { ...row, imageNodeId: id } : row,
                              ),
                            },
                          }
                        : node,
                    ),
                    {
                      id,
                      type: "creative",
                      position: { x: left, y: top },
                      data: appendShotImage({ kind: "image", label, text: "", shotId }, asset),
                    },
                  ]);
                  setEdges((current) => [
                    ...current,
                    { id: crypto.randomUUID(), source: boardId, target: id },
                  ]);
                }}
                change={(edit) =>
                  editNode(storyboardNode.id, (node) =>
                    node.type === "creative"
                      ? {
                          ...node,
                          data: { ...node.data, storyboard: edit(node.data.storyboard ?? []) },
                        }
                      : node,
                  )
                }
                linkedNodes={{
                  image: linkedShotNodes(storyboardNode.id, "image"),
                  video: linkedShotNodes(storyboardNode.id, "video"),
                }}
                jobs={jobs}
                settings={generationProviders}
                script={upstreamScriptText(storyboardNode.id)}
                boardId={storyboardNode.id}
                title={storyboardNode.data.label}
                submitSplit={(prompt, provider, mode) =>
                  submitStoryboardSplit(storyboardNode, prompt, provider, mode)
                }
                close={() => {
                  firstShotFocus.current = undefined;
                  setStoryboardNodeId(undefined);
                }}
              />
            )}
            {!storyboardNode && splitResultNotice}
            {queueNotice && (
              <div role="status" className="shot-batch-notice">
                有 {queueNotice.count} 张没能提交：{queueFullMessage}
              </div>
            )}
            {directorNode?.data.director && (
              <Suspense
                fallback={
                  <p className="canvas-surface canvas-error" role="status">
                    正在打开导演台…
                  </p>
                }
              >
                <DirectorDialog
                  key={directorNode.id}
                  initial={directorNode.data.director}
                  checkCapacity={(count) => {
                    const live = flowInstance.current;
                    if (
                      !live?.getNode(directorNode.id) ||
                      currentProjectHandle.current !== projectSession.projectHandle
                    )
                      throw Error("导演台节点已不存在，导出结果没有放回画布");
                    if (
                      live.getNodes().length + count > 1000 ||
                      live.getEdges().length + count > 4000
                    )
                      throw Error("画布容量不足，请减少导出机位或节点");
                  }}
                  place={(takes) => {
                    const live = flowInstance.current,
                      source = live?.getNode(directorNode.id);
                    if (
                      !live ||
                      !source ||
                      currentProjectHandle.current !== projectSession.projectHandle
                    )
                      throw Error("导演台节点已不存在，导出结果没有放回画布");
                    const all = live.getNodes();
                    const rect = (node: FlowNode) =>
                      absoluteNodeRect(node, all) ?? {
                        ...node.position,
                        width: node.measured?.width ?? node.width ?? 576,
                        height: node.measured?.height ?? node.height ?? 324,
                      };
                    const added = positionDirectorTakes(
                      rect(source),
                      all.map(rect),
                      all.map((node) => node.data.label),
                      source.data.label,
                      takes,
                    );
                    const links = added.map((node) => ({
                      id: crypto.randomUUID(),
                      source: source.id,
                      target: node.id,
                    }));
                    setNodes((current) => [...current, ...added]);
                    setEdges((current) => [...current, ...links]);
                    setAssets((current) => [...current, ...takes.flatMap((take) => take.assets)]);
                    updateRevision(
                      projectSession.projectHandle,
                      Math.max(...takes.map((take) => take.revision)),
                    );
                  }}
                  label={directorNode.data.label}
                  projectHandle={projectSession.projectHandle}
                  write={(scene) =>
                    writeDirectorScene(projectSession.projectHandle, directorNode.id, scene)
                  }
                  finish={(scene, changed) => {
                    setDirectorNodeId(undefined);
                    if (changed || !directorNode.data.directorThumbnailId)
                      void attachDirectorThumbnail(
                        projectSession.projectHandle,
                        directorNode.id,
                        scene,
                      );
                  }}
                />
              </Suspense>
            )}
            {frameTarget && !frameTarget.nodeId && (
              <VideoFrameDialog
                key={frameTarget.asset.assetId}
                asset={frameTarget.asset}
                url={frameTarget.url}
                busy={busy}
                error={frameError}
                close={() => setFrameTarget(undefined)}
                extract={(timeMs) => void extractVideoFrame(timeMs)}
              />
            )}
            {trimTarget && (
              <VideoTrimDialog
                asset={trimTarget.asset}
                url={trimTarget.url}
                busy={trimBusy}
                error={projectError}
                close={() => setTrimTarget(undefined)}
                cancel={
                  mediaOperationId && !mediaCancelling ? () => void cancelMediaTool() : undefined
                }
                save={(start, end, removeAudio) =>
                  void trimVideo(trimTarget.nodeId, trimTarget.asset, start, end, removeAudio)
                }
              />
            )}
            {textNode?.type === "creative" && (
              <Suspense fallback={null}>
                <TextEditorDialog
                  key={textNode.id}
                  title={textNode.data.label}
                  text={textNode.data.text}
                  editable={
                    !writing &&
                    !jobs.some((job) => job.nodeId === textNode.id && !jobIsTerminal(job.status))
                  }
                  close={() => setTextNodeId(undefined)}
                  save={(text, clipped) => {
                    editNode(textNode.id, (node) =>
                      node.type === "creative"
                        ? {
                            ...node,
                            data: {
                              ...node.data,
                              text,
                              textStatus: text.trim() ? "done" : "idle",
                              textError: undefined,
                              textFailureTask: undefined,
                              activeOutputId: undefined,
                            },
                          }
                        : node,
                    );
                    if (clipped) setProjectError("文字太长，只保存了前 20000 个字");
                  }}
                />
              </Suspense>
            )}
            <ShotConfirm
              open={Boolean(deleteGroupRequest)}
              focus={confirmDeleteGroup}
              restoreFocus
              title={`删除「${deleteGroupRequest?.name ?? ""}」？`}
              description={
                deleteGroupRequest?.members
                  ? `里面的 ${deleteGroupRequest.members} 个节点会一起被删除，相关连线也会断开。可以用撤销恢复。`
                  : "这个组里没有节点，只会删除组本身。"
              }
              change={(open) => {
                if (!open) {
                  deleteGroupRequest?.resolve(false);
                  setDeleteGroupRequest(undefined);
                }
              }}
            >
              <button
                type="button"
                ref={confirmDeleteGroup}
                data-destructive
                onClick={() => {
                  deleteGroupRequest?.resolve(true);
                  setDeleteGroupRequest(undefined);
                }}
              >
                {deleteGroupRequest?.members ? "删除组和节点" : "删除组"}
              </button>
            </ShotConfirm>
            {libraryNode &&
              libraryNode.handle === projectSession.projectHandle &&
              inspected?.id === libraryNode.nodeId &&
              inspectedAsset?.assetId === libraryNode.assetId && (
                <LibraryLocationDialog
                  handle={libraryNode.handle}
                  close={() => setLibraryNode(undefined)}
                  confirm={async (folderId) => {
                    const result = await window.desktop.projects.registerLibrary({
                      projectHandle: libraryNode.handle,
                      assetId: libraryNode.assetId,
                      ...(folderId && { folderId }),
                    });
                    if (!result.ok) throw Error(result.error.message ?? "加入资产库失败");
                    setLibraryNotice({ handle: libraryNode.handle });
                  }}
                />
              )}
            {projectError && sidePanel !== "assets" && !importing && (
              <div className="canvas-surface canvas-error" role="alert">
                {projectError}
                <button type="button" aria-label="关闭提示" onClick={() => setProjectError("")}>
                  <X size={15} />
                </button>
              </div>
            )}
            <div className="canvas-notice" data-recovery={!!saveError}>
              {stripNotice?.handle === projectSession.projectHandle && (
                <span role="status">{stripNotice.message}</span>
              )}
              {libraryNotice?.handle === projectSession.projectHandle && (
                <span role="status">已加入资产库</span>
              )}
              {assetBatchNotice && (
                <span role="status">已引入 {assetBatchNotice.count} 个素材</span>
              )}
              {saveError && (
                <span role="status">
                  {saveError === "CANVAS_REVISION_CONFLICT"
                    ? "画布保存冲突，本地更改已保留"
                    : "画布保存失败，本地更改已保留"}
                </span>
              )}
              {saveError && (
                <div className="canvas-recovery">
                  {saveError === "CANVAS_REVISION_CONFLICT" ? (
                    <button type="button" disabled={busy} onClick={() => void recoverCanvas(false)}>
                      合并非重叠改动
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void saveCanvas(projectSession)}
                    >
                      重试保存
                    </button>
                  )}
                  {saveError === "CANVAS_REVISION_CONFLICT" && (
                    <button type="button" disabled={busy} onClick={() => void preserveConflict()}>
                      另存为新画布
                    </button>
                  )}
                  <button type="button" disabled={busy} onClick={() => void recoverCanvas(true)}>
                    重新载入画布
                  </button>
                  {recoveryError && <span role="alert">{recoveryError}</span>}
                </div>
              )}
            </div>
          </main>
          {versionNode?.type === "creative" && (
            <NodeVersionDialog
              key={versionNode.id}
              data={versionNode.data}
              jobs={versionJobs(jobs, versionNode.id, versionNode.data.kind)}
              assets={assets}
              handle={projectSession.projectHandle}
              close={() => setVersionNodeId(undefined)}
              download={downloadOutput}
              choose={(output) =>
                editNode(versionNode.id, (node) =>
                  node.type === "creative"
                    ? {
                        ...node,
                        data: withPrimaryAsset(
                          { ...node.data, outputs: versionOutputs(node.data) },
                          output.assetId,
                          output.id,
                        ),
                      }
                    : node,
                )
              }
              cancel={async (ids) => {
                for (const jobId of ids) {
                  const result = await window.desktop.projects.cancelJob({
                    projectHandle: projectSession.projectHandle,
                    jobId,
                  });
                  if (!result.ok) setProjectError(result.error.message ?? result.error.code);
                }
              }}
              add={(outputs) => {
                const rect = (node: FlowNode) =>
                  absoluteNodeRect(node, nodes) ?? {
                    ...node.position,
                    width: node.measured?.width ?? node.width ?? 280,
                    height: node.measured?.height ?? node.height ?? 220,
                  };
                const created = versionNodes(
                  versionNode.data,
                  outputs,
                  rect(versionNode),
                  nodes.map(rect),
                );
                if (nodes.length + created.length > 1000)
                  throw new Error("添加后节点数量超过 1000 个上限");
                if (created.length)
                  setNodes((all) => [
                    ...all.map((node) => ({ ...node, selected: false })),
                    ...created,
                  ]);
                return created.length;
              }}
            />
          )}
          {preview && <AssetPreview {...preview} close={() => setPreview(null)} />}
          {canvasPreview && (
            <ShotImagePreview
              items={previewItems}
              activeId={canvasPreview.id}
              origin={canvasPreview.origin}
              countLabel="相邻节点"
              projectHandle={projectSession.projectHandle}
              close={() => setCanvasPreview(undefined)}
              select={(id) => setCanvasPreview((current) => current && { ...current, id })}
              download={async (assetId) => {
                const result = await window.desktop.projects.saveAssetCopy({
                  projectHandle: projectSession.projectHandle,
                  assetId,
                });
                if (!result.ok) setProjectError(assetErrors[result.error.code] ?? "无法保存原文件");
              }}
              locate={(id) => {
                setCanvasPreview(undefined);
                setNodes((current) =>
                  current.map((node) => ({ ...node, selected: node.id === id })),
                );
                void flowInstance.current?.fitView({
                  nodes: [{ id }],
                  duration: 320,
                  padding: 0.8,
                  maxZoom: 1,
                });
              }}
            />
          )}
          {compositionOpen && projectSession && (
            <CompositionDialog
              assets={assets}
              projectHandle={projectSession.projectHandle}
              initialVideoIds={nodes
                .filter(
                  (node): node is CreativeNode =>
                    node.type === "creative" && node.data.kind === "video" && !!node.data.assetId,
                )
                .sort(
                  (left, right) =>
                    left.position.y - right.position.y || left.position.x - right.position.x,
                )
                .map((node) => node.data.assetId)
                .filter((assetId): assetId is string => !!assetId)}
              close={() => setCompositionOpen(false)}
              done={async ({ asset }) => {
                setCompositionOpen(false);
                await refreshAssets(projectSession.projectHandle);
                await openPreview(asset);
              }}
            />
          )}
          <aside
            className="side-panel canvas-dock"
            hidden={!sidePanel || sidePanel === "assets" || sidePanel === "assistant"}
          >
            <button
              className="close-canvas-dock"
              type="button"
              aria-label="关闭侧栏"
              onClick={() => setSidePanel(null)}
            >
              <X size={17} />
            </button>
            {sidePanel === "properties" && (
              <section className="node-properties" aria-label="节点属性" inert={writing}>
                <h2>节点属性</h2>
                {inspected && inspected.type !== "unknown" ? (
                  <div className="node-fields">
                    {inspected.type === "creative" && inspected.data.character && (
                      <label>
                        角色设定
                        <textarea
                          maxLength={500}
                          value={inspected.data.character.description}
                          onChange={(event) => {
                            const description = event.target.value;
                            editNode(inspected.id, (node) =>
                              node.type === "creative" && node.data.character
                                ? {
                                    ...node,
                                    data: {
                                      ...node.data,
                                      character: { ...node.data.character, description },
                                    },
                                  }
                                : node,
                            );
                          }}
                        />
                      </label>
                    )}
                    {inspected.type === "creative" &&
                      inspectedKind === "script" &&
                      !inspected.data.uploaded && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setSidePanel(null);
                            revealGeneration(inspected.id);
                          }}
                        >
                          生成内容
                        </button>
                      )}
                    {inspected.type === "creative" &&
                      inspected.data.assetId &&
                      (inspected.data.kind === "video" || inspected.data.kind === "audio") && (
                        <button
                          type="button"
                          onClick={() =>
                            editNode(inspected.id, (current) =>
                              current.type === "creative"
                                ? { ...current, data: { ...current.data, assetId: undefined } }
                                : current,
                            )
                          }
                        >
                          解除素材引用
                        </button>
                      )}
                    <label>
                      名称
                      <input
                        maxLength={255}
                        value={inspected.data.label}
                        onChange={(event) => {
                          const label = event.target.value;
                          editNode(
                            inspected.id,
                            (node) => ({ ...node, data: { ...node.data, label } }) as FlowNode,
                          );
                        }}
                      />
                    </label>
                    {inspected.type === "creative" &&
                      (jobs.some(({ nodeId }) => nodeId === inspected.id) ||
                        (inspected.data.outputs?.length ?? 0) > 0) && (
                        <NodeGenerationHistory
                          nodeId={inspected.id}
                          versionLocked={
                            isPlainGeneratedMedia(inspected.data) &&
                            !inspected.data.assetId &&
                            jobs.some(
                              (job) => job.nodeId === inspected.id && !jobIsTerminal(job.status),
                            )
                          }
                          jobs={jobs}
                          assets={assets}
                          outputs={inspected.type === "creative" ? inspected.data.outputs : []}
                          activeOutputId={
                            inspected.type === "creative"
                              ? inspected.data.activeOutputId
                              : undefined
                          }
                          onPreview={(asset) => void openPreview(asset)}
                          onBind={(assetId) => {
                            editNode(inspected.id, (node) =>
                              node.type === "creative"
                                ? {
                                    ...node,
                                    data: withPrimaryAsset(node.data, assetId),
                                  }
                                : node,
                            );
                          }}
                          onRetry={() => retryGeneration(inspected.id)}
                          onOpenJobs={() => setSidePanel("jobs")}
                          onSelectOutput={(output) => {
                            editNode(inspected.id, (node) =>
                              node.type === "creative"
                                ? {
                                    ...node,
                                    data:
                                      output.kind === "text"
                                        ? {
                                            ...withPrimaryAsset(node.data, undefined, output.id),
                                            text: output.text ?? "",
                                          }
                                        : withPrimaryAsset(node.data, output.assetId, output.id),
                                  }
                                : node,
                            );
                          }}
                          onDownloadAll={() =>
                            void Promise.all(
                              (inspected.type === "creative" ? (inspected.data.outputs ?? []) : [])
                                .filter((output) => output.assetId)
                                .map((output) => downloadOutput(output)),
                            )
                          }
                          onAddAll={() => {
                            const outputNodes =
                              inspected.type === "creative"
                                ? (inspected.data.outputs ?? [])
                                    .map(outputAsset)
                                    .filter((asset): asset is ProjectAsset => !!asset)
                                : [];
                            outputNodes.forEach((asset, index) => {
                              addAssetNode(asset, {
                                x: inspected.position.x + 320 + (index % 3) * 300,
                                y: inspected.position.y + Math.floor(index / 3) * 240,
                              });
                            });
                          }}
                        />
                      )}
                    {inspected.type === "creative" && inspected.data.kind !== "script" && (
                      <>
                        <label>
                          关联素材
                          <select
                            value={inspected.data.assetId ?? ""}
                            onChange={(event) => {
                              const assetId = event.target.value || undefined;
                              editNode(inspected.id, (node) =>
                                node.type === "creative"
                                  ? {
                                      ...node,
                                      data: withPrimaryAsset(node.data, assetId),
                                    }
                                  : node,
                              );
                            }}
                          >
                            <option value="">未绑定</option>
                            {assets
                              .filter(
                                (asset) =>
                                  asset.mediaType === inspected.data.kind &&
                                  (asset.availability === "ready" ||
                                    inspected.data.assetId === asset.assetId),
                              )
                              .map((asset) => (
                                <option key={asset.assetId} value={asset.assetId}>
                                  {asset.displayName}
                                  {asset.availability === "missing" ? "（待定位）" : ""}
                                </option>
                              ))}
                          </select>
                        </label>
                        {assets
                          .filter(
                            (asset) =>
                              asset.assetId === inspected.data.assetId &&
                              asset.availability === "ready",
                          )
                          .map((asset) => (
                            <button
                              key={asset.assetId}
                              type="button"
                              onClick={() => void openPreview(asset)}
                            >
                              预览关联素材
                            </button>
                          ))}
                        {inspectedAsset?.mediaType === "video" && (
                          <button
                            type="button"
                            disabled={busy || splitCapacity < 1}
                            onClick={() => void openTrim(inspectedAsset, inspected.id)}
                          >
                            裁切视频
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  <p>
                    {inspected?.type === "unknown"
                      ? "此节点由其他版本创建，当前只读。"
                      : "选择单个节点查看属性。"}
                  </p>
                )}
              </section>
            )}
            {sidePanel === "runtime" ? (
              <RuntimePanel />
            ) : (
              sidePanel === "jobs" && (
                <JobCenter
                  jobs={jobs}
                  assets={assets}
                  onPreview={(asset) => void openPreview(asset)}
                  onRetry={retryGeneration}
                  onAction={async (action, jobId) => {
                    const result = await window.desktop.projects[action]({
                      projectHandle: projectSession.projectHandle,
                      jobId,
                    });
                    return result.ok ? undefined : result.error.code;
                  }}
                />
              )
            )}
          </aside>
          <CanvasAssistant
            canvasName={
              showSettings || dramaHandle === projectSession.projectHandle
                ? null
                : projectSession.name
            }
            petStage={petStage}
            toggle={() => togglePanel("assistant")}
            close={() => setSidePanel(null)}
            key={projectSession.projectHandle}
            projectHandle={projectSession.projectHandle}
            providers={generationProviders.providers}
            plugins={generationProviders.plugins}
            selection={selected.map(({ id, data }) => ({ id, label: data.label }))}
            nodes={canvas.nodes}
            canvasRevision={persistence.canvasRevision}
            assets={assets}
            visible={sidePanel === "assistant" && !showSettings}
            openSettings={() => setShowSettings(true)}
            locateNode={(id) => {
              const flow = flowInstance.current;
              if (!flow?.getNode(id)) return;
              setNodes((current) =>
                current.map((node) =>
                  node.selected || node.id === id ? { ...node, selected: node.id === id } : node,
                ),
              );
              marks.touch([id]);
              void flow.fitView({
                nodes: [{ id }],
                duration: 320,
                padding: 0.8,
                maxZoom: 1,
              });
            }}
            jobs={jobs}
            openJobs={() => setSidePanel("jobs")}
            locateResults={(ids) => {
              void locatePetResults(flowInstance.current, ids);
            }}
            beforeWrite={async () => !writing && !dragging && !!(await saveCanvas(projectSession))}
          />
        </div>,
        canvasHost,
      )}
      <CanvasToaster />
    </AgentMarks.Provider>
  );
}

import { sanitizeFileName } from "@link-studio/core";
