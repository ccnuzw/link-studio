import type {
  CanvasCharacter,
  CanvasOperation,
  CanvasShot,
  CreativeData,
  CreativeOutput,
  DirectorScene,
  GenerationInput,
  GenerationJob,
  ImportStatus,
  ProjectAsset,
  ProjectCanvasView,
  ProjectSession,
  ProviderView,
  RecentProject,
} from "@link-studio/core";
import {
  type AppInfo,
  isAppInfo,
  jobIsTerminal,
  mergeCanvasExchange,
  parseCanvasExchange,
  prepareCanvasExchange,
  serializeCanvasExchange,
} from "@link-studio/core";
import {
  Background,
  type Connection,
  type Edge,
  type EdgeChange,
  Handle,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  NodeToolbar,
  Position,
  ReactFlow,
  type ReactFlowInstance,
  useEdgesState,
  useNodesState,
  useReactFlow,
  ViewportPortal,
} from "@xyflow/react";
import {
  AudioLines,
  Check,
  CircleHelp,
  Clapperboard,
  Columns3,
  Copy,
  Cpu,
  Download,
  Ellipsis,
  Expand,
  FileUp,
  FolderOpen,
  Grid2X2,
  Hand,
  Image,
  Layers3,
  ListChecks,
  ListVideo,
  Map as MapIcon,
  Minus,
  MousePointer2,
  PenLine,
  Play,
  Plus,
  Redo2,
  Rows3,
  ScanLine,
  Scissors,
  Settings2,
  Sparkles,
  Type,
  Undo2,
  Upload,
  UserRound,
  Video,
  X,
} from "lucide-react";
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import brandIcon from "../../../resources/brand/icon.svg";
import { SettingsPage } from "../settings/settings-page";
import { SkillsPage } from "../skills/skills-page";
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
import { CanvasAssistant } from "./canvas-assistant";
import { CanvasEdge, type CanvasFlowEdge } from "./canvas-edge";
import { CanvasShortcuts } from "./canvas-shortcuts";
import { CharacterDialog } from "./character-dialog";
import { CompositionDialog } from "./composition-dialog";
import { edgeIdsHitBySweep } from "./edge-sweep";
import { fanOutTargetPosition } from "./fan-out";
import {
  GenerationForm,
  isVisualMedia,
  JobCenter,
  NodeGenerationHistory,
  useGenerationProviders,
  type VisualMediaKind,
} from "./generation";
import { GridSplitDialog, type GridSplitDraft } from "./grid-split-dialog";
import { ImageDoodleDialog } from "./image-doodle-dialog";
import { ImageOutpaintDialog, type OutpaintDraft } from "./image-outpaint-dialog";
import { linkedMediaSources } from "./media-references";
import {
  type ArrangeMode,
  arrangeSelection,
  type CanvasFragment,
  captureSelection,
  cloneSelection,
} from "./selection-actions";
import { NODE_KINDS, NODE_LABELS, type NodeKind, useWorkspace } from "./store";
import { StoryboardDialog } from "./storyboard-dialog";
import { useCanvasHistory } from "./use-canvas-history";
import { useCanvasSave } from "./use-canvas-save";
import { VideoFrameDialog } from "./video-frame-dialog";
import { VideoTrimDialog } from "./video-trim-dialog";

const NODE_ICONS = { script: Type, image: Image, video: Video, audio: AudioLines };
const DirectorDialog = lazy(async () => ({
  default: (await import("./director-dialog")).DirectorDialog,
}));
const emptyDirector: DirectorScene = {
  version: 1,
  duration: 5,
  activeCameraId: "",
  characters: [],
  props: [],
  cameras: [],
};
const defaultCharacter: CanvasCharacter = {
  name: "新角色",
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
type CreativeNode = Node<CreativeData, "creative"> & { type: "creative" };
type FlowNode =
  | CreativeNode
  | (Node<{ label: string }, "group"> & { type: "group" })
  | (Node<{ label: string }, "unknown"> & { type: "unknown" });
type FlowEdge = Edge<{ readOnly?: true }>;
const initialViewport = { x: 20, y: 10, zoom: 0.9 };
const CanvasTextEdit = createContext<(key: string | null) => void>(() => undefined);
const NodeMedia = createContext<{
  assets: ProjectAsset[];
  projectHandle: string;
  writing: boolean;
} | null>(null);
type VisualMediaTarget = { nodeId: string; kind: VisualMediaKind };
const VisualMediaActions = createContext<{
  busy: boolean;
  upload: (target: VisualMediaTarget) => void;
  library: (target: VisualMediaTarget) => void;
  preview: (asset: ProjectAsset) => void;
} | null>(null);
type Point = { x: number; y: number };
const emptyActions = [
  { kind: "image", label: "图片生成", detail: "从描述生成画面", icon: Image },
  { kind: "video", label: "视频生成", detail: "让画面动起来", icon: Video },
  { kind: "script", label: "文本", detail: "记录灵感与脚本", icon: Type },
  { kind: "upload", label: "上传素材", detail: "导入本地图片、视频或音频", icon: Upload },
] as const;
const assetErrors: Record<string, string> = {
  ASSET_READ_FAILED: "文件无法读取或媒体内容无效",
  ASSET_IMPORT_CANCELLED: "已取消媒体处理",
  ASSET_TYPE_UNSUPPORTED: "暂不支持此文件类型",
  ASSET_SIZE_LIMIT: "媒体超过导入限制",
  ASSET_STORAGE_FAILED: "无法写入项目副本或保存素材定位",
  ASSET_REFERENCE_CHANGED: "文件内容与原素材不一致，请选择内容相同的文件",
  ASSET_NOT_FOUND: "素材文件不可用，请刷新素材库或重新定位",
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
  children,
}: {
  assetId?: string;
  kind: Exclude<NodeKind, "script">;
  children?: ReactNode;
}) {
  const media = useContext(NodeMedia);
  const asset = media?.assets.find((item) => item.assetId === assetId);
  const handle = media?.projectHandle;
  const ready = asset?.availability === "ready";
  const [preview, setPreview] = useState<{ assetId: string; url: string }>();
  useEffect(() => {
    if (!handle || !assetId || !ready || !isVisualMedia(kind)) return;
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
      {url && kind === "image" ? (
        <img src={url} alt={asset?.displayName ?? ""} loading="lazy" />
      ) : (
        <>
          <Icon size={27} />
          <span>
            {assetId
              ? ready
                ? asset?.displayName
                : "素材待定位"
              : isVisualMedia(kind)
                ? `选中后输入提示词生成${NODE_LABELS[kind]}`
                : `等待生成或导入${NODE_LABELS[kind]}`}
          </span>
          {kind === "video" && url && (
            <video className="node-video-frame" src={url} muted preload="metadata" tabIndex={-1} />
          )}
        </>
      )}
      {children}
    </div>
  );
}

function CreativeCard({ data, id, selected }: NodeProps<CreativeNode>) {
  const Icon = data.director
    ? Clapperboard
    : data.storyboard
      ? ListVideo
      : data.character
        ? UserRound
        : NODE_ICONS[data.kind];
  const { updateNodeData } = useReactFlow<FlowNode>();
  const markEdit = useContext(CanvasTextEdit);
  const media = useContext(NodeMedia);
  const actions = useContext(VisualMediaActions);
  const writing = media?.writing;
  const visual = isVisualMedia(data.kind);
  const target = isVisualMedia(data.kind) ? { nodeId: id, kind: data.kind } : undefined;
  const asset = media?.assets.find(
    ({ assetId, availability }) => assetId === data.assetId && availability === "ready",
  );
  return (
    <article className={`creative-card ${selected ? "is-selected" : ""}`} data-visual={visual}>
      <Handle type="target" position={Position.Left} />
      <header>
        <span className={`node-icon ${data.kind}`}>
          <Icon size={17} />
        </span>
        <strong>{data.label}</strong>
        {!visual && (
          <span className="node-kind">
            {data.director ? "导演台" : data.storyboard ? "分镜表" : NODE_LABELS[data.kind]}
          </span>
        )}
      </header>
      {data.kind !== "script" && (
        <NodeAsset key={data.assetId} assetId={data.assetId} kind={data.kind}>
          {target && actions && !asset && (
            <div className="media-fill-actions nodrag nopan">
              <button
                type="button"
                className="media-fill-button"
                disabled={actions.busy}
                aria-label="导入素材到节点"
                onClick={() => actions.upload(target)}
              >
                <Upload size={15} /> 上传
              </button>
              <button
                type="button"
                className="media-fill-button"
                disabled={actions.busy}
                aria-label="从素材库选择素材"
                onClick={() => actions.library(target)}
              >
                <FolderOpen size={16} /> 素材库
              </button>
            </div>
          )}
          {target?.kind === "video" && asset && actions && (
            <button
              type="button"
              className="node-video-play nodrag nopan"
              disabled={actions.busy}
              aria-label={`播放${asset.displayName}`}
              onClick={() => actions.preview(asset)}
            >
              <Play size={19} />
            </button>
          )}
        </NodeAsset>
      )}
      {data.storyboard && (
        <p className="storyboard-summary">
          {data.storyboard.length} 个镜头 ·{" "}
          {Number(data.storyboard.reduce((sum, row) => sum + row.duration, 0).toFixed(1))} 秒
        </p>
      )}
      {data.director && (
        <p className="storyboard-summary">
          {data.director.cameras.length} 个机位 · {data.director.duration} 秒
        </p>
      )}
      {!visual && !data.storyboard && !data.director && (
        <label className="node-body nodrag nopan">
          <span className="sr-only">{data.label}内容</span>
          <textarea
            value={data.text}
            readOnly={writing}
            onChange={(event) => {
              markEdit(`${id}/text`);
              updateNodeData(id, { text: event.target.value, activeOutputId: undefined });
            }}
            aria-label={`${data.label}内容`}
            placeholder={data.kind === "script" ? "写下你的创作想法…" : "描述你希望生成的内容…"}
            data-node-id={id}
            maxLength={32768}
          />
        </label>
      )}
      {data.assetId && (
        <footer>
          <button
            type="button"
            className="nodrag"
            disabled={writing}
            onClick={() => {
              markEdit(null);
              updateNodeData(id, { assetId: undefined });
            }}
          >
            解除素材引用
          </button>
        </footer>
      )}
      <Handle type="source" position={Position.Right} />
    </article>
  );
}

function GroupCard({ data }: NodeProps<Extract<FlowNode, { type: "group" }>>) {
  return (
    <div className="canvas-group">
      <Layers3 size={14} />
      {data.label}
    </div>
  );
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
        return { ...node, draggable: !parents.has(node.id), deletable: false, connectable: false };
      return { ...node, deletable: !locked.has(node.id) };
    }),
  );
}

function flowEdges(canvas: ProjectCanvasView): FlowEdge[] {
  return canvas.edges.map(({ readOnly, ...edge }) =>
    readOnly ? { ...edge, deletable: false, data: { readOnly } } : edge,
  );
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
  const [showSettings, setShowSettings] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const settingsPage = showSettings && (
    <>
      <div hidden={showSkills}>
        <SettingsPage close={() => setShowSettings(false)} openSkills={() => setShowSkills(true)} />
      </div>
      {showSkills && <SkillsPage close={() => setShowSkills(false)} />}
    </>
  );
  const [nodes, setNodes, applyNodeChanges] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [dragging, setDragging] = useState(false);
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
  const [mergeKey, setMergeKey] = useState<string | null>(null);
  const { sidePanel, setSidePanel } = useWorkspace();
  const [hand, setHand] = useState(false);
  const [sweepMode, setSweepMode] = useState(false);
  const [sweepPoints, setSweepPoints] = useState<Point[]>([]);
  const [showMap, setShowMap] = useState(false);
  const [addMenu, setAddMenu] = useState<{ anchor: Point; position: Point }>();
  const [assetPlacement, setAssetPlacement] = useState<Point>();
  const [assetTarget, setAssetTarget] = useState<VisualMediaTarget>();
  const canvasArea = useRef<HTMLElement>(null);
  const menuElement = useRef<HTMLElement>(null);
  const menuTrigger = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  useEffect(() => {
    if (!addMenu) return;
    menuElement.current?.querySelector("button")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof globalThis.Node &&
        !menuElement.current?.contains(event.target) &&
        !addButton.current?.contains(event.target)
      )
        setAddMenu(undefined);
    };
    const dismissByKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setAddMenu(undefined);
      (menuTrigger.current ?? addButton.current)?.focus();
    };
    const resize = () => setAddMenu(undefined);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissByKeyboard);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissByKeyboard);
      window.removeEventListener("resize", resize);
    };
  }, [addMenu]);
  const [showGuide, setShowGuide] = useState(false);
  const [projectSession, setProjectSession] = useState<ProjectSession | null>(null);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [projectName, setProjectName] = useState("");
  const [projectError, setProjectError] = useState("");
  const [projectBusy, setProjectBusy] = useState(false);
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const projectHandle = projectSession?.projectHandle;
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [generationNodeId, setGenerationNodeId] = useState<string>();
  const generationProviders = useGenerationProviders(!!projectSession && !showSettings);
  const [importing, setImporting] = useState(false);
  const [importMode, setImportMode] = useState<ProjectAsset["importMode"]>("copy");
  const [activeImport, setActiveImport] = useState<{
    id: string;
    name: string;
    status: ImportStatus;
  } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [preview, setPreview] = useState<{ asset: ProjectAsset; url: string } | null>(null);
  const [compositionOpen, setCompositionOpen] = useState(false);
  const [splitTarget, setSplitTarget] = useState<{
    nodeId: string;
    asset: ProjectAsset;
    url: string;
  }>();
  const [splitError, setSplitError] = useState("");
  const [doodleTarget, setDoodleTarget] = useState<{
    nodeId: string;
    asset: ProjectAsset;
    url: string;
  }>();
  const [doodleError, setDoodleError] = useState("");
  const [doodleBusy, setDoodleBusy] = useState(false);
  const [characterNodeId, setCharacterNodeId] = useState<string>();
  const [storyboardNodeId, setStoryboardNodeId] = useState<string>();
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
  const flowInstance = useRef<ReactFlowInstance<FlowNode, FlowEdge> | null>(null);
  const [writing, setWriting] = useState(false);
  const nodeMedia = useMemo(
    () => (projectHandle ? { assets, projectHandle, writing } : null),
    [assets, projectHandle, writing],
  );
  const [recoveryError, setRecoveryError] = useState("");
  const canvas: ProjectCanvasView = useMemo(
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
            data: { label: node.data.label },
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
          activeOutputId,
          character,
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
            ...(outputs ? { outputs } : {}),
            ...(activeOutputId ? { activeOutputId } : {}),
            ...(character ? { character } : {}),
            ...(storyboard ? { storyboard } : {}),
            ...(shotId ? { shotId } : {}),
            ...(director ? { director } : {}),
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
    [nodes, edges, viewport],
  );
  const updateRevision = useCallback((projectHandle: string, revision: number) => {
    setProjectSession((current) =>
      current?.projectHandle === projectHandle && revision > current.revision
        ? { ...current, revision }
        : current,
    );
  }, []);
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
    if (importing || writing || dragging) {
      setProjectError("请完成当前操作后关闭窗口");
      return false;
    }
    setWriting(true);
    const saved = await saveCanvas(projectSession);
    if (!saved) setWriting(false);
    return Boolean(saved);
  };
  useEffect(() => window.desktop.canvasWindow.onSaveBeforeClose(() => closeCanvas.current()), []);
  useEffect(() => {
    window.desktop.canvasWindow.setPending(
      Boolean(projectSession && (dirty || saving || importing || writing || dragging)),
    );
  }, [projectSession, dirty, saving, importing, writing, dragging]);
  const restoreCanvas = (next: ProjectCanvasView) => {
    setNodes(flowNodes(next));
    setEdges(flowEdges(next));
    setViewport(next.viewport);
  };
  const history = useCanvasHistory(canvas, restoreCanvas, dragging, mergeKey);
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
  const onNodeDragStop = () => {
    alignmentSession.current = null;
    setAlignmentGuidesState([]);
  };
  const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
    changes = adjustAlignmentChanges(changes);
    for (const change of changes) {
      if (change.type === "position" && change.dragging !== undefined) {
        setDragging(change.dragging);
        setMergeKey(null);
      }
    }
    applyNodeChanges(writing ? changes.filter(({ type }) => type === "dimensions") : changes);
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

  const refreshAssets = useCallback(async (projectHandle: string) => {
    const result = await window.desktop.projects.listAssets({ projectHandle });
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
      setMergeKey(null);
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

  const syncGeneratedCanvas = useRef(async (_handle: string, _revision: number) => {});
  syncGeneratedCanvas.current = async (handle, revision) => {
    if (
      projectSession?.projectHandle !== handle ||
      writing ||
      saving ||
      dragging ||
      importing ||
      !persistence.canvasRevision ||
      revision <= persistence.canvasRevision
    )
      return;
    setWriting(true);
    try {
      const merged = await persistence.recover(projectSession, false);
      if (merged) {
        const selectedIds = new Set(nodes.filter((node) => node.selected).map(({ id }) => id));
        setNodes(
          flowNodes(merged).map((node) => ({ ...node, selected: selectedIds.has(node.id) })),
        );
        setEdges(flowEdges(merged));
        history.reset(merged);
      }
    } finally {
      setWriting(false);
    }
  };
  const activeHandle = projectSession?.projectHandle;
  useEffect(() => {
    setJobs([]);
    setGenerationNodeId(undefined);
    if (!activeHandle) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    let previous = "";
    let previousRevision = -1;
    const poll = async () => {
      const result = await window.desktop.projects.listJobs({ projectHandle: activeHandle });
      if (!mounted) return;
      if (result.ok) {
        const signature = JSON.stringify(result.value.jobs);
        if (signature !== previous) {
          previous = signature;
          setJobs(result.value.jobs);
        }
        if (result.value.revision !== previousRevision) {
          previousRevision = result.value.revision;
          void refreshAssets(activeHandle);
        }
        updateRevision(activeHandle, result.value.revision);
        await syncGeneratedCanvas.current(activeHandle, result.value.canvasRevision);
      }
      if (mounted) timer = setTimeout(() => void poll(), 600);
    };
    void poll();
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [activeHandle, refreshAssets, updateRevision]);

  const enterProject = async (session: ProjectSession) => {
    const { projectHandle } = session;
    setAssets([]);
    setImportMode("copy");
    setSidePanel(null);
    setHand(false);
    setShowMap(false);
    setShowGuide(false);
    setAddMenu(undefined);
    setAssetPlacement(undefined);
    setAssetTarget(undefined);
    setRenaming(false);
    setGenerationNodeId(undefined);
    persistence.load(null);
    setRecoveryError("");
    setDragging(false);
    setMergeKey(null);
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
  };

  const createProject = async () => {
    setProjectError("");
    const selected = await window.desktop.dialogs.selectProjectParent();
    if (!selected.ok) return setProjectError(selected.error.messageKey);
    if (selected.value.cancelled) return;
    setProjectBusy(true);
    try {
      const result = await window.desktop.projects.create({
        directoryToken: selected.value.directoryToken,
        operationId: crypto.randomUUID(),
        name: projectName.trim() || "未命名项目",
      });
      if (result.ok) await enterProject(result.value);
      else setProjectError(result.error.messageKey);
    } finally {
      setProjectBusy(false);
    }
  };

  const openProject = async () => {
    setProjectError("");
    const selected = await window.desktop.dialogs.selectProject();
    if (!selected.ok) return setProjectError(selected.error.messageKey);
    if (selected.value.cancelled) return;
    const result = await window.desktop.projects.open({
      directoryToken: selected.value.directoryToken,
    });
    if (result.ok && result.value.disposition === "opened")
      await enterProject(result.value.session);
    else if (result.ok) setProjectError("项目已在另一个窗口打开");
    else setProjectError(result.error.messageKey);
  };

  const openRecentProject = async (recentEntryId: string) => {
    const result = await window.desktop.projects.openRecent({ recentEntryId });
    if (result.ok && result.value.disposition === "opened")
      await enterProject(result.value.session);
    else if (result.ok) setProjectError("项目已在另一个窗口打开");
    else setProjectError(result.error.messageKey);
  };

  const importMedia = async (target?: { position: Point } | { nodeId: string; kind: NodeKind }) => {
    const session = projectSession;
    if (!session || importing || writing) return;
    setProjectError("");
    setImporting(true);
    if (target) {
      setAssetPlacement(undefined);
      setAssetTarget(undefined);
      setSidePanel("assets");
    }
    const { projectHandle } = session;
    let revision = session.revision;
    let added = 0;
    try {
      const selected = await window.desktop.dialogs.selectMedia({
        projectHandle,
        multiSelect: !target || "position" in target,
      });
      if (!selected.ok) return setProjectError(selected.error.messageKey);
      if (selected.value.cancelled) return;
      for (const { fileToken, displayName } of selected.value.files) {
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
          setActiveImport({ id: query.importSessionId, name: displayName, status });
          if (status.phase === "imported") {
            revision = status.revision;
            if (target && "position" in target) {
              addAssetNode(status.asset, {
                x: target.position.x + added * 34,
                y: target.position.y + added * 34,
              });
              added += 1;
            } else if (target && "nodeId" in target) {
              if (status.asset.mediaType === target.kind) {
                editNode(target.nodeId, false, (node) =>
                  node.type === "creative"
                    ? {
                        ...node,
                        data: withPrimaryAsset(node.data, status.asset.assetId),
                      }
                    : node,
                );
              } else
                setProjectError(
                  `素材已导入素材库，请为此节点选择${NODE_LABELS[target.kind]}素材。`,
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
                ? await new Promise<"reuse" | "independent" | "cancel">((resolve) =>
                    setDuplicate({ displayName, resolve }),
                  )
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
        if (!result.ok)
          setProjectError(`${displayName} · ${assetErrors[result.error.code] ?? "导入失败"}`);
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

  const onConnect = ({ source, target }: Connection) => {
    if (source === target || writing || !persistence.loaded) return;
    setMergeKey(null);
    setEdges((current) =>
      current.length >= 4000 ||
      current.some((edge) => edge.source === source && edge.target === target)
        ? current
        : [...current, { id: crypto.randomUUID(), source, target }],
    );
  };

  const disconnectEdge = (id: string) => {
    if (writing || !persistence.loaded) return;
    setMergeKey(null);
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
      setMergeKey(null);
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

  if (!projectSession) {
    return (
      <>
        {settingsPage}
        <main className="project-home" hidden={showSettings}>
          <header className="project-home-header">
            <img className="brand-mark" src={brandIcon} alt="" width={36} height={36} />
            <strong>灵可</strong>
            <span>Link Studio</span>
          </header>
          <section className="project-home-content">
            <h1>本地项目</h1>
            <div className="project-actions">
              <label htmlFor="project-name">新项目名称</label>
              <input
                id="project-name"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                maxLength={100}
                placeholder="未命名项目"
              />
              <button type="button" disabled={projectBusy} onClick={() => void createProject()}>
                新建项目
              </button>
              <button type="button" className="secondary-button" onClick={() => void openProject()}>
                打开项目
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setShowSettings(true)}
              >
                模型设置
              </button>
            </div>
            {projectError && (
              <p className="error" role="alert">
                {projectError}
              </p>
            )}
            <section className="recent-projects">
              <h2>最近打开</h2>
              {recentProjects.length === 0 ? (
                <p className="muted">尚无最近项目</p>
              ) : (
                recentProjects.map((project) => (
                  <div className="recent-project" key={project.recentEntryId}>
                    <button
                      type="button"
                      onClick={() => void openRecentProject(project.recentEntryId)}
                    >
                      <strong>{project.displayName}</strong>
                      <span>{project.displayPath}</span>
                    </button>
                    <button
                      type="button"
                      className="recent-remove"
                      aria-label={`移除${project.displayName}最近记录`}
                      onClick={async () => {
                        await window.desktop.projects.removeRecent({
                          recentEntryId: project.recentEntryId,
                        });
                        await refreshRecent();
                      }}
                    >
                      移除
                    </button>
                  </div>
                ))
              )}
            </section>
          </section>
        </main>
      </>
    );
  }
  const busy = importing || writing || saving || dragging;
  const selected = nodes.filter((node) => node.selected);
  const inspected = selected.length === 1 ? selected[0] : undefined;
  const visualNode =
    inspected?.type === "creative" && isVisualMedia(inspected.data.kind) ? inspected : undefined;
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
  const extractVideoFrame = async (timeMs: number) => {
    if (!frameTarget || busy) return;
    const { asset, nodeId } = frameTarget;
    const source = nodeId ? nodes.find((node) => node.id === nodeId) : undefined;
    const position = source && absoluteNodeRect(source);
    if (
      nodeId &&
      (!position ||
        source?.type !== "creative" ||
        source.data.assetId !== asset.assetId ||
        splitCapacity < 1)
    ) {
      setFrameError("源节点已变更或画布没有空位。");
      return;
    }
    const { projectHandle } = projectSession;
    setWriting(true);
    setFrameError("");
    try {
      const result = await window.desktop.projects.inspectAsset({
        projectHandle,
        assetId: asset.assetId,
        timeMs,
      });
      if (!result.ok) {
        setFrameError(
          assetErrors[result.error.code] ?? "无法提取此位置的视频帧，请尝试前移播放位置。",
        );
        return;
      }
      updateRevision(projectHandle, result.value.revision);
      const latest = await window.desktop.projects.listAssets({ projectHandle });
      const frame = latest.ok
        ? latest.value.assets.find(({ assetId }) => assetId === result.value.assetId)
        : undefined;
      if (!latest.ok || !frame) {
        setFrameError("截帧已保存，暂时无法刷新素材库，请重试。");
        return;
      }
      setAssets(latest.value.assets);
      if (nodeId && position) {
        const id = crypto.randomUUID();
        setMergeKey(null);
        setNodes((current) => [
          ...current,
          {
            id,
            type: "creative",
            position: { x: Math.min(1e7, position.x + position.width + 64), y: position.y },
            data: { kind: "image", label: frame.displayName, text: "", assetId: frame.assetId },
          },
        ]);
        setEdges((current) => [
          ...current,
          { id: crypto.randomUUID(), source: nodeId, target: id },
        ]);
      } else {
        await openPreview(frame);
      }
      setFrameTarget(undefined);
    } catch {
      setFrameError("提取视频帧未完成，请重试。");
    } finally {
      setWriting(false);
    }
  };
  const openSplit = async (nodeId: string, asset: ProjectAsset) => {
    const result = await window.desktop.projects.getAssetPreview({
      projectHandle: projectSession.projectHandle,
      assetId: asset.assetId,
    });
    if (!result.ok) {
      setProjectError(assetErrors[result.error.code] ?? "无法打开拆图预览");
      return;
    }
    setSplitError("");
    setSplitTarget({ nodeId, asset, url: result.value.url });
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
      setMergeKey(null);
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
  const saveDoodle = async (pngData: string) => {
    if (!doodleTarget || doodleBusy || !projectSession) return;
    const source = nodes.find((node) => node.id === doodleTarget.nodeId);
    const rect = source && absoluteNodeRect(source);
    if (
      !rect ||
      source?.type !== "creative" ||
      source.data.assetId !== doodleTarget.asset.assetId ||
      nodes.length >= 1000 ||
      edges.length >= 4000
    ) {
      setDoodleError("源图片或画布状态已变化，请关闭后重新打开标注。");
      return;
    }
    setDoodleBusy(true);
    setWriting(true);
    setDoodleError("");
    try {
      const saved = await saveCanvas(projectSession);
      if (!saved) {
        setDoodleError("画布保存失败，请处理保存错误后重试。");
        return;
      }
      const operationId = crypto.randomUUID();
      setMediaOperationId(operationId);
      const result = await window.desktop.projects.annotateAsset({
        projectHandle: saved.projectHandle,
        operationId,
        expectedRevision: saved.revision,
        assetId: doodleTarget.asset.assetId,
        pngData,
      });
      if (!result.ok) {
        setDoodleError(assetErrors[result.error.code] ?? "图片标注保存失败，请重试。");
        return;
      }
      updateRevision(saved.projectHandle, result.value.revision);
      const latest = await window.desktop.projects.listAssets({
        projectHandle: saved.projectHandle,
      });
      const derived = latest.ok
        ? latest.value.assets.find(({ assetId }) => assetId === result.value.asset.assetId)
        : undefined;
      if (!latest.ok || !derived) {
        setDoodleError("标注已保存，但暂时无法刷新素材库，请重新打开项目。");
        return;
      }
      setAssets(latest.value.assets);
      const id = crypto.randomUUID();
      setMergeKey(null);
      setNodes((current) => [
        ...current.map((node) => ({ ...node, selected: node.id === id })),
        {
          id,
          type: "creative",
          position: { x: Math.min(1e7, rect.x + rect.width + 64), y: rect.y },
          selected: true,
          data: { kind: "image", label: derived.displayName, text: "", assetId: derived.assetId },
        },
      ]);
      setEdges((current) => [
        ...current,
        { id: crypto.randomUUID(), source: doodleTarget.nodeId, target: id },
      ]);
      setDoodleTarget(undefined);
    } catch {
      setDoodleError("图片标注保存未完成，请重试。");
    } finally {
      setMediaOperationId(undefined);
      setDoodleBusy(false);
      setWriting(false);
    }
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
      const stepX = 320;
      const stepY = 260;
      const batchWidth = columns * stepX;
      const batchHeight = rows * stepY;
      const x = Math.min(rect.x + rect.width + 64, 1e7 - batchWidth);
      const blockingBottom = nodes.reduce((bottom, node) => {
        const box = absoluteNodeRect(node) ?? {
          ...node.position,
          width: node.width ?? 280,
          height: node.height ?? 200,
        };
        if (box.x >= x + batchWidth || box.x + box.width <= x || box.y + box.height <= rect.y)
          return bottom;
        return Math.max(bottom, box.y + box.height + 40);
      }, rect.y);
      const y = blockingBottom + batchHeight <= 1e7 ? blockingBottom : -1e7;
      const tiles: CreativeNode[] = result.value.assets.map((tile, index) => ({
        id: crypto.randomUUID(),
        type: "creative",
        position: { x: x + (index % columns) * stepX, y: y + Math.floor(index / columns) * stepY },
        data: { kind: "image", label: tile.displayName, text: "", assetId: tile.assetId },
      }));
      setMergeKey(null);
      setNodes((current) => [...current, ...tiles]);
      setEdges((current) => [
        ...current,
        ...tiles.map(({ id: target }) => ({ id: crypto.randomUUID(), source: nodeId, target })),
      ]);
      setAssets((current) => [...current, ...result.value.assets]);
      updateRevision(saved.projectHandle, result.value.revision);
      setSplitTarget(undefined);
    } catch {
      setSplitError("拆图未完成，请重试。");
    } finally {
      setMediaOperationId(undefined);
      setMediaCancelling(false);
      setWriting(false);
    }
  };
  const groupable = selected.filter((node) => node.type === "creative" && !node.parentId);
  const editableSelection = selected.filter((node) => node.type === "creative");
  const fragment = captureSelection(canvas, new Set(selected.map(({ id }) => id)));
  const selectionBusy = writing || importing || dragging || !persistence.loaded;
  const insertClones = (source: CanvasFragment | undefined, position?: Point) => {
    if (!source || selectionBusy || nodes.length + source.nodes.length > 1000) return;
    const copies = cloneSelection(source, canvas, () => crypto.randomUUID(), position);
    if (edges.length + copies.edges.length > 4000) return;
    setMergeKey(null);
    setAddMenu(undefined);
    setGenerationNodeId(undefined);
    setNodes((current) =>
      flowOrder([
        ...current.map((node) => (node.selected ? { ...node, selected: false } : node)),
        ...copies.nodes.map((node) =>
          node.type === "group"
            ? { ...node, selected: true, deletable: false, connectable: false }
            : { ...node, selected: !node.parentId },
        ),
      ]),
    );
    setEdges((current) => [
      ...current.map((edge) => (edge.selected ? { ...edge, selected: false } : edge)),
      ...copies.edges,
    ]);
  };
  const duplicateNodes = () => insertClones(fragment);
  const arrangeNodes = (mode: ArrangeMode) => {
    if (selectionBusy) return;
    const parents = new Map(
      nodes.filter((node) => node.type === "group").map(({ id, position }) => [id, position]),
    );
    const positions = arrangeSelection(editableSelection, parents, mode);
    if (!positions.size) return;
    setMergeKey(null);
    setNodes((current) =>
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
  const editNode = (id: string, merge: boolean, update: (node: FlowNode) => FlowNode) => {
    setMergeKey(merge ? `${id}/label` : null);
    setNodes((current) => current.map((node) => (node.id === id ? update(node) : node)));
  };
  const bindAsset = (target: VisualMediaTarget, asset: ProjectAsset) => {
    if (asset.mediaType !== target.kind || asset.availability !== "ready") return;
    editNode(target.nodeId, false, (node) =>
      node.type === "creative" && node.data.kind === target.kind
        ? { ...node, data: withPrimaryAsset(node.data, asset.assetId) }
        : node,
    );
    setAssetTarget(undefined);
    setSidePanel(null);
  };
  const fanOutSelection = () => {
    if (
      selectionBusy ||
      editableSelection.length < 2 ||
      editableSelection.length !== selected.length ||
      nodes.length >= 1000 ||
      edges.length + editableSelection.length > 4000
    )
      return;
    const groups = new Map(
      nodes.filter((node) => node.type === "group").map(({ id, position }) => [id, position]),
    );
    const position = fanOutTargetPosition(editableSelection, groups);
    if (!position) return;
    const id = crypto.randomUUID();
    const target = {
      id,
      type: "creative" as const,
      position,
      selected: true,
      data: { kind: "image" as const, label: "引用生成", text: "" },
    };
    setMergeKey(null);
    setGenerationNodeId(id);
    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: node.id === id })),
      target,
    ]);
    setEdges((current) => [
      ...current,
      ...editableSelection.map(({ id: source }) => ({
        id: crypto.randomUUID(),
        source,
        target: id,
      })),
    ]);
    setProjectError("");
  };
  const groupNodes = () => {
    if (
      selectionBusy ||
      groupable.length !== selected.length ||
      groupable.length < 2 ||
      nodes.length >= 1000
    )
      return;
    const id = crypto.randomUUID();
    const x = Math.min(...groupable.map((node) => node.position.x)) - 24;
    const y = Math.min(...groupable.map((node) => node.position.y)) - 44;
    const width = Math.ceil(
      Math.max(...groupable.map((node) => node.position.x + (node.measured?.width ?? 280))) -
        x +
        24,
    );
    const height = Math.ceil(
      Math.max(...groupable.map((node) => node.position.y + (node.measured?.height ?? 200))) -
        y +
        24,
    );
    const children = new Set(groupable.map((node) => node.id));
    setMergeKey(null);
    setNodes((current) =>
      flowOrder([
        {
          id,
          type: "group",
          position: { x, y },
          width,
          height,
          data: { label: "新分组" },
          selected: true,
          connectable: false,
          deletable: false,
        },
        ...current.map((node) =>
          children.has(node.id)
            ? {
                ...node,
                parentId: id,
                selected: false,
                position: { x: node.position.x - x, y: node.position.y - y },
              }
            : { ...node, selected: false },
        ),
      ]),
    );
  };
  const ungroup = () => {
    if (!canUngroup || selectionBusy) return;
    setMergeKey(null);
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
  const centerPoint = () => {
    const bounds = canvasArea.current?.getBoundingClientRect();
    return bounds
      ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
      : { x: 250, y: 240 };
  };
  const defaultPlacement = () => {
    const center = centerPoint();
    const point = flowInstance.current?.screenToFlowPosition(center) ?? center;
    const offset = (nodes.length % 7) * 30;
    return { x: point.x - 146 + offset, y: point.y - 125 + offset };
  };
  const openAddMenu = (point: Point, trigger: HTMLElement | null) => {
    const bounds = canvasArea.current?.getBoundingClientRect();
    const flow = flowInstance.current;
    if (!bounds || !flow || !persistence.loaded || writing) return;
    menuTrigger.current = trigger;
    setAddMenu({
      position: flow.screenToFlowPosition(point),
      anchor: {
        x: Math.max(10, Math.min(point.x - bounds.left, bounds.width - 224)),
        y: Math.max(10, Math.min(point.y - bounds.top, bounds.height - 427)),
      },
    });
  };
  const addNode = (
    kind: NodeKind | "character" | "storyboard" | "director",
    position = defaultPlacement(),
  ) => {
    if (!persistence.loaded || writing || nodes.length >= 1000) return;
    const id = crypto.randomUUID();
    setMergeKey(null);
    setNodes((current) => [
      ...current.map((node) => (node.selected ? { ...node, selected: false } : node)),
      {
        id,
        type: "creative",
        position,
        selected: true,
        data:
          kind === "character"
            ? {
                kind: "image",
                label: `${defaultCharacter.name} · ${defaultCharacter.look}`,
                text: "",
                character: defaultCharacter,
              }
            : kind === "storyboard"
              ? { kind: "script", label: "新的分镜表", text: "", storyboard: [] }
              : kind === "director"
                ? { kind: "script", label: "新的导演台", text: "", director: emptyDirector }
                : { kind, label: `新的${NODE_LABELS[kind]}节点`, text: "" },
      },
    ]);
    if (kind === "character") setCharacterNodeId(id);
    if (kind === "storyboard") setStoryboardNodeId(id);
    if (kind === "director") setDirectorNodeId(id);
  };

  const linkedShotNodes = (sourceId: string, kind: "image" | "video") => {
    const children = new Set(
      edges
        .filter((edge) => edge.source === sourceId && !edge.data?.readOnly)
        .map(({ target }) => target),
    );
    return nodes.filter(
      (node): node is CreativeNode =>
        node.type === "creative" &&
        children.has(node.id) &&
        node.data.kind === kind &&
        !!node.data.shotId,
    );
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
          !node.data.director &&
          !!node.data.text.trim(),
      )
      .map((node) => node.data.text.trim());
    const own = storyboardNode?.data.text.trim() ?? "";
    return [...(own ? [own] : []), ...parts].join("\n\n");
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
      return result.ok ? "拆镜任务已提交，完成后会自动写回分镜表。" : result.error.code;
    } finally {
      setWriting(false);
    }
  };

  const pendingShots = (sourceId: string, shots: CanvasShot[], kind: "image" | "video") => {
    const existing = new Set(linkedShotNodes(sourceId, kind).map(({ data }) => data.shotId));
    return shots.filter((shot) => !existing.has(shot.id) && shot.scene.trim());
  };

  const saveStoryboard = (source: CreativeNode, shots: CanvasShot[], kind?: "image" | "video") => {
    if (writing) return;
    const fresh = kind ? pendingShots(source.id, shots, kind) : [];
    const rect = absoluteNodeRect(source);
    if (kind && (!rect || fresh.length === 0 || fresh.length > splitCapacity)) return;
    const additions: CreativeNode[] =
      kind && rect
        ? fresh.map((shot) => {
            const index = shots.findIndex(({ id }) => id === shot.id);
            const text = [
              shot.scene.trim(),
              shot.shot && `景别：${shot.shot}`,
              shot.camera && `运镜：${shot.camera}`,
              shot.action && `动作：${shot.action}`,
              shot.dialogue && `对白：${shot.dialogue}`,
              kind === "video" && `时长：${shot.duration} 秒`,
            ]
              .filter(Boolean)
              .join("\n");
            return {
              id: crypto.randomUUID(),
              type: "creative",
              position: {
                x: Math.min(1e7, rect.x + rect.width + 64 + (kind === "video" ? 340 : 0)),
                y: Math.min(1e7, rect.y + index * 270),
              },
              data: {
                kind,
                label: `镜头 ${index + 1} · ${NODE_LABELS[kind]}`,
                text,
                shotId: shot.id,
              },
            };
          })
        : [];
    editNode(source.id, false, (node) =>
      node.type === "creative" ? { ...node, data: { ...node.data, storyboard: shots } } : node,
    );
    if (additions.length) {
      setNodes((current) => [...current, ...additions]);
      setEdges((current) => [
        ...current,
        ...additions.map(({ id }) => ({ id: crypto.randomUUID(), source: source.id, target: id })),
      ]);
    }
    setStoryboardNodeId(undefined);
  };

  const submitNodeJobs = async (
    targets: (Pick<
      GenerationInput,
      "nodeId" | "prompt" | "purpose" | "afterImageJobId" | "duration"
    > & {
      provider: ProviderView;
      id?: string;
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
            referenceAssetIds: [],
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
      data: { kind: asset.mediaType, label: asset.displayName, text: "", assetId: asset.assetId },
    };
    setMergeKey(null);
    setNodes((current) =>
      current.length >= 1000
        ? current
        : [...current.map((item) => (item.selected ? { ...item, selected: false } : item)), node],
    );
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
    if (!projectSession || writing || !(await saveCanvas(projectSession))) return;
    const payload = serializeCanvasExchange(canvas, projectSession.name);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    link.download = `${projectSession.name.replace(/[\\/:*?"<>|]/g, "-") || "画布"}.link-canvas.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    setProjectError("");
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
          const parsed = parseCanvasExchange(JSON.parse(await file.text()));
          const prepared = prepareCanvasExchange(
            parsed,
            new Set(assets.map(({ assetId }) => assetId)),
          );
          if (prepared.document.nodes.length + nodes.length > 1000)
            throw new Error("导入后节点数量超过 1000 个上限");
          if (prepared.document.edges.length + edges.length > 4000)
            throw new Error("导入后连线数量超过 4000 条上限");
          restoreCanvas(mergeCanvasExchange(canvas, prepared.document, () => crypto.randomUUID()));
          if (prepared.report.missingAssetIds.length)
            setProjectError(
              `已合并画布，但 ${prepared.report.missingAssetIds.length} 个素材引用无法在当前项目中定位。`,
            );
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
  const downloadOutput = async (output: CreativeOutput) => {
    const asset = outputAsset(output);
    if (!asset || !projectSession) return;
    const result = await window.desktop.projects.getAssetPreview({
      projectHandle: projectSession.projectHandle,
      assetId: asset.assetId,
    });
    if (!result.ok) return;
    const link = document.createElement("a");
    link.href = result.value.url;
    link.download = asset.displayName;
    link.click();
  };

  const generationNode = canvas.nodes.find(
    (node): node is Extract<typeof node, { type: "creative" }> =>
      node.id === generationNodeId && node.type === "creative",
  );
  const inlineGeneration =
    !!generationNode && generationNode.id === inspected?.id && sidePanel !== "jobs";
  const submitGeneration = async (
    input: Omit<GenerationInput, "expectedCanvasRevision">,
    operationId: string,
  ) => {
    setWriting(true);
    try {
      const session = await saveCanvas(projectSession);
      if (!session) return "请先保存画布";
      const current = await window.desktop.projects.getCanvas({
        projectHandle: session.projectHandle,
      });
      if (!current.ok) return current.error.code;
      const result = await window.desktop.projects.submitJob({
        projectHandle: session.projectHandle,
        confirmed: true,
        operationId,
        generation: { ...input, expectedCanvasRevision: current.value.canvasRevision },
      });
      if (!result.ok) return result.error.code;
      setGenerationNodeId(undefined);
      setSidePanel("jobs");
    } finally {
      setWriting(false);
    }
  };
  const generationForm = generationNode && !isVisualMedia(generationNode.data.kind) && (
    <GenerationForm
      key={generationNode.id}
      inline={inlineGeneration}
      node={generationNode}
      settings={generationProviders}
      assets={assets}
      close={() => setGenerationNodeId(undefined)}
      submit={submitGeneration}
    />
  );
  const togglePanel = (panel: NonNullable<typeof sidePanel>) => {
    setAddMenu(undefined);
    setAssetPlacement(undefined);
    setAssetTarget(undefined);
    setSidePanel(sidePanel === panel ? null : panel);
  };
  const revealGeneration = (id: string, visual = false) => {
    setGenerationNodeId(id);
    if (sidePanel === "jobs") setSidePanel(null);
    const bounds = canvasArea.current?.getBoundingClientRect();
    const flow = flowInstance.current;
    if (!flow || !bounds) return;
    const node = flow.getNodesBounds([id]);
    const zoom = flow.getZoom();
    const corner = flow.flowToScreenPosition({ x: node.x, y: node.y + node.height });
    const halfWidth = visual ? Math.min(310, (bounds.width - 96) / 2) + 12 : 190;
    const center = Math.max(
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
    if (isVisualMedia(node.data.kind)) {
      setNodes((current) => current.map((item) => ({ ...item, selected: item.id === id })));
      revealGeneration(id, true);
    } else setGenerationNodeId(id);
  };

  return (
    <>
      {settingsPage}
      {!inlineGeneration && generationForm}
      <div className="canvas-workspace" hidden={showSettings} data-panel={sidePanel ?? "closed"}>
        <main className="canvas-area" ref={canvasArea} aria-label="创作画布">
          {!showSettings && (
            <CanvasShortcuts
              key={projectHandle}
              surface={canvasArea}
              capture={() => (selectionBusy ? undefined : fragment)}
              paste={(source, point) => {
                if (selectionBusy) return;
                const position = point
                  ? flowInstance.current?.screenToFlowPosition(point)
                  : undefined;
                if (typeof source !== "string") insertClones(source, position);
                else if (nodes.length < 1000) {
                  setMergeKey(null);
                  setAddMenu(undefined);
                  setGenerationNodeId(undefined);
                  setNodes((current) => [
                    ...current.map((node) => (node.selected ? { ...node, selected: false } : node)),
                    {
                      id: crypto.randomUUID(),
                      type: "creative",
                      position: position ?? defaultPlacement(),
                      selected: true,
                      data: {
                        kind: "script",
                        label: "粘贴文本",
                        text: source.slice(0, 32768).replace(/[\uD800-\uDBFF]$/, ""),
                      },
                    },
                  ]);
                }
              }}
              duplicate={duplicateNodes}
              group={groupNodes}
              ungroup={ungroup}
              history={(direction) => {
                if (!selectionBusy) history.restore(direction);
              }}
              save={() => {
                if (!selectionBusy) void saveCanvas(projectSession);
              }}
            />
          )}
          <header className="canvas-project-bar">
            <div className="brand">
              <img src={brandIcon} alt="灵可" width={26} height={26} />
            </div>
            <h1 title={projectSession.name}>{projectSession.name}</h1>
            <div className="project-session-actions">
              <button
                type="button"
                aria-label="保存项目"
                title="保存项目"
                disabled={busy || !persistence.loaded}
                onClick={async () => {
                  setWriting(true);
                  setProjectError("");
                  try {
                    await saveCanvas(projectSession);
                  } finally {
                    setWriting(false);
                  }
                }}
              >
                保存
              </button>
              <details className="canvas-more">
                <summary aria-label="项目更多操作" title="项目更多操作">
                  <Ellipsis size={18} />
                </summary>
                <div className="canvas-surface project-menu">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      setDraftName(projectSession.name);
                      setRenaming(true);
                    }}
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      setShowSettings(true);
                    }}
                  >
                    <Settings2 size={16} /> 模型设置
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      togglePanel("runtime");
                    }}
                  >
                    <Cpu size={16} /> 运行环境
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async (event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      setWriting(true);
                      try {
                        if (!(await saveCanvas(projectSession))) return;
                        const result = await window.desktop.projects.close({
                          projectHandle: projectSession.projectHandle,
                        });
                        if (result.ok) {
                          persistence.load(null);
                          setProjectSession(null);
                          await refreshRecent();
                        } else setProjectError(result.error.messageKey);
                      } finally {
                        setWriting(false);
                      }
                    }}
                  >
                    关闭项目
                  </button>
                </div>
              </details>
            </div>
          </header>
          {renaming && (
            <form
              className="canvas-surface project-rename"
              onSubmit={async (event) => {
                event.preventDefault();
                const name = draftName.trim();
                if (!name || busy) return;
                setWriting(true);
                setProjectError("");
                try {
                  const result = await window.desktop.projects.rename({
                    projectHandle: projectSession.projectHandle,
                    operationId: crypto.randomUUID(),
                    expectedRevision: projectSession.revision,
                    name,
                  });
                  if (result.ok) {
                    setProjectSession((current) =>
                      current?.projectHandle === projectSession.projectHandle
                        ? {
                            ...current,
                            name: result.value.name,
                            revision: Math.max(current.revision, result.value.revision),
                          }
                        : current,
                    );
                    setRenaming(false);
                  } else setProjectError(result.error.messageKey);
                } finally {
                  setWriting(false);
                }
              }}
            >
              <label>
                项目名称
                <input
                  required
                  maxLength={120}
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                />
              </label>
              <div>
                <button type="button" disabled={busy} onClick={() => setRenaming(false)}>
                  取消
                </button>
                <button type="submit" disabled={busy || !draftName.trim()}>
                  确认重命名
                </button>
              </div>
            </form>
          )}
          <div className="canvas-surface canvas-tools" role="toolbar" aria-label="画布编辑">
            <button
              ref={addButton}
              type="button"
              aria-label="添加节点"
              aria-expanded={!!addMenu}
              title="添加节点"
              disabled={!persistence.loaded || writing}
              onClick={(event) => {
                if (addMenu) return setAddMenu(undefined);
                const rect = event.currentTarget.getBoundingClientRect();
                openAddMenu({ x: rect.right + 12, y: rect.top }, event.currentTarget);
                setAddMenu((menu) => menu && { ...menu, position: defaultPlacement() });
              }}
            >
              <Plus size={20} />
            </button>
            <button
              type="button"
              aria-label="选择"
              aria-pressed={!hand}
              title="选择"
              onClick={() => setHand(false)}
            >
              <MousePointer2 size={18} />
            </button>
            <button
              type="button"
              aria-label="抓手"
              aria-pressed={hand}
              title="抓手"
              onClick={() => setHand(true)}
            >
              <Hand size={18} />
            </button>
            <button
              type="button"
              aria-label="扫线断开"
              aria-pressed={sweepMode}
              title="扫过连线批量断开"
              disabled={!persistence.loaded || writing}
              onClick={() => {
                setSweepMode((current) => !current);
                setHand(false);
              }}
            >
              <Scissors size={18} />
            </button>
            <button
              type="button"
              aria-label="撤销"
              title="撤销"
              disabled={writing || !history.canUndo}
              onClick={() => history.restore("undo")}
            >
              <Undo2 size={18} />
            </button>
            <button
              type="button"
              aria-label="重做"
              title="重做"
              disabled={writing || !history.canRedo}
              onClick={() => history.restore("redo")}
            >
              <Redo2 size={18} />
            </button>
            <button
              type="button"
              title={`素材库 · ${assets.length} 项`}
              aria-label="素材库"
              aria-pressed={sidePanel === "assets"}
              onClick={() => togglePanel("assets")}
            >
              <FolderOpen size={18} />
            </button>
            <button
              type="button"
              aria-label="导入画布"
              title="合并导入画布"
              disabled={!persistence.loaded || writing}
              onClick={importCanvasExchange}
            >
              <FileUp size={18} />
            </button>
            <button
              type="button"
              aria-label="导出画布"
              title="导出当前画布"
              disabled={!persistence.loaded || writing}
              onClick={() => void exportCanvasExchange()}
            >
              <Download size={18} />
            </button>
            <button
              type="button"
              title="生成任务"
              aria-label="生成任务"
              aria-pressed={sidePanel === "jobs"}
              onClick={() => togglePanel("jobs")}
            >
              <ListChecks size={18} />
            </button>
            <button
              type="button"
              aria-label="导出成片"
              title="预览并导出成片"
              disabled={!persistence.loaded || writing}
              onClick={() => void openComposition()}
            >
              <ListVideo size={18} />
            </button>
          </div>
          <section
            className="asset-strip canvas-surface canvas-library"
            aria-label="项目素材"
            hidden={sidePanel !== "assets" && !importing}
          >
            <div className="asset-strip-heading">
              <strong>素材库</strong>
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
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void importMedia(
                    assetTarget ?? (assetPlacement ? { position: assetPlacement } : undefined),
                  )
                }
              >
                {importing ? "正在导入…" : "导入素材"}
              </button>
              <button
                type="button"
                disabled={importing}
                aria-label="关闭素材库"
                onClick={() => {
                  setAssetTarget(undefined);
                  setSidePanel(null);
                }}
              >
                <X size={16} />
              </button>
            </div>
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
                                addAssetNode(asset, assetPlacement);
                                if (assetPlacement) {
                                  setAssetPlacement(undefined);
                                  setSidePanel(null);
                                }
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
          <div className="flow-container" data-hand={hand}>
            <NodeMedia.Provider value={nodeMedia}>
              <VisualMediaActions.Provider
                value={{
                  busy,
                  upload: (target) => void importMedia(target),
                  library: (target) => {
                    setAssetPlacement(undefined);
                    setAssetTarget(target);
                    setSidePanel("assets");
                  },
                  preview: (asset) => void openPreview(asset),
                }}
              >
                <CanvasTextEdit.Provider value={setMergeKey}>
                  <ReactFlow<FlowNode, CanvasFlowEdge>
                    key={`${projectSession.projectHandle}:${canvasMount}`}
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    edgeTypes={edgeTypes}
                    onInit={(instance) => {
                      flowInstance.current = instance;
                    }}
                    onNodesChange={onNodesChange}
                    onNodeDragStart={onNodeDragStart}
                    onNodeDragStop={onNodeDragStop}
                    onEdgesChange={onCanvasEdgesChange}
                    onConnect={onConnect}
                    onPaneClick={() => {
                      if (writing) return;
                      setAddMenu(undefined);
                      setGenerationNodeId(undefined);
                    }}
                    onPaneContextMenu={(event) => {
                      event.preventDefault();
                      if (!hand)
                        openAddMenu({ x: event.clientX, y: event.clientY }, addButton.current);
                    }}
                    onNodeClick={(event, node) => {
                      if (writing || hand || event.shiftKey || event.metaKey || event.ctrlKey)
                        return;
                      if (node.type === "creative" && isVisualMedia(node.data.kind))
                        revealGeneration(node.id, true);
                      else if (generationNodeId !== node.id) setGenerationNodeId(undefined);
                    }}
                    onMoveStart={() => setAddMenu(undefined)}
                    onBeforeDelete={async () => {
                      setMergeKey(null);
                      return !writing && persistence.loaded;
                    }}
                    isValidConnection={({ source, target }) =>
                      source !== target &&
                      nodes.find((node) => node.id === source)?.type === "creative" &&
                      nodes.find((node) => node.id === target)?.type === "creative"
                    }
                    nodesDraggable={!hand && !writing && persistence.loaded}
                    nodesConnectable={!hand && !writing && persistence.loaded}
                    elementsSelectable={!hand && !writing}
                    selectionOnDrag={!hand && !writing}
                    panOnDrag={hand ? true : [1]}
                    panOnScroll
                    zoomOnDoubleClick={false}
                    paneClickDistance={3}
                    multiSelectionKeyCode={["Shift", "Meta", "Control"]}
                    defaultViewport={viewport}
                    onMoveEnd={(_event, next) => setViewport(next)}
                    minZoom={0.2}
                    maxZoom={2}
                    colorMode="light"
                    deleteKeyCode={["Backspace", "Delete"]}
                  >
                    {sweepPoints.length > 1 && (
                      <svg className="canvas-sweep-overlay" aria-hidden="true">
                        <polyline points={sweepPoints.map(({ x, y }) => `${x},${y}`).join(" ")} />
                      </svg>
                    )}
                    <Background gap={22} size={1.35} color="#c5cddd" />
                    <ViewportPortal>
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
                              : { left: guide.from, top: guide.value, width: guide.to - guide.from }
                          }
                        />
                      ))}
                    </ViewportPortal>
                    {showMap && (
                      <MiniMap
                        pannable
                        zoomable
                        nodeColor="#a5b1ee"
                        maskColor="#dce1ee88"
                        className="workspace-map"
                        position="bottom-left"
                        ariaLabel="画布小地图"
                      />
                    )}
                    {inspected && (
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
                          {inspected.type === "creative" && inspected.data.character && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setCharacterNodeId(inspected.id)}
                            >
                              <UserRound size={15} /> 编辑角色
                            </button>
                          )}
                          {inspected.type === "creative" && inspected.data.storyboard && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setStoryboardNodeId(inspected.id)}
                            >
                              <ListVideo size={15} /> 编辑分镜
                            </button>
                          )}
                          {inspected.type === "creative" && inspected.data.director && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setDirectorNodeId(inspected.id)}
                            >
                              <Clapperboard size={15} /> 编辑导演台
                            </button>
                          )}
                          {inspected.type === "creative" &&
                            !visualNode &&
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
                            (!visualNode || inspectedAsset) && (
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
                          {inspectedAsset && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void openPreview(inspectedAsset)}
                            >
                              预览素材
                            </button>
                          )}
                          {inspectedAsset?.mediaType === "image" && (
                            <button
                              type="button"
                              disabled={busy || splitCapacity < 2}
                              onClick={() => void openSplit(inspected.id, inspectedAsset)}
                            >
                              <Grid2X2 size={15} /> 宫格拆图
                            </button>
                          )}
                          {inspectedAsset?.mediaType === "image" && (
                            <button
                              type="button"
                              disabled={busy || splitCapacity < 1}
                              onClick={() => void openDoodle(inspected.id, inspectedAsset)}
                            >
                              <PenLine size={15} /> 涂鸦标注
                            </button>
                          )}
                          {inspectedAsset?.mediaType === "image" && (
                            <button
                              type="button"
                              disabled={busy || splitCapacity < 1}
                              onClick={() => void openOutpaint(inspected.id, inspectedAsset)}
                            >
                              <Expand size={15} /> 扩图
                            </button>
                          )}
                          {inspectedAsset?.mediaType === "video" && (
                            <button
                              type="button"
                              disabled={busy || splitCapacity < 1}
                              onClick={() => void openFrame(inspectedAsset, inspected.id)}
                            >
                              提取帧
                            </button>
                          )}
                          {inspectedAsset?.mediaType === "video" && (
                            <button
                              type="button"
                              disabled={busy || splitCapacity < 1}
                              onClick={() => void openTrim(inspectedAsset, inspected.id)}
                            >
                              裁切视频
                            </button>
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
                          {canUngroup && (
                            <button type="button" disabled={writing} onClick={ungroup}>
                              解除分组
                            </button>
                          )}
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
                    {visualNode && inlineGeneration && (
                      <NodeToolbar
                        nodeId={visualNode.id}
                        position={Position.Bottom}
                        offset={12}
                        isVisible
                        hidden={hand || dragging}
                      >
                        <GenerationForm
                          key={visualNode.id}
                          inline
                          node={visualNode}
                          settings={generationProviders}
                          assets={assets}
                          linkedSources={linkedMediaSources(canvas, visualNode.id)}
                          onUnlinkReference={(assetId) => {
                            const sources = new Set(
                              canvas.nodes.flatMap((node) =>
                                node.type === "creative" &&
                                (node.data.assetId === assetId ||
                                  node.data.character?.extraAssetIds.includes(assetId) ||
                                  node.data.character?.voice?.assetId === assetId)
                                  ? [node.id]
                                  : [],
                              ),
                            );
                            setMergeKey(null);
                            setEdges((current) =>
                              current.filter(
                                (edge) =>
                                  edge.data?.readOnly ||
                                  edge.target !== visualNode.id ||
                                  !sources.has(edge.source),
                              ),
                            );
                          }}
                          blocked={
                            writing ||
                            importing ||
                            jobs.some(
                              (job) => job.nodeId === visualNode.id && !jobIsTerminal(job.status),
                            )
                          }
                          onPromptChange={(text) => {
                            setMergeKey(`${visualNode.id}/text`);
                            flowInstance.current?.updateNodeData(visualNode.id, {
                              text,
                              activeOutputId: undefined,
                            });
                          }}
                          openSettings={() => setShowSettings(true)}
                          close={() => undefined}
                          submit={submitGeneration}
                        />
                      </NodeToolbar>
                    )}
                    {editableSelection.length >= 2 &&
                      editableSelection.length === selected.length &&
                      !hand && (
                        <NodeToolbar
                          nodeId={editableSelection.map(({ id }) => id)}
                          position={Position.Top}
                          isVisible={!dragging}
                        >
                          <div
                            className="canvas-surface node-tools"
                            role="toolbar"
                            aria-label="多选节点操作"
                          >
                            <button
                              type="button"
                              aria-label="横向排列"
                              title="横向排列"
                              disabled={selectionBusy}
                              onClick={() => arrangeNodes("row")}
                            >
                              <Columns3 size={16} />
                            </button>
                            <button
                              type="button"
                              aria-label="纵向排列"
                              title="纵向排列"
                              disabled={selectionBusy}
                              onClick={() => arrangeNodes("column")}
                            >
                              <Rows3 size={16} />
                            </button>
                            <button
                              type="button"
                              aria-label="网格排列"
                              title="网格排列"
                              disabled={selectionBusy}
                              onClick={() => arrangeNodes("grid")}
                            >
                              <Grid2X2 size={16} />
                            </button>
                            <button
                              type="button"
                              aria-label="引用选中节点生成"
                              title="引用选中节点生成"
                              disabled={selectionBusy || nodes.length >= 1000}
                              onClick={fanOutSelection}
                            >
                              <Sparkles size={16} />
                            </button>
                            <button
                              type="button"
                              aria-label="复制所选节点"
                              title="复制所选节点与引用连线（⌘/Ctrl+D）"
                              disabled={selectionBusy || !fragment}
                              onClick={duplicateNodes}
                            >
                              <Copy size={16} />
                            </button>
                            <button
                              type="button"
                              disabled={
                                selectionBusy ||
                                groupable.length !== editableSelection.length ||
                                nodes.length >= 1000
                              }
                              onClick={groupNodes}
                            >
                              <Layers3 size={15} /> 分组
                            </button>
                          </div>
                        </NodeToolbar>
                      )}
                  </ReactFlow>
                </CanvasTextEdit.Provider>
              </VisualMediaActions.Provider>
            </NodeMedia.Provider>
          </div>
          {persistence.loaded && !nodes.length && (
            <section className="canvas-empty" aria-labelledby="canvas-empty-title">
              <div className="canvas-empty-mark">
                <Sparkles size={25} />
              </div>
              <h2 id="canvas-empty-title">从一个想法开始</h2>
              <p>选择一个起点，开始创作。</p>
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
                      <Icon size={21} />
                    </span>
                    <strong>{label}</strong>
                    <small>{detail}</small>
                  </button>
                ))}
              </div>
              <small>也可以右键点击画布空白处添加节点</small>
            </section>
          )}
          {addMenu && (
            <section
              ref={menuElement}
              className="canvas-surface canvas-add-menu"
              aria-label="添加节点菜单"
              style={{ left: addMenu.anchor.x, top: addMenu.anchor.y }}
            >
              <strong>添加节点</strong>
              {NODE_KINDS.map((kind) => {
                const Icon = NODE_ICONS[kind];
                return (
                  <button
                    type="button"
                    key={kind}
                    disabled={writing || nodes.length >= 1000}
                    onClick={() => {
                      addNode(kind, addMenu.position);
                      setAddMenu(undefined);
                      menuTrigger.current?.focus();
                    }}
                  >
                    <Icon size={17} /> {NODE_LABELS[kind]}
                  </button>
                );
              })}
              <button
                type="button"
                disabled={busy || nodes.length >= 1000}
                onClick={() => {
                  addNode("character", addMenu.position);
                  setAddMenu(undefined);
                }}
              >
                <UserRound size={17} /> 角色卡
              </button>
              <button
                type="button"
                disabled={busy || nodes.length >= 1000}
                onClick={() => {
                  addNode("storyboard", addMenu.position);
                  setAddMenu(undefined);
                }}
              >
                <ListVideo size={17} /> 分镜表
              </button>
              <button
                type="button"
                disabled={busy || nodes.length >= 1000}
                onClick={() => {
                  addNode("director", addMenu.position);
                  setAddMenu(undefined);
                }}
              >
                <Clapperboard size={17} /> 导演台
              </button>
              <button
                type="button"
                disabled={busy || nodes.length >= 1000}
                onClick={() => {
                  void importMedia({ position: addMenu.position });
                  setAddMenu(undefined);
                }}
              >
                <Upload size={17} /> 上传素材
              </button>
              <button
                type="button"
                onClick={() => {
                  setAssetPlacement(addMenu.position);
                  setAssetTarget(undefined);
                  setSidePanel("assets");
                  setAddMenu(undefined);
                }}
              >
                <FolderOpen size={17} /> 从素材库添加
              </button>
            </section>
          )}
          <div className="canvas-surface canvas-view" role="toolbar" aria-label="画布视图">
            <button
              type="button"
              aria-label="缩小"
              title="缩小"
              onClick={() => void flowInstance.current?.zoomOut({ duration: 120 })}
            >
              <Minus size={17} />
            </button>
            <output aria-label="当前缩放">{Math.round(viewport.zoom * 100)}%</output>
            <button
              type="button"
              aria-label="放大"
              title="放大"
              onClick={() => void flowInstance.current?.zoomIn({ duration: 120 })}
            >
              <Plus size={17} />
            </button>
            <button
              type="button"
              aria-label="适应视图"
              title="适应视图"
              onClick={() =>
                void (nodes.length
                  ? flowInstance.current?.fitView({ duration: 180, padding: 0.16, maxZoom: 1 })
                  : flowInstance.current?.setViewport(initialViewport))
              }
            >
              <ScanLine size={17} />
            </button>
            <button
              type="button"
              aria-label="小地图"
              title="小地图"
              aria-pressed={showMap}
              onClick={() => setShowMap(!showMap)}
            >
              <MapIcon size={17} />
            </button>
            <button
              type="button"
              aria-label="操作说明"
              title="操作说明"
              aria-expanded={showGuide}
              onClick={() => setShowGuide(!showGuide)}
            >
              <CircleHelp size={17} />
            </button>
          </div>
          <button
            type="button"
            className="canvas-launcher"
            aria-label={sidePanel === "assistant" ? "收起小灵" : "打开小灵"}
            aria-expanded={sidePanel === "assistant"}
            onClick={() => togglePanel("assistant")}
          >
            <Sparkles size={21} />
            <span>小灵</span>
          </button>
          {showGuide && (
            <section className="guide canvas-surface" aria-label="操作说明">
              <strong>画布操作</strong>
              <p>
                右键点击空白处添加节点。用抓手移动画布，或在选择模式下拖动空白处框选。
                拖动连接点连线，选中节点或连线后按 Delete 删除。
              </p>
              <p>⌘/Ctrl+C、V 复制粘贴，D 原地复制，G 分组，Shift+G 解组，S 保存。</p>
              <button type="button" onClick={() => setShowGuide(false)}>
                知道了
              </button>
            </section>
          )}
          {splitTarget && (
            <GridSplitDialog
              key={splitTarget.nodeId}
              asset={splitTarget.asset}
              url={splitTarget.url}
              busy={busy}
              error={splitError}
              capacity={splitCapacity}
              close={() => setSplitTarget(undefined)}
              cancel={mediaOperationId ? () => void cancelMediaTool() : undefined}
              cancelling={mediaCancelling}
              submit={(draft) => void splitImage(draft)}
            />
          )}
          {doodleTarget && (
            <ImageDoodleDialog
              assetName={doodleTarget.asset.displayName}
              url={doodleTarget.url}
              busy={doodleBusy}
              error={doodleError}
              onSave={(pngData) => void saveDoodle(pngData)}
              onClose={() => {
                if (!doodleBusy) setDoodleTarget(undefined);
              }}
            />
          )}
          {outpaintTarget && (
            <ImageOutpaintDialog
              assetName={outpaintTarget.asset.displayName}
              url={outpaintTarget.url}
              settings={generationProviders}
              busy={outpaintBusy}
              error={outpaintError}
              submit={(draft) => void submitOutpaint(draft)}
              close={() => setOutpaintTarget(undefined)}
            />
          )}
          {characterNode?.data.character && (
            <CharacterDialog
              key={characterNode.id}
              character={characterNode.data.character}
              assetId={characterNode.data.assetId}
              assets={assets}
              jobs={jobs.filter(
                ({ nodeId, purpose }) =>
                  nodeId === characterNode.id && (purpose === "character-voice" || !purpose),
              )}
              settings={generationProviders}
              preview={(asset) => void openPreview(asset)}
              generate={(image, voice) => {
                const id = image && crypto.randomUUID();
                return submitNodeJobs([
                  ...(image ? [{ ...image, id, nodeId: characterNode.id }] : []),
                  ...(voice
                    ? [
                        {
                          ...voice,
                          nodeId: characterNode.id,
                          purpose: "character-voice" as const,
                          ...((id ?? voice.afterImageJobId)
                            ? { afterImageJobId: id ?? voice.afterImageJobId }
                            : {}),
                        },
                      ]
                    : []),
                ]);
              }}
              close={() => setCharacterNodeId(undefined)}
              save={(character, assetId) => {
                editNode(characterNode.id, false, (node) =>
                  node.type === "creative"
                    ? {
                        ...node,
                        data: withPrimaryAsset(
                          {
                            ...node.data,
                            character,
                            label: `${character.name} · ${character.look}`,
                          },
                          assetId,
                          assetId === node.data.assetId ? node.data.activeOutputId : undefined,
                        ),
                      }
                    : node,
                );
                setCharacterNodeId(undefined);
              }}
            />
          )}
          {storyboardNode?.data.storyboard && (
            <StoryboardDialog
              key={storyboardNode.id}
              initial={storyboardNode.data.storyboard}
              linkedNodes={{
                image: linkedShotNodes(storyboardNode.id, "image"),
                video: linkedShotNodes(storyboardNode.id, "video"),
              }}
              jobs={jobs}
              settings={generationProviders}
              sourceText={upstreamScriptText(storyboardNode.id)}
              submitSplit={(prompt, provider, mode) =>
                submitStoryboardSplit(storyboardNode, prompt, provider, mode)
              }
              submit={(targets, provider) =>
                submitNodeJobs(targets.map((target) => ({ ...target, provider })))
              }
              canSplit={(shots, kind) => {
                const count = pendingShots(storyboardNode.id, shots, kind).length;
                return count > 0 && count <= splitCapacity;
              }}
              save={(shots, kind) => saveStoryboard(storyboardNode, shots, kind)}
              close={() => setStoryboardNodeId(undefined)}
            />
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
                projectHandle={projectSession.projectHandle}
                close={() => setDirectorNodeId(undefined)}
                save={(director) => {
                  editNode(directorNode.id, false, (node) =>
                    node.type === "creative" ? { ...node, data: { ...node.data, director } } : node,
                  );
                  setDirectorNodeId(undefined);
                }}
              />
            </Suspense>
          )}
          {frameTarget && (
            <VideoFrameDialog
              key={frameTarget.asset.assetId}
              asset={frameTarget.asset}
              url={frameTarget.url}
              linked={!!frameTarget.nodeId}
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
          {projectError && sidePanel !== "assets" && !importing && (
            <div className="canvas-surface canvas-error" role="alert">
              {projectError}
              <button type="button" aria-label="关闭提示" onClick={() => setProjectError("")}>
                <X size={15} />
              </button>
            </div>
          )}
          <div className="canvas-notice" data-recovery={!!saveError}>
            <ScanLine size={15} />
            <span role="status">
              {!persistence.loaded
                ? "画布未载入"
                : saving
                  ? "正在保存画布…"
                  : saveError === "CANVAS_REVISION_CONFLICT"
                    ? "画布保存冲突，本地更改已保留"
                    : saveError
                      ? "画布保存失败，本地更改已保留"
                      : dirty
                        ? "画布有未保存的更改"
                        : "画布已同步到项目"}
            </span>
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
                <button type="button" disabled={busy} onClick={() => void recoverCanvas(true)}>
                  重新载入画布
                </button>
                {recoveryError && <span role="alert">{recoveryError}</span>}
              </div>
            )}
          </div>
        </main>
        {preview && <AssetPreview {...preview} close={() => setPreview(null)} />}
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
        <aside className="side-panel canvas-dock" hidden={!sidePanel || sidePanel === "assets"}>
          <button
            className="close-canvas-dock"
            type="button"
            aria-label={sidePanel === "assistant" ? "关闭小灵" : "关闭侧栏"}
            onClick={() => setSidePanel(null)}
          >
            <X size={17} />
          </button>
          {sidePanel === "properties" && (
            <section className="node-properties" aria-label="节点属性" inert={writing}>
              <h2>节点属性</h2>
              {inspected && inspected.type !== "unknown" ? (
                <div className="node-fields">
                  <label>
                    名称
                    <input
                      maxLength={255}
                      value={inspected.data.label}
                      onChange={(event) => {
                        const label = event.target.value;
                        editNode(
                          inspected.id,
                          true,
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
                        jobs={jobs}
                        assets={assets}
                        outputs={inspected.type === "creative" ? inspected.data.outputs : []}
                        activeOutputId={
                          inspected.type === "creative" ? inspected.data.activeOutputId : undefined
                        }
                        onPreview={(asset) => void openPreview(asset)}
                        onBind={(assetId) => {
                          editNode(inspected.id, false, (node) =>
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
                          editNode(inspected.id, false, (node) =>
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
                              .map(downloadOutput),
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
                            editNode(inspected.id, false, (node) =>
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
          <CanvasAssistant
            key={projectSession.projectHandle}
            projectHandle={projectSession.projectHandle}
            providers={generationProviders.providers}
            plugins={generationProviders.plugins}
            selection={selected.map(({ id, data }) => ({ id, label: data.label }))}
            nodes={canvas.nodes}
            assets={assets}
            visible={sidePanel === "assistant" && !showSettings}
            openSettings={() => setShowSettings(true)}
            locateNode={(id) => {
              setNodes((current) => current.map((node) => ({ ...node, selected: node.id === id })));
              void flowInstance.current?.fitView({
                nodes: [{ id }],
                duration: 200,
                maxZoom: 1.25,
              });
            }}
            jobs={jobs}
            openJobs={() => setSidePanel("jobs")}
            beforeWrite={async () => !writing && !dragging && !!(await saveCanvas(projectSession))}
          />
        </aside>
      </div>
    </>
  );
}
