import type {
  DramaDocument,
  DramaImageParams,
  DramaSourcePreview,
  DramaStartRatio,
  PluginView,
  ProviderView,
  RecentProject,
} from "@link-studio/core";
import {
  canvasAgentMediaModels,
  defaultDramaStyle,
  dramaAgentModels,
  dramaAssetMeta,
  dramaAssetSlots,
  dramaImageFields,
  dramaVideoModelIssue,
  episodeScriptPhase,
  requirePresent,
  settleDramaImageParams,
} from "@link-studio/core";
import { ArrowUp, Clapperboard, FileText, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAssistantAction } from "../assistant/use-assistant-session";
import { keyedItems } from "../occurrence-keys";
import { settingsError } from "../settings/settings-page";
import { DramaStartModel } from "./drama-start-model";
import { DramaStartParams } from "./drama-start-params";
import { emptyStartImages, loadDramaStartPrefs, saveDramaStartPrefs } from "./drama-start-prefs";
import { PromptEditor, PromptRows, useStartPrompts } from "./drama-start-prompts";
import { DramaStartStyle, FieldMenu } from "./drama-start-style";
import "./drama-studio.css";
import { type DramaAssetEditor, DramaAssetViewToggle, StageAssets } from "./drama-asset-browser";
import { DramaAssistant } from "./drama-assistant";
import type { AutosaveStatus } from "./drama-autosave";
import { appendStudioClip, DramaClipRow } from "./drama-clip-row";
import { DramaContinueDialog } from "./drama-continue-dialog";
import { EpisodePaper } from "./drama-episode-paper";
import { type DramaPage, EpisodeRail } from "./drama-episode-rail";
import { DramaGenerateButton } from "./drama-generate-button";
import { DramaProjectSettings } from "./drama-project-settings";
import { DramaReadingRoom, DramaWorkspaceHeader, type PlanningAction } from "./drama-reading-room";
import { DramaFlushers, DramaSaveStatus } from "./drama-save-status";
import { DramaScriptNext, scriptNextStep } from "./drama-script-next";
import { DramaScriptsDialog } from "./drama-scripts-dialog";
import { DramaSegmentHeading } from "./drama-segment-heading";
import { editorAttempt } from "./drama-segment-status";
import { DramaSegmentVideo, useStudioAdaptations } from "./drama-segment-video";
import { StageOverview, stageHints, useStageCanvas } from "./drama-stage-areas";
import { DramaStageTabs } from "./drama-stage-tabs";
import { DramaStoryboardBatch } from "./drama-storyboard-batch";
import { StudioLibrary } from "./drama-studio-library";
import { StudioPanels } from "./drama-studio-panels";
import {
  DramaEmptyState,
  DramaNotice,
  DramaTaskStatusStack,
  DramaWorkspaceState,
} from "./drama-studio-status";
import "./drama-reading-room.css";
import { DramaFinalArea } from "./drama-final-area";
import { DramaScriptLayout } from "./drama-script-layout";
import { DramaStoryboardGate, studioVideoSelection } from "./drama-storyboard-gate";
import { DramaStudioGate, studioPrerequisite } from "./drama-studio-gate";
import { StudioSegmentSeconds } from "./drama-studio-seconds";
import { StudioVideoModel } from "./drama-studio-video-model";
import "./drama-production-pages.css";
import { type Stage, stages, useDramaNav } from "./drama-workspace-nav";

export function DramaStudio({
  projectTabs,
  activeRecentId,
  flushBeforeClose,
  navigateProject,
  projectHandle,
  projectId,
  withAssistant,
  toggleAssistant,
  providers,
  loadingModels,
  refreshModels,
  toggleTheme,
  plugins,
  assetEditor,
  returnLabel,
  close,
}: {
  projectTabs?: RecentProject[];
  activeRecentId?: string;
  flushBeforeClose: React.RefObject<(() => Promise<boolean>) | null>;
  navigateProject?: (entry: RecentProject, remove: boolean) => Promise<void>;
  projectHandle: string;
  projectId: string;
  withAssistant: boolean;
  toggleAssistant?: () => void;
  providers: ProviderView[];
  loadingModels: boolean;
  refreshModels?: () => void;
  toggleTheme?: () => void;
  plugins: PluginView[];
  assetEditor: DramaAssetEditor;
  returnLabel: string;
  close: () => void;
}) {
  const [doc, setDoc] = useState<DramaDocument | null>();
  const switching = useRef(false);
  async function visitTab(entry: RecentProject, remove: boolean) {
    if (switching.current || !navigateProject) return;
    switching.current = true;
    try {
      if ((!remove || entry.recentEntryId === activeRecentId) && !(await flushNavigation())) return;
      await navigateProject(entry, remove);
    } finally {
      switching.current = false;
    }
  }
  const acceptDocument = (next: DramaDocument) =>
    setDoc((current) => (current && current.revision > next.revision ? current : next));
  const [statuses, setStatuses] = useState<Record<string, AutosaveStatus>>({});
  const reportSave = useCallback(
    (id: string, status?: AutosaveStatus) =>
      setStatuses((previous) => {
        if (previous[id] === status) return previous;
        const next = { ...previous };
        if (status) next[id] = status;
        else delete next[id];
        return next;
      }),
    [],
  );
  const saveStates = Object.values(statuses);
  const saveLabel = saveStates.includes("conflict")
    ? "保存冲突"
    : saveStates.includes("error")
      ? "保存失败"
      : saveStates.includes("saving")
        ? "保存中"
        : saveStates.includes("dirty")
          ? "待保存"
          : "已保存";
  const flushPaper = useRef<(() => Promise<void>) | null>(null);
  const [writers] = useState(() => new Set<() => Promise<void>>());
  const nav = useDramaNav(doc, projectId),
    { stage } = nav,
    page = nav.paper ?? nav.ep,
    [notice, setNotice] = useState("");
  const canvas = useStageCanvas(projectHandle, doc, assetEditor.canvasRevision);
  const blankAssetPrompts = useMemo(
    () =>
      assetEditor.ready
        ? new Set(
            assetEditor.graph.nodes.flatMap((node) =>
              node.type === "creative" && dramaAssetMeta(node.data) && !node.data.text?.trim()
                ? [node.id]
                : [],
            ),
          )
        : undefined,
    [assetEditor.ready, assetEditor.graph.nodes],
  );
  const extractingEpisodes =
    doc?.jobs
      ?.filter(
        (job) => job.step === "breakdown" && (job.status === "queued" || job.status === "running"),
      )
      .flatMap((job) => job.episodes) ?? [];
  const activeEpisode =
    typeof page === "number" ? doc?.episodes.find((item) => item.episode_no === page) : undefined;
  const scriptJob =
    activeEpisode && doc?.jobs?.find((job) => episodeScriptPhase(job, activeEpisode.episode_no));
  const prerequisite = stage === "studio" && doc ? studioPrerequisite(doc, activeEpisode) : null;
  const storyboardGate =
    stage === "studio" &&
    activeEpisode &&
    (activeEpisode.storyboard_status === "generating" ||
      (activeEpisode.locked &&
        activeEpisode.storyboard_status !== "ready" &&
        !doc?.segments?.some((segment) => segment.episode_no === activeEpisode.episode_no)));
  const [videoSegment, setVideoSegment] = useState("");
  const [assistantAsset, setAssistantAsset] = useState<{ id: string; selection: number }>();
  const [batchHost, setBatchHost] = useState<HTMLSpanElement | null>(null);
  const studioAdaptations = useStudioAdaptations();
  const [generateHost, setGenerateHost] = useState<HTMLDivElement | null>(null);
  const [editorHost, setEditorHost] = useState<HTMLElement | null>(null);
  const [previewHost, setPreviewHost] = useState<HTMLElement | null>(null);
  const productionKey =
    stage === "studio" && activeEpisode && !prerequisite && !storyboardGate
      ? `${projectHandle}:${doc?.episode_order ?? 0}:${activeEpisode.episode_no}`
      : "";
  const [studioFace, setStudioFace] = useState<{ key: string; canvas: boolean; target?: string }>();
  const showStudioCanvas =
    !!productionKey && studioFace?.key === productionKey && studioFace.canvas;
  const openStudioCanvas = (target?: string) =>
    setStudioFace({ key: productionKey, canvas: true, target });
  useEffect(() => {
    setStudioFace(undefined);
  }, [productionKey]);
  useEffect(() => {
    const target = studioFace?.target;
    if (!target || !showStudioCanvas) return;
    const frame = requestAnimationFrame(() => {
      if (assetEditor.focus(target))
        setStudioFace((previous) =>
          previous?.target === target ? { ...previous, target: undefined } : previous,
        );
      else if (assetEditor.ready && !assetEditor.graph.nodes.some((node) => node.id === target)) {
        setStudioFace(undefined);
        setNotice("故事板节点已移除");
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [studioFace, showStudioCanvas, assetEditor]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scriptSelection, setScriptSelection] = useState<number[]>();
  const [breakdownSelection, setBreakdownSelection] = useState<number[]>();
  const setBreakdownOpen = (open: boolean) => setBreakdownSelection(open ? [] : undefined);
  const [batchOpen, setBatchOpen] = useState(false);
  const [continueOpen, setContinueOpen] = useState(false);
  const mediaModels = canvasAgentMediaModels({ providers, plugins });
  const imageModels = mediaModels
    .filter((entry) => entry.kind === "image")
    .map((entry) => entry.provider);
  const videoModels = mediaModels
    .filter((entry) => entry.kind === "video")
    .map((entry) => entry.provider);
  const preferenceKey = `drama-studio:${projectId}:video-model`;
  const boardPreference = `drama-studio:${projectId}:board-off`;
  const [boardOff, setBoardOff] = useState(() => {
    try {
      return localStorage.getItem(boardPreference) === "true";
    } catch {
      return false;
    }
  });
  function changeBoardReference(off: boolean) {
    setBoardOff(off);
    try {
      localStorage.setItem(boardPreference, String(off));
    } catch {}
  }
  const [providerId, setProviderId] = useState(() => {
    try {
      return localStorage.getItem(preferenceKey) ?? "";
    } catch {
      return "";
    }
  });
  function pickProvider(id: string) {
    setProviderId(id);
    try {
      localStorage.setItem(preferenceKey, id);
    } catch {}
  }
  const resolutionKey = `drama-studio:${projectId}:resolution`;
  const [resolution, setResolution] = useState(() => {
    try {
      return localStorage.getItem(resolutionKey) ?? "";
    } catch {
      return "";
    }
  });
  function pickResolution(value: string) {
    setResolution(value);
    try {
      localStorage.setItem(resolutionKey, value);
    } catch {}
  }
  const { model: studioModel, options } = studioVideoSelection(
    providerId,
    doc?.video_model,
    videoModels,
    plugins,
  );
  const modelLimit =
    options?.durationRange?.max ??
    (options?.durations.length ? Math.max(...options.durations) : 15);
  const field =
    options && !options.hiddenParameters.includes("resolution") && options.resolutions.length
      ? {
          label: options.parameterLabels.resolution || "分辨率",
          choices: options.resolutions,
          defaultValue: studioModel?.config?.params?.resolution?.default,
        }
      : undefined;
  const storyboardAudios = options?.references.audio ?? 0;
  const storyboardLimit = Math.min(60, Math.max(4, Math.floor(modelLimit)));
  const episodeSegments = useMemo(
    () => doc?.segments?.filter((entry) => entry.episode_no === activeEpisode?.episode_no),
    [doc?.segments, activeEpisode?.episode_no],
  );
  const selectedSegment =
    episodeSegments?.find((entry) => entry.id === videoSegment) ??
    episodeSegments?.find((entry) => entry.seq === 0) ??
    episodeSegments?.[0];
  const selectedAssistantAsset =
    stage === "assets" || showStudioCanvas
      ? assetEditor.graph.nodes.find(
          (node) => node.id === (assistantAsset?.id || assetEditor.selected),
        )
      : undefined;
  const assistantAssetMeta =
    selectedAssistantAsset?.type === "creative" && dramaAssetMeta(selectedAssistantAsset.data);
  const attempt =
    selectedSegment &&
    editorAttempt(
      selectedSegment,
      assetEditor.jobs.get(`seg:${selectedSegment.id}`) ?? [],
      assetEditor.assets,
    );
  const videoIssues = new Map(
    videoModels.map((model) => [model.id, dramaVideoModelIssue(model, plugins)]),
  );
  const dialog = useRef<HTMLDialogElement>(null);
  const openSetup = useRef<HTMLButtonElement>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const prompts = useStartPrompts(setupOpen);
  const [sourceTab, setSourceTab] = useState<"file" | "paste">("file");
  const [paste, setPaste] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [draggingFile, setDraggingFile] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const filename = sourceTab === "file" ? (file?.name ?? "") : "source.txt";
  const title = filename.replace(/\.[^.]*$/u, "").trim() || "未命名短剧";
  const pasteProblem =
    sourceTab !== "paste" || !paste
      ? ""
      : !paste.trim()
        ? "内容为空，先粘贴剧本或小说正文"
        : paste.length > 5_000_000
          ? "内容超过 500 万字，请删减后再试"
          : "";
  function selectFile(picked: File) {
    const problem = /\.pdf$/iu.test(picked.name)
      ? "PDF 暂不支持，请转成 txt / md / docx 后再上传"
      : !/\.(txt|md|docx)$/iu.test(picked.name)
        ? "仅支持 txt / md / docx 文件"
        : picked.size > 32 * 1024 * 1024
          ? "文件超过 32 MiB"
          : "";
    changeSource(() => setFile(problem ? null : picked));
    setSourceProblem(problem);
  }
  const [seconds, setSeconds] = useState("60");
  const [ratio, setRatio] = useState<DramaStartRatio>("9:16");
  const [textModel, setTextModel] = useState("");
  const [videoPick, setVideoPick] = useState("");
  const [genre, setGenre] = useState("");
  const [styleKey, setStyleKey] = useState(defaultDramaStyle);
  const [styleCustom, setStyleCustom] = useState("");
  const videoModel = videoIssues.get(videoPick) === "" ? videoPick : "";
  const [preflight, setPreflight] = useState<DramaSourcePreview>();
  const [sourceKind, setSourceKind] = useState<"script" | "novel">();
  const [rangeEnd, setRangeEnd] = useState(0);
  const [imagePicks, setImagePicks] = useState(emptyStartImages);
  const [paramPicks, setParamPicks] = useState<DramaImageParams>({});
  const liveImage = (id: string) => (imageModels.some((model) => model.id === id) ? id : "");
  const startImages = {
    character: liveImage(imagePicks.character),
    scene: liveImage(imagePicks.scene),
    prop: liveImage(imagePicks.prop),
  };
  const imageRows = dramaAssetSlots.map((slot) => {
    const model = imageModels.find((item) => item.id === startImages[slot]) ?? imageModels[0];
    const fields = dramaImageFields(model, plugins);
    return {
      slot,
      label: { character: "人物", scene: "场景", prop: "物品" }[slot],
      fields,
      params: settleDramaImageParams(fields, slot, paramPicks[slot]),
    };
  });
  const [sourceProblem, setSourceProblem] = useState("");
  const textModels = dramaAgentModels(providers);
  const sourceToken = preflight?.sourceToken;
  function changeSource(update: () => void) {
    setPreflight(undefined);
    setSourceProblem("");
    update();
  }
  const previewKey = JSON.stringify([
    projectHandle,
    sourceToken,
    seconds,
    textModel,
    sourceKind,
    rangeEnd,
  ]);
  const initialPreviewKey = JSON.stringify([
    projectHandle,
    sourceToken,
    "60",
    "",
    preflight?.kindGuess === "script" ? "script" : "novel",
    0,
  ]);
  const [preview, setPreview] = useState<{
    key: string;
    value?: DramaSourcePreview;
    error?: string;
    code?: string;
  }>();
  const matchesInitial = !!preflight && previewKey === initialPreviewKey;
  const currentPreview = matchesInitial
    ? { value: preflight, error: preflight?.estimateProblem, code: undefined }
    : preview?.key === previewKey
      ? preview
      : undefined;
  const sourceUnits = currentPreview?.value ?? preview?.value ?? preflight;
  const modelBlocked = currentPreview?.code === "DRAMA_CONTEXT";
  const startBlock = !textModels.length
    ? "请在模型与渠道中启用可用的 Agent 模型"
    : !sourceKind
      ? "先确认是剧本还是小说"
      : !styleKey
        ? "先选一个画风"
        : modelBlocked
          ? "所选模型装不下原文，请换一个"
          : undefined;
  const previousEstimate = sourceUnits;
  const planning = previousEstimate?.planning;
  const countLabel =
    previousEstimate?.exactEpisodes?.toLocaleString("en-US") ??
    (planning &&
      `${planning.episodeMin.toLocaleString("en-US")}${planning.episodeMax === planning.episodeMin ? "" : `–${planning.episodeMax.toLocaleString("en-US")}`}`);
  const unitWord =
    ({ chapter: "章", episode: "集", scene: "场" } as Record<string, string>)[
      sourceUnits?.kind ?? ""
    ] ?? "段";
  const hasCurrentPreview = !!currentPreview;
  useEffect(() => {
    if (
      !setupOpen ||
      !sourceKind ||
      !sourceToken ||
      hasCurrentPreview ||
      !Number.isInteger(Number(seconds)) ||
      Number(seconds) < 30 ||
      Number(seconds) > 180
    )
      return;
    let live = true;
    const timer = window.setTimeout(async () => {
      try {
        const result = await window.desktop.projects.previewDramaSource({
          projectHandle,
          sourceToken,
          textModel,
          sourceKind,
          rangeEnd,
          episodeSeconds: Number(seconds),
        });
        if (live)
          setPreview((previous) =>
            result.ok
              ? { key: previewKey, value: result.value }
              : {
                  key: previewKey,
                  value: previous?.value,
                  code: result.error.code,
                  error: result.error.message ?? settingsError(result.error.code),
                },
          );
      } catch {
        if (live)
          setPreview((previous) => ({
            key: previewKey,
            value: previous?.value,
            error: "无法读取预估",
          }));
      }
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [
    setupOpen,
    hasCurrentPreview,
    projectHandle,
    sourceToken,
    seconds,
    textModel,
    sourceKind,
    rangeEnd,
    previewKey,
  ]);
  const [error, setError] = useState("");
  const { busy, run } = useAssistantAction(setError);
  const read = useCallback(async () => {
    setError("");
    const response = await window.desktop.projects.drama({ projectHandle });
    if (response.ok)
      setDoc((current) =>
        current && response.value && current.revision > response.value.revision
          ? current
          : response.value,
      );
    else setError(response.error.code);
  }, [projectHandle]);
  useEffect(() => {
    void read();
  }, [read]);
  const hasActiveJobs =
    doc?.planning?.phase === "running" ||
    !!doc?.planning?.pending ||
    doc?.jobs?.some((job) => job.status === "queued" || job.status === "running");
  const scriptStep = doc && stage === "script" ? scriptNextStep(doc) : null;
  function openScriptAction(kind: "scripts" | "breakdown", rewrite = false) {
    void run(async () => {
      try {
        await flushPaper.current?.();
      } catch {
        setNotice("当前剧本尚未保存，请先处理保存提示");
        return;
      }
      const latest = await window.desktop.projects.drama({ projectHandle });
      if (!latest.ok || !latest.value) {
        setError(latest.ok ? "短剧不存在" : (latest.error.message ?? latest.error.code));
        return;
      }
      const step = scriptNextStep(latest.value);
      setDoc(latest.value);
      if (step.blocked || (!rewrite && step.kind !== kind)) return;
      if (kind === "scripts") setScriptSelection([]);
      else setBreakdownOpen(true);
    });
  }
  const flushDrafts = useCallback(async () => {
    try {
      await flushPaper.current?.();
      for (const write of writers) await write();
      return true;
    } catch {
      setNotice("当前编辑尚未保存，请先处理保存提示");
      return false;
    }
  }, [writers]);
  useEffect(() => {
    flushBeforeClose.current = flushDrafts;
    return () => {
      flushBeforeClose.current = null;
    };
  }, [flushBeforeClose, flushDrafts]);
  async function flushNavigation() {
    if (!(await flushDrafts())) return false;
    if (stage === "assets" || showStudioCanvas) {
      try {
        if (await assetEditor.save()) return true;
      } catch {}
      setNotice("画布尚未保存，请检查保存状态后重试");
      return false;
    }
    return true;
  }
  async function go(target: Stage, no?: number) {
    if (!(await flushNavigation())) return;
    nav.go(target, no);
    setNotice("");
    setVideoSegment("");
    setAssistantAsset(undefined);
  }
  async function pick(next: DramaPage) {
    if (!(await flushNavigation())) return;
    nav.pick(next);
    setNotice("");
    setVideoSegment("");
    setAssistantAsset(undefined);
  }
  useEffect(() => {
    if (!doc) return;
    const keydown = (event: KeyboardEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.defaultPrevented ||
        (event.target as HTMLElement)?.closest(
          'input, textarea, select, [contenteditable="true"]',
        ) ||
        document.querySelector('dialog[open],[role="dialog"],[role="alertdialog"],[role="menu"]')
      )
        return;
      if (/^[1-5]$/.test(event.key))
        go(
          requirePresent(
            (Object.keys(stages) as Stage[])[Number(event.key) - 1],
            "(Object.keys(stages) as Stage[])[Number(event.key) - 1]",
          ),
        );
      if (event.key === "[" || event.key === "]") {
        const index = Math.max(
            0,
            doc.episodes.findIndex((item) => item.episode_no === nav.ep),
          ),
          next = doc.episodes[index + (event.key === "]" ? 1 : -1)];
        if (next) pick(next.episode_no);
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  });
  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = window.setInterval(() => {
      void read();
    }, 600);
    return () => window.clearInterval(timer);
  }, [hasActiveJobs, read]);
  async function planTask(action: PlanningAction) {
    const result = await window.desktop.projects.drama({ projectHandle, planningAction: action });
    if (!result.ok || !result.value)
      throw Error(result.ok ? "短剧不存在" : (result.error.message ?? result.error.code));
    acceptDocument(result.value);
  }
  async function recoverTask(job: NonNullable<DramaDocument["jobs"]>[number]) {
    if (!(await flushNavigation())) throw Error("请先保存当前编辑");
    const result = await window.desktop.projects.drama({ projectHandle });
    if (!result.ok || !result.value)
      throw Error(result.ok ? "短剧不存在" : (result.error.message ?? result.error.code));
    const latest = result.value;
    acceptDocument(latest);
    if ((job.episode_order ?? 0) !== (latest.episode_order ?? 0))
      throw Error("分集顺序已变化，请从当前分集重新选择任务");
    const episodes = latest.episodes.filter((ep) => job.episodes.includes(ep.episode_no));
    if (!episodes.length) throw Error("任务涉及的分集已移除");
    const available = episodes.filter(
      (ep) => !ep.locked && !job.done_episodes?.includes(ep.episode_no),
    );
    if (job.step === "scripts" && available.length)
      setScriptSelection(available.map((ep) => ep.episode_no));
    else if (job.step === "breakdown" && available.length)
      setBreakdownSelection(available.map((ep) => ep.episode_no));
    else
      await go(
        job.step === "compose"
          ? "final"
          : job.step === "storyboard"
            ? "studio"
            : job.step === "scripts"
              ? "script"
              : "assets",
        requirePresent(episodes[0], "episodes[0]").episode_no,
      );
  }
  async function quoteTaskPrompts(job: NonNullable<DramaDocument["jobs"]>[number]) {
    if (!(await flushNavigation()) || !(await assetEditor.save())) throw Error("请先保存当前编辑");
    if ((job.episode_order ?? 0) !== (doc?.episode_order ?? 0))
      throw Error("分集顺序已变化，请重新选择分集");
    const quote = await window.desktop.projects.estimateDramaBreakdown({
      projectHandle,
      episodes: job.episodes,
      promptsOnly: true,
    });
    if (!quote.ok) throw Error(quote.error.message ?? quote.error.code);
    const request = {
      episodes: job.episodes,
      episodeOrder: doc?.episode_order ?? 0,
      estimate: quote.value,
      operationId: crypto.randomUUID(),
    };
    return {
      estimate: quote.value,
      submit: async () => {
        const result = await window.desktop.projects.drama({
          projectHandle,
          repairPrompts: request,
        });
        if (!result.ok || !result.value)
          throw Error(result.ok ? "短剧不存在" : (result.error.message ?? result.error.code));
        acceptDocument(result.value);
      },
    };
  }
  function planningAction(action: PlanningAction) {
    void run(async () => {
      await planTask(action);
    });
  }
  const planningModel = providers.find(
    (item) => item.id === (doc?.planning?.model.id ?? doc?.board_settings?.textModel),
  );
  return (
    <DramaFlushers.Provider value={writers}>
      <DramaSaveStatus.Provider value={reportSave}>
        <main className="drama-studio" aria-label="短剧工作室">
          {projectTabs && projectTabs.length > 1 && (
            <nav className="drama-project-tabs" aria-label="打开的短剧项目">
              {projectTabs.map((entry) => (
                <div
                  key={entry.recentEntryId}
                  data-current={entry.recentEntryId === activeRecentId}
                >
                  <button
                    type="button"
                    aria-current={entry.recentEntryId === activeRecentId ? "page" : undefined}
                    title={entry.displayName}
                    onClick={() => void visitTab(entry, false)}
                  >
                    <Clapperboard size={13} />
                    <span>{entry.displayName}</span>
                    {entry.activity && <small>{entry.activity.label}</small>}
                  </button>
                  <button
                    type="button"
                    aria-label={`关闭${entry.displayName}标签`}
                    title="关闭标签，保留后台任务"
                    onClick={() => void visitTab(entry, true)}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </nav>
          )}
          {doc ? (
            <DramaWorkspaceHeader
              doc={doc}
              controls={{
                projectId,
                saveLabel,
                access: {
                  projectHandle,
                  saved: acceptDocument,
                  flush: async () => {
                    await flushPaper.current?.();
                  },
                },
                toggleTheme,
                assistant: toggleAssistant
                  ? { open: withAssistant, toggle: toggleAssistant }
                  : undefined,
                breakdown: () => openScriptAction("breakdown", true),
                rewriteScripts:
                  doc.planning &&
                  scriptStep?.kind === "breakdown" &&
                  !scriptStep.blocked &&
                  activeEpisode &&
                  !activeEpisode.locked
                    ? () => openScriptAction("scripts", true)
                    : undefined,
                tasks: {
                  blank: blankAssetPrompts,
                  quotePrompts: quoteTaskPrompts,
                  plan: planTask,
                  recover: recoverTask,
                  cancel: async (id) => {
                    const result = await window.desktop.projects.drama({
                      projectHandle,
                      cancelJob: id,
                    });
                    if (!result.ok || !result.value)
                      throw Error(
                        result.ok ? "短剧不存在" : (result.error.message ?? result.error.code),
                      );
                    acceptDocument(result.value);
                  },
                },
              }}
              go={go}
              model={planningModel?.config?.name ?? planningModel?.label}
              returnLabel={returnLabel}
              back={async () => {
                if (await flushNavigation()) close();
              }}
              settings={() => setSettingsOpen(true)}
              progress={() => pick("outline")}
            >
              <DramaStageTabs
                stage={stage}
                hints={stageHints(doc, canvas.snapshot?.freshBoards)}
                go={go}
              />
            </DramaWorkspaceHeader>
          ) : (
            <header className="drama-workspace-fallback-header">
              <button type="button" onClick={close}>
                {returnLabel}
              </button>
              <h1>短剧工作室</h1>
            </header>
          )}
          {doc && settingsOpen && (
            <DramaProjectSettings
              projectHandle={projectHandle}
              document={doc}
              models={imageModels}
              onSaved={setDoc}
              onClose={() => setSettingsOpen(false)}
            />
          )}
          {doc && scriptSelection && (
            <DramaScriptsDialog
              projectHandle={projectHandle}
              doc={doc}
              initial={scriptSelection}
              saved={setDoc}
              close={() => setScriptSelection(undefined)}
            />
          )}
          {doc && activeEpisode && batchOpen && stage === "studio" && (
            <DramaStoryboardBatch
              key={`${projectHandle}:${doc.episode_order ?? 0}:${studioModel?.id}:${storyboardLimit}:${storyboardAudios}`}
              doc={doc}
              current={activeEpisode.episode_no}
              maxSeconds={storyboardLimit}
              videoModel={studioModel?.id}
              projectHandle={projectHandle}
              close={() => setBatchOpen(false)}
              started={(message) => {
                setBatchOpen(false);
                setNotice(message);
                void read();
              }}
            />
          )}
          {doc && breakdownSelection && (
            <DramaScriptsDialog
              mode="breakdown"
              projectHandle={projectHandle}
              doc={doc}
              initial={breakdownSelection}
              saved={(next) => {
                setDoc(next);
                go("assets", 0);
              }}
              close={() => setBreakdownOpen(false)}
            />
          )}
          {continueOpen && doc?.planning && doc.source && (
            <DramaContinueDialog
              projectHandle={projectHandle}
              doc={doc}
              saved={setDoc}
              close={() => setContinueOpen(false)}
            />
          )}
          {error && !setupOpen && doc !== undefined && (
            <DramaNotice tone="error">{settingsError(error)}</DramaNotice>
          )}
          {doc === undefined ? (
            error ? (
              <DramaWorkspaceState
                kind="error"
                title="短剧读取失败"
                description={settingsError(error)}
                action={{ label: "重试读取", onClick: () => void read() }}
              />
            ) : (
              <DramaWorkspaceState
                kind="loading"
                title="正在读取短剧"
                description="正在准备片场、分集和制作状态。"
              />
            )
          ) : doc === null ? (
            <div className="drama-source">
              <div className="drama-source-intro">
                <span className="drama-source-kicker">
                  <Clapperboard size={14} aria-hidden="true" />
                  灵可短剧工作室 · 开拍入口
                </span>
                <h2>把剧本交给灵可</h2>
                <p>从一页灵感，到一部可以开拍的短剧。</p>
                <div className="drama-source-notes">
                  <span>自动拆分分集</span>
                  <span>智能识别场景</span>
                  <span>一键生成分镜</span>
                </div>
              </div>
              <fieldset disabled={busy}>
                <div className="drama-source-panel-head">
                  <div>
                    <strong>先交给我原文</strong>
                    <small>上传文件，或直接粘贴剧本 / 小说正文</small>
                  </div>
                  <span className="drama-source-step">01 / 03</span>
                </div>
                <fieldset data-ui-group aria-label="剧本来源">
                  <button
                    type="button"
                    aria-pressed={sourceTab === "file"}
                    onClick={() => sourceTab !== "file" && changeSource(() => setSourceTab("file"))}
                  >
                    上传剧本 / 小说
                  </button>
                  <button
                    type="button"
                    aria-pressed={sourceTab === "paste"}
                    onClick={() =>
                      sourceTab !== "paste" && changeSource(() => setSourceTab("paste"))
                    }
                  >
                    粘贴正文
                  </button>
                </fieldset>
                {sourceTab === "file" ? (
                  <fieldset
                    data-ui-group
                    className="drama-file-drop"
                    data-dragging={draggingFile || undefined}
                    aria-label="剧本文件"
                    onDragOver={(event) => {
                      event.preventDefault();
                      if (!busy && event.dataTransfer.types.includes("Files"))
                        setDraggingFile(true);
                    }}
                    onDragLeave={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                        setDraggingFile(false);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDraggingFile(false);
                      const picked = event.dataTransfer.files[0];
                      if (!busy && picked) selectFile(picked);
                    }}
                  >
                    <input
                      type="file"
                      accept=".txt,.md,.docx"
                      aria-label="剧本文件"
                      ref={fileInput}
                      hidden
                      onChange={(event) => {
                        const picked = event.target.files?.[0];
                        if (picked) selectFile(picked);
                        event.target.value = "";
                      }}
                    />
                    <FileText size={26} aria-hidden="true" />
                    <span>{file?.name ?? "拖入剧本或小说"}</span>
                    {file && (
                      <small>
                        {file.size >= 1024 * 1024
                          ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
                          : `${(file.size / 1024).toFixed(1)} KB`}
                      </small>
                    )}
                    <button
                      type="button"
                      className="drama-file-pick"
                      onClick={() => fileInput.current?.click()}
                    >
                      {file ? "更换" : "选择文件"}
                    </button>
                    {file && (
                      <button type="button" onClick={() => changeSource(() => setFile(null))}>
                        移除
                      </button>
                    )}
                  </fieldset>
                ) : (
                  <label className="drama-paste-pane">
                    <textarea
                      rows={12}
                      required
                      aria-label="粘贴正文"
                      placeholder="粘贴剧本或小说正文"
                      value={paste}
                      onChange={(event) => changeSource(() => setPaste(event.target.value))}
                    />
                    {paste.length > 0 && (
                      <small>
                        {paste.length.toLocaleString()} / {Number(5_000_000).toLocaleString()} 字
                      </small>
                    )}
                  </label>
                )}
                <footer>
                  <span>txt · md · docx　500 万字以内</span>
                  <button
                    ref={openSetup}
                    type="button"
                    aria-label="开始"
                    title="预检原文并设置开拍；规则认不出体裁时，会将原文采样交给当前文本模型判断"
                    disabled={busy || (sourceTab === "file" ? !file : !paste || !!pasteProblem)}
                    onClick={() =>
                      void run(async () => {
                        const prefs = loadDramaStartPrefs();
                        if (!textModels.length) refreshModels?.();
                        const initialSeconds = String(prefs.seconds);
                        setSourceProblem("");
                        const result =
                          preflight?.estimateProblem && preflight.sourceToken
                            ? await window.desktop.projects
                                .previewDramaSource({
                                  projectHandle,
                                  sourceToken: preflight.sourceToken,
                                  textModel: prefs.textModel,
                                })
                                .then((retry) =>
                                  retry.ok
                                    ? {
                                        ...retry,
                                        value: {
                                          ...retry.value,
                                          sourceToken: preflight.sourceToken,
                                        },
                                      }
                                    : {
                                        ok: true as const,
                                        value: {
                                          ...preflight,
                                          estimateProblem:
                                            retry.error.message ?? settingsError(retry.error.code),
                                        },
                                      },
                                )
                            : preflight
                              ? { ok: true as const, value: preflight }
                              : await window.desktop.projects.previewDramaSource({
                                  projectHandle,
                                  ...(sourceTab === "file" && file
                                    ? { fileBytes: new Uint8Array(await file.arrayBuffer()) }
                                    : { script: paste }),
                                  filename,
                                  preflightOnly: true,
                                });
                        if (!result.ok) {
                          setSourceProblem(
                            result.error.message ?? settingsError(result.error.code),
                          );
                          return;
                        }
                        setPreview(undefined);
                        setRangeEnd(0);
                        setSourceKind(
                          result.value.kindGuess === "unknown" ? undefined : result.value.kindGuess,
                        );
                        setPreflight(result.value);
                        setVideoPick(prefs.videoModel ?? "");
                        setGenre(prefs.genre ?? "");
                        setStyleKey(prefs.styleKey ?? defaultDramaStyle);
                        setStyleCustom(prefs.styleCustom ?? "");
                        setTextModel(prefs.textModel ?? "");
                        setImagePicks(prefs.imageModels ?? emptyStartImages);
                        setParamPicks(prefs.imageParams ?? {});
                        prompts.setPicks(prefs.prompts ?? {});
                        setSeconds(initialSeconds);
                        setRatio(prefs.ratio);
                        setSetupOpen(true);
                        dialog.current?.showModal();
                      })
                    }
                  >
                    <ArrowUp size={18} />
                  </button>
                </footer>
              </fieldset>
              {(sourceProblem || pasteProblem) && !setupOpen && (
                <DramaNotice tone="error">{sourceProblem || pasteProblem}</DramaNotice>
              )}
              <dialog
                ref={dialog}
                aria-label="开拍设置"
                className="drama-start-dialog"
                onClose={() => {
                  setSetupOpen(false);
                  setError("");
                  openSetup.current?.focus();
                }}
                onCancel={(event) => {
                  if (busy || prompts.draft) event.preventDefault();
                  if (prompts.draft) prompts.setDraft(undefined);
                }}
              >
                {setupOpen && (
                  <form
                    hidden={!!prompts.draft}
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!sourceKind || !sourceToken || startBlock || busy || !prompts.ready)
                        return;
                      void run(async () => {
                        const imageParams = Object.fromEntries(
                          imageRows
                            .filter((row) => Object.keys(row.params).length)
                            .map((row) => [row.slot, row.params]),
                        );
                        const result = await window.desktop.projects.drama({
                          projectHandle,
                          create: {
                            title,
                            sourceToken,
                            sourceKind,
                            rangeEnd,
                            episodeSeconds: Number(seconds),
                            ratio,
                            genre,
                            styleKey,
                            styleCustom: styleKey === "custom" ? styleCustom.trim() : "",
                            textModel,
                            videoModel,
                            imageModels: startImages,
                            prompts: prompts.picks,
                            ...(Object.keys(imageParams).length && { imageParams }),
                          },
                        });
                        if (result.ok) {
                          saveDramaStartPrefs({
                            ratio,
                            seconds: Number(seconds),
                            genre,
                            styleKey,
                            styleCustom,
                            textModel,
                            videoModel,
                            imageModels: startImages,
                            imageParams: paramPicks,
                            prompts: prompts.picks,
                          });
                          dialog.current?.close();
                          setSetupOpen(false);
                          setDoc(result.value);
                        } else {
                          if (result.error.code === "DRAMA_SOURCE_EXPIRED") {
                            dialog.current?.close();
                            setSetupOpen(false);
                            setPreflight(undefined);
                          }
                          setSourceProblem(
                            result.error.message ?? settingsError(result.error.code),
                          );
                        }
                      });
                    }}
                  >
                    <h2>开拍设置</h2>
                    <div className="drama-start-file">
                      <span aria-hidden="true">
                        <FileText size={20} />
                      </span>
                      <div>
                        <strong>{filename}</strong>
                        {sourceUnits && (
                          <small>
                            {sourceUnits.chars >= 10000
                              ? `${(sourceUnits.chars / 10000).toFixed(1).replace(/\.0$/, "")} 万字`
                              : `${sourceUnits.chars.toLocaleString("en-US")} 字`}{" "}
                            · {sourceUnits.units.toLocaleString("en-US")} {unitWord}
                          </small>
                        )}
                      </div>
                      <FieldMenu
                        container={dialog}
                        label="原文类型"
                        kind="source"
                        value={
                          sourceKind === "novel"
                            ? "小说"
                            : sourceKind === "script"
                              ? "剧本"
                              : "请选择"
                        }
                      >
                        {(close) => (
                          <>
                            {(
                              [
                                ["novel", "小说", "先改编成剧本"],
                                ["script", "剧本", "直接导入，不改编"],
                              ] as const
                            ).map(([key, name, note]) => (
                              <button
                                type="button"
                                className="drama-menu-row"
                                aria-pressed={sourceKind === key}
                                key={key}
                                onClick={() => {
                                  setSourceKind(key);
                                  setRangeEnd(0);
                                  close();
                                }}
                              >
                                <span>
                                  {name}
                                  <small>{note}</small>
                                </span>
                              </button>
                            ))}
                          </>
                        )}
                      </FieldMenu>
                    </div>
                    {preflight && (
                      <>
                        <div className="drama-start-basis">
                          依据：{preflight.kindSignals}
                          {sourceKind &&
                            ` · ${sourceKind === "novel" ? "先改编成剧本" : sourceUnits?.kind === "episode" ? "按原分集直接导入" : "未找到分集标记，将按场次切集"}`}
                          {preflight.issues.length > 0 && (
                            <>
                              {" "}
                              ·{" "}
                              <details>
                                <summary>已处理 {preflight.issues.length} 处</summary>
                                <ul>
                                  {keyedItems(
                                    preflight.issues,
                                    (issue) => issue.kind + issue.message,
                                  ).map(({ item: issue, key }) => (
                                    <li key={key}>{issue.message}</li>
                                  ))}
                                </ul>
                              </details>
                            </>
                          )}
                        </div>
                        <div className="drama-start-divider" />
                        <div className="drama-start-field">
                          <span>规划范围</span>
                          {sourceKind === "script" ? (
                            <span className="drama-start-episodes">
                              剧本一次切完 · {countLabel} 集
                            </span>
                          ) : (
                            <div className="drama-start-chips">
                              <FieldMenu
                                container={dialog}
                                label="规划范围"
                                kind="range"
                                value={rangeEnd ? `规划到第 ${rangeEnd} ${unitWord}` : "全部"}
                              >
                                {(close) => (
                                  <>
                                    {[0, 20, 60, 120, 300]
                                      .filter((end) => end < (sourceUnits?.units ?? 1))
                                      .map((end) => (
                                        <button
                                          type="button"
                                          className="drama-menu-row"
                                          key={end}
                                          aria-pressed={rangeEnd === end}
                                          onClick={() => {
                                            setRangeEnd(end);
                                            close();
                                          }}
                                        >
                                          {end
                                            ? `规划到第 ${end} ${unitWord}`
                                            : `全部（${sourceUnits?.units} ${unitWord}）`}
                                        </button>
                                      ))}
                                    <label>
                                      第{" "}
                                      <input
                                        type="number"
                                        aria-label={`规划到第几${unitWord}`}
                                        min={1}
                                        max={sourceUnits?.units}
                                        defaultValue={
                                          rangeEnd || Math.min(sourceUnits?.units ?? 1, 120)
                                        }
                                        onBlur={(event) => {
                                          const end = Math.floor(Number(event.target.value));
                                          setRangeEnd(
                                            Number.isFinite(end)
                                              ? Math.max(1, Math.min(end, sourceUnits?.units ?? 1))
                                              : 1,
                                          );
                                          close();
                                        }}
                                        onKeyDown={(event) => {
                                          if (event.key === "Enter") {
                                            event.preventDefault();
                                            event.currentTarget.blur();
                                          }
                                        }}
                                      />{" "}
                                      {unitWord}
                                    </label>
                                  </>
                                )}
                              </FieldMenu>
                              {planning && !currentPreview?.error && (
                                <div className="drama-range-estimate" aria-busy={!currentPreview}>
                                  <span>
                                    预计约 {planning.episodeMin.toLocaleString("en-US")}
                                    {planning.episodeMax !== planning.episodeMin &&
                                      `–${planning.episodeMax.toLocaleString("en-US")}`}{" "}
                                    集
                                  </span>
                                  <i aria-hidden="true">·</i>
                                  <span>
                                    {previousEstimate.priceUnavailable ? (
                                      "未配置价格，暂无法估价"
                                    ) : (
                                      <>
                                        研读与规划约{" "}
                                        <em>{previousEstimate.credits.toLocaleString("en-US")}</em>{" "}
                                        积分
                                      </>
                                    )}
                                  </span>
                                  <i aria-hidden="true">·</i>
                                  <span>
                                    约{" "}
                                    {planning.minutes < 60
                                      ? `${Math.max(1, planning.minutes)} 分钟`
                                      : `${(planning.minutes / 60).toFixed(1).replace(/\.0$/, "")} 小时`}
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </>
                    )}
                    <fieldset className="drama-ratio">
                      <legend>画幅</legend>
                      <div>
                        {(
                          [
                            ["9:16", 12, 20],
                            ["16:9", 24, 14],
                            ["4:3", 20, 15],
                          ] as const
                        ).map(([key, width, height]) => (
                          <button
                            type="button"
                            key={key}
                            aria-pressed={ratio === key}
                            onClick={() => setRatio(key)}
                          >
                            <i aria-hidden="true" style={{ width, height }} />
                            {key}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                    <DramaStartStyle
                      container={dialog}
                      genre={genre}
                      styleKey={styleKey}
                      custom={styleCustom}
                      seconds={seconds}
                      script={sourceKind === "script"}
                      lockedUnits={
                        sourceKind === "script" && sourceUnits?.kind === "episode"
                          ? sourceUnits.units
                          : undefined
                      }
                      onGenre={setGenre}
                      onStyle={setStyleKey}
                      onCustom={setStyleCustom}
                      onSeconds={setSeconds}
                    />
                    <div className="drama-start-field">
                      <span>文本模型</span>
                      <DramaStartModel
                        container={dialog}
                        kind="文本"
                        models={textModels}
                        plugins={plugins}
                        loading={loadingModels}
                        value={textModel}
                        change={(id) => {
                          setSourceProblem("");
                          setTextModel(id);
                        }}
                      />
                      {modelBlocked && (
                        <DramaNotice tone="error">{currentPreview.error}</DramaNotice>
                      )}
                    </div>
                    <div className="drama-start-field">
                      <span>视频模型</span>
                      <DramaStartModel
                        container={dialog}
                        kind="视频"
                        models={videoModels}
                        plugins={plugins}
                        loading={loadingModels}
                        issues={videoIssues}
                        value={videoModel}
                        change={setVideoPick}
                      />
                    </div>
                    <div className="drama-start-field">
                      <span>资产图片</span>
                      {imageRows.map(({ slot, label, fields, params }) => (
                        <div key={slot} className="drama-start-chips">
                          <DramaStartModel
                            container={dialog}
                            kind="图片"
                            prefix={label}
                            models={imageModels}
                            plugins={plugins}
                            loading={loadingModels}
                            value={startImages[slot]}
                            change={(id) => setImagePicks({ ...imagePicks, [slot]: id })}
                          />
                          <DramaStartParams
                            container={dialog}
                            label={label}
                            fields={fields}
                            params={params}
                            onPick={(change) =>
                              setParamPicks((previous) => ({
                                ...previous,
                                [slot]: { ...previous[slot], ...change },
                              }))
                            }
                          />
                        </div>
                      ))}
                    </div>
                    <div className="drama-start-divider" />
                    <PromptRows
                      library={prompts}
                      container={dialog}
                      script={sourceKind === "script"}
                    />
                    {!modelBlocked && currentPreview?.error && (
                      <DramaNotice tone="error">{currentPreview.error}</DramaNotice>
                    )}
                    {sourceProblem && <DramaNotice tone="error">{sourceProblem}</DramaNotice>}
                    {error && <DramaNotice tone="error">{settingsError(error)}</DramaNotice>}
                    <footer>
                      <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>
                        取消
                      </button>
                      <button
                        type="submit"
                        title={startBlock}
                        disabled={busy || !!startBlock || !prompts.ready}
                      >
                        开始
                      </button>
                    </footer>
                  </form>
                )}
                {setupOpen && prompts.draft && (
                  <PromptEditor draft={prompts.draft} library={prompts} />
                )}
              </dialog>
            </div>
          ) : (
            <div className="drama-columns">
              <article>
                {stage !== "overview" && (
                  <EpisodeRail
                    doc={doc}
                    stage={stage}
                    page={page}
                    pick={pick}
                    busy={busy}
                    extend={() => setContinueOpen(true)}
                    remove={async (target) => {
                      await flushPaper.current?.();
                      const result = await window.desktop.projects.drama({
                        projectHandle,
                        deleteEpisode: { episode_no: target.no, episodeOrder: target.order },
                      });
                      if (!result.ok || !result.value) {
                        await read();
                        throw Error(
                          result.ok ? "短剧不存在" : (result.error.message ?? result.error.code),
                        );
                      }
                      const remaining = result.value.episodes.length;
                      setDoc(result.value);
                      setScriptSelection(undefined);
                      setVideoSegment("");
                      setNotice(`已删除第 ${target.no} 集`);
                      nav.afterDelete(target.no, remaining);
                    }}
                    add={() =>
                      void run(async () => {
                        const result = await window.desktop.projects.drama({
                          projectHandle,
                          addEpisode: { revision: doc.revision, title: "新的一集", script_md: "" },
                        });
                        if (!result.ok || !result.value) {
                          if (!result.ok) {
                            if (result.error.code === "AGENT_APPROVAL_STALE") await read();
                            setError(result.error.message ?? result.error.code);
                          }
                          return;
                        }
                        const no = requirePresent(
                          result.value.episodes.at(-1),
                          "result.value.episodes.at(-1)",
                        ).episode_no;
                        setDoc(result.value);
                        nav.go("script", no);
                        setVideoSegment("");
                        setNotice(`已新增第 ${no} 集，可以直接手写剧本`);
                      })
                    }
                  />
                )}{" "}
                <div
                  className={
                    stage === "studio" && activeEpisode
                      ? "drama-studio-production"
                      : "drama-stage-frame"
                  }
                >
                  {stage === "studio" && activeEpisode && (
                    <div className="drama-studio-batch-bar">
                      {productionKey && (
                        <DramaAssetViewToggle
                          view={showStudioCanvas ? "canvas" : "list"}
                          change={(view) =>
                            view === "canvas"
                              ? openStudioCanvas()
                              : void assetEditor.save().then(
                                  (saved) => {
                                    if (saved) {
                                      setStudioFace({ key: productionKey, canvas: false });
                                      setNotice("");
                                    } else setNotice("画布尚未保存，请检查保存状态后重试");
                                  },
                                  () => setNotice("画布保存失败，请重试"),
                                )
                          }
                          listLabel="片场"
                          listIcon={Clapperboard}
                        />
                      )}
                      {showStudioCanvas && notice && (
                        <DramaNotice tone="warning">{notice}</DramaNotice>
                      )}
                      {!showStudioCanvas && (
                        <button data-batch type="button" onClick={() => setBatchOpen(true)}>
                          批量生成脚本
                        </button>
                      )}
                      {productionKey &&
                        !showStudioCanvas &&
                        activeEpisode.locked &&
                        (activeEpisode.storyboard_status === "ready" || !!selectedSegment) && (
                          <DramaStoryboardGate
                            toolbar
                            key={`${productionKey}:${studioModel?.id}:${storyboardLimit}:${storyboardAudios}`}
                            doc={doc}
                            episode={activeEpisode}
                            projectHandle={projectHandle}
                            maxSeconds={storyboardLimit}
                            videoModel={studioModel?.id}
                            saved={setDoc}
                          />
                        )}
                      {productionKey && !showStudioCanvas && selectedSegment && (
                        <StudioSegmentSeconds
                          key={selectedSegment.id}
                          seconds={selectedSegment.seconds}
                          max={modelLimit}
                          resolutionField={field}
                          resolution={resolution}
                          pickResolution={pickResolution}
                          ratio={doc.ratio}
                          disabled={busy}
                          change={(seconds) => {
                            if (seconds === selectedSegment.seconds) return;
                            void run(async () => {
                              const response = await window.desktop.projects.drama({
                                projectHandle,
                                setSegmentSeconds: {
                                  episodeOrder: doc.episode_order ?? 0,
                                  episodeNo: selectedSegment.episode_no,
                                  segmentId: selectedSegment.id,
                                  revision: selectedSegment.revision,
                                  seconds,
                                },
                              });
                              if (response.ok) setDoc(response.value);
                              else {
                                await read();
                                setError(response.error.message ?? response.error.code);
                              }
                            });
                          }}
                        />
                      )}
                      {productionKey && !showStudioCanvas && (
                        <div className="drama-studio-generate-controls">
                          <StudioVideoModel
                            model={studioModel}
                            models={videoModels}
                            loading={loadingModels}
                            issues={videoIssues}
                            plugins={plugins}
                            pick={pickProvider}
                          />
                          <div ref={setGenerateHost} className="drama-studio-generate-slot">
                            {!selectedSegment && <DramaGenerateButton reason="还没有片段" />}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {productionKey && activeEpisode && !activeEpisode.locked && (
                    <StudioLibrary
                      key={productionKey}
                      editor={assetEditor}
                      projectHandle={projectHandle}
                      episodeNo={activeEpisode.episode_no}
                      hidden={showStudioCanvas}
                      error={canvas.problem}
                      extracting={extractingEpisodes}
                    />
                  )}
                  {productionKey && (
                    <section
                      className="drama-studio-canvas-face"
                      data-shown={showStudioCanvas}
                      inert={!showStudioCanvas}
                      aria-label="片场画布"
                    >
                      <div className="drama-canvas-slot" ref={assetEditor.mount} />
                    </section>
                  )}
                  {stage === "studio" &&
                    activeEpisode &&
                    notice &&
                    (prerequisite || storyboardGate) && <DramaNotice>{notice}</DramaNotice>}
                  {prerequisite ? (
                    <DramaStudioGate
                      kind={prerequisite}
                      no={nav.ep}
                      go={go}
                      openBreakdown={() => setBreakdownOpen(true)}
                    />
                  ) : storyboardGate && activeEpisode ? (
                    <DramaStoryboardGate
                      key={`${projectHandle}:${doc.episode_order ?? 0}:${activeEpisode.episode_no}:${studioModel?.id}:${storyboardLimit}:${storyboardAudios}`}
                      doc={doc}
                      episode={activeEpisode}
                      projectHandle={projectHandle}
                      maxSeconds={storyboardLimit}
                      videoModel={studioModel?.id}
                      saved={setDoc}
                    />
                  ) : (
                    (() => {
                      const panels = !!productionKey && !!activeEpisode?.locked;
                      const content = (
                        <div className={scriptStep ? "drama-script-frame" : "drama-stage-frame"}>
                          <div
                            className="drama-script-area"
                            data-studio-list={productionKey && !panels ? true : undefined}
                            inert={showStudioCanvas}
                          >
                            {notice && <DramaNotice>{notice}</DramaNotice>}
                            {stage === "studio" && !panels && doc.jobs?.length ? (
                              <DramaTaskStatusStack jobs={doc.jobs} />
                            ) : null}
                            {(page === "outline" || page === "characters") && (
                              <DramaReadingRoom
                                key={page}
                                access={{ projectHandle, saved: acceptDocument }}
                                registerFlush={flushPaper}
                                refresh={read}
                                notify={setNotice}
                                doc={doc}
                                page={page}
                                busy={busy}
                                act={planningAction}
                                settings={() => setSettingsOpen(true)}
                              />
                            )}
                            {stage === "overview" && (
                              <StageOverview
                                editor={assetEditor}
                                projectHandle={projectHandle}
                                doc={doc}
                                go={go}
                                fresh={canvas.snapshot?.freshBoards}
                                openOutline={() => pick("outline")}
                                openBreakdown={() => setBreakdownOpen(true)}
                              />
                            )}
                            {stage === "assets" && (
                              <StageAssets
                                doc={doc}
                                ep={nav.ep}
                                handle={projectHandle}
                                editor={assetEditor}
                                enterCanvas={() => setAssistantAsset(undefined)}
                                askAssistant={
                                  toggleAssistant
                                    ? (id) => {
                                        setAssistantAsset((previous) => ({
                                          id,
                                          selection: (previous?.selection ?? 0) + 1,
                                        }));
                                        if (!withAssistant) toggleAssistant();
                                      }
                                    : undefined
                                }
                                saved={setDoc}
                                openBreakdown={() => setBreakdownOpen(true)}
                              />
                            )}
                            {!activeEpisode && (stage === "studio" || stage === "final") && (
                              <DramaEmptyState
                                title="还没有分集"
                                description="完成研读或分集规划后，分集会出现在这里。"
                                action={{ label: "回到大纲", onClick: () => pick("outline") }}
                              />
                            )}
                            {(stage !== "overview" && stage !== "assets" && activeEpisode
                              ? [activeEpisode]
                              : []
                            ).map((ep) => (
                              <section
                                key={`${doc.episode_order ?? 0}:${ep.episode_no}`}
                                aria-label="当前分集"
                              >
                                {stage === "studio" && !panels && (
                                  <header className="drama-studio-episode-heading">
                                    <small>当前分集 · 片场准备</small>
                                    <h2>
                                      第 {ep.episode_no} 集 · {ep.title}
                                    </h2>
                                  </header>
                                )}
                                {stage === "script" && (
                                  <DramaScriptLayout
                                    episode={ep}
                                    sourceKind={doc.source?.kind}
                                    order={doc.episode_order ?? 0}
                                    access={{
                                      projectHandle,
                                      saved: acceptDocument,
                                      flush: async () => {
                                        await flushPaper.current?.();
                                      },
                                    }}
                                    scriptJob={scriptJob}
                                  >
                                    {ep.unit_from &&
                                    !ep.script_md.trim() &&
                                    ep.script_status !== "ready" ? (
                                      <div className="dp-empty">
                                        <FileText size={32} />
                                        <h3>这一集还没有剧本</h3>
                                        <p>{ep.synopsis}</p>
                                        <button
                                          type="button"
                                          onClick={() => setScriptSelection([ep.episode_no])}
                                        >
                                          生成剧本
                                        </button>
                                      </div>
                                    ) : (
                                      <EpisodePaper
                                        projectHandle={projectHandle}
                                        episode={ep}
                                        episodeOrder={doc.episode_order ?? 0}
                                        registerFlush={flushPaper}
                                        saved={(next) =>
                                          setDoc((current) =>
                                            current && current.revision > next.revision
                                              ? current
                                              : next,
                                          )
                                        }
                                        refresh={read}
                                        notify={setNotice}
                                      />
                                    )}
                                  </DramaScriptLayout>
                                )}
                                {stage === "final" && (
                                  <DramaFinalArea
                                    doc={doc}
                                    episode={ep}
                                    editor={assetEditor}
                                    projectHandle={projectHandle}
                                    saved={acceptDocument}
                                    studio={async (id) => {
                                      if (!(await flushNavigation())) return;
                                      nav.go("studio", ep.episode_no);
                                      setVideoSegment(id ?? "");
                                      setNotice("");
                                    }}
                                    select={(no) => go("final", no)}
                                  />
                                )}
                                {stage === "studio" && (
                                  <>
                                    {!ep.locked && (
                                      <section
                                        className="drama-studio-draft"
                                        aria-label="分镜片段编辑"
                                      >
                                        <header className="drama-studio-draft-heading">
                                          <div>
                                            <small>第 {ep.episode_no} 集 · 片场草稿</small>
                                            <h2>分镜片段</h2>
                                            <p>
                                              先补齐镜头提示词和时长，确认后即可进入资产拆解与生成。
                                            </p>
                                          </div>
                                          <span>未锁定</span>
                                        </header>
                                        {episodeSegments?.length ? (
                                          <ol className="drama-studio-draft-list">
                                            {episodeSegments.map((item, index) => (
                                              <li key={item.id}>
                                                <b>{String(index + 1).padStart(2, "0")}</b>
                                                <span>{item.prompt}</span>
                                                <small>{item.seconds}s</small>
                                              </li>
                                            ))}
                                          </ol>
                                        ) : (
                                          <div className="drama-studio-draft-empty">
                                            <FileText size={18} />
                                            <div>
                                              <strong>还没有分镜片段</strong>
                                              <p>从下面添加第一镜，内容会出现在片场时间线里。</p>
                                            </div>
                                          </div>
                                        )}
                                        <form
                                          className="drama-studio-draft-form"
                                          onSubmit={(event) => {
                                            event.preventDefault();
                                            const form = event.currentTarget;
                                            const data = new FormData(form);
                                            void run(async () => {
                                              const result = await window.desktop.projects.drama({
                                                projectHandle,
                                                addSegment: {
                                                  episode_no: ep.episode_no,
                                                  revision: doc.revision,
                                                  prompt: String(data.get("prompt") ?? ""),
                                                  seconds: Number(data.get("seconds")),
                                                },
                                              });
                                              if (!result.ok) {
                                                if (result.error.code === "AGENT_APPROVAL_STALE")
                                                  await read();
                                                setError(result.error.code);
                                                return;
                                              }
                                              setDoc(result.value);
                                              form.reset();
                                            });
                                          }}
                                        >
                                          <label>
                                            <span>片段提示词</span>
                                            <textarea
                                              name="prompt"
                                              required
                                              maxLength={24000}
                                              rows={2}
                                              placeholder="描述这一镜要发生什么，以及画面和动作重点"
                                            />
                                          </label>
                                          <label className="drama-studio-draft-seconds">
                                            <span>时长</span>
                                            <div>
                                              <input
                                                name="seconds"
                                                type="number"
                                                min={1}
                                                max={86400}
                                                defaultValue={5}
                                                required
                                              />
                                              <small>秒</small>
                                            </div>
                                          </label>
                                          <button type="submit" disabled={busy}>
                                            添加片段
                                          </button>
                                        </form>
                                      </section>
                                    )}
                                    {ep.locked ? (
                                      <DramaClipRow
                                        batchHost={setBatchHost}
                                        segments={episodeSegments ?? []}
                                        editor={assetEditor}
                                        handle={projectHandle}
                                        previewHost={showStudioCanvas ? null : previewHost}
                                        ratio={doc.ratio}
                                        fresh={canvas.snapshot?.freshBoards}
                                        selected={selectedSegment?.id}
                                        select={setVideoSegment}
                                        busy={busy}
                                        add={() =>
                                          void run(async () => {
                                            const result = await appendStudioClip(
                                              projectHandle,
                                              ep.episode_no,
                                              doc.revision,
                                              modelLimit,
                                            );
                                            if (!result.ok) {
                                              if (result.error.code === "AGENT_APPROVAL_STALE")
                                                await read();
                                              setError(result.error.code);
                                              return;
                                            }
                                            const saved = result.value;
                                            if (!saved) return;
                                            setDoc((current) =>
                                              current && current.revision > saved.revision
                                                ? current
                                                : saved,
                                            );
                                            const created = saved.segments?.findLast(
                                              (segment) => segment.episode_no === ep.episode_no,
                                            );
                                            if (created) setVideoSegment(created.id);
                                          })
                                        }
                                        save={async (previous, ids) => {
                                          if (selectedSegment) setVideoSegment(selectedSegment.id);
                                          try {
                                            const response = await window.desktop.projects.drama({
                                              projectHandle,
                                              reorderSegments: {
                                                episodeNo: ep.episode_no,
                                                episodeOrder: doc.episode_order ?? 0,
                                                previous,
                                                ids,
                                              },
                                            });
                                            if (!response.ok || !response.value)
                                              throw Error("排序失败");
                                            const saved = response.value;
                                            setDoc((current) =>
                                              current && current.revision > saved.revision
                                                ? current
                                                : saved,
                                            );
                                          } catch {
                                            setNotice("排序失败，已恢复原顺序");
                                            await read();
                                          }
                                        }}
                                      />
                                    ) : null}
                                    {productionKey && selectedSegment && (
                                      <DramaSegmentVideo
                                        canvasVisible={showStudioCanvas}
                                        canvasRevision={assetEditor.canvasRevision}
                                        boardOff={boardOff}
                                        setBoardOff={changeBoardReference}
                                        adaptations={studioAdaptations}
                                        batchHost={showStudioCanvas ? null : batchHost}
                                        key={`${projectHandle}:${doc.episode_order ?? 0}:${selectedSegment.id}`}
                                        episodeOrder={doc.episode_order ?? 0}
                                        toolbar={showStudioCanvas ? null : generateHost}
                                        locked={!!ep.locked}
                                        loadingModels={loadingModels}
                                        editorHost={editorHost}
                                        previewHost={previewHost}
                                        expanded={panels || videoSegment === selectedSegment.id}
                                        openBoard={openStudioCanvas}
                                        projectHandle={projectHandle}
                                        model={studioModel}
                                        options={options}
                                        resolution={resolution}
                                        segment={selectedSegment}
                                        failure={
                                          attempt?.state === "failed" ? attempt.message : undefined
                                        }
                                        ratio={doc.ratio ?? "9:16"}
                                        plugins={plugins}
                                        episodeSegments={
                                          doc.segments?.filter(
                                            (entry) => entry.episode_no === ep.episode_no,
                                          ) ?? []
                                        }
                                        imageModels={imageModels}
                                        boardSettings={doc.board_settings}
                                        settingsRevision={doc.board_settings_revision ?? 1}
                                        reload={read}
                                      />
                                    )}
                                  </>
                                )}
                              </section>
                            ))}
                          </div>
                          {scriptStep && (
                            <DramaScriptNext
                              step={scriptStep}
                              projectHandle={projectHandle}
                              order={doc.episode_order ?? 0}
                              open={openScriptAction}
                            />
                          )}
                        </div>
                      );
                      if (!panels) return content;
                      return (
                        <StudioPanels
                          key={productionKey}
                          hidden={showStudioCanvas}
                          library={
                            <StudioLibrary
                              editor={assetEditor}
                              projectHandle={projectHandle}
                              episodeNo={activeEpisode.episode_no}
                              hidden={false}
                              error={canvas.problem}
                              extracting={extractingEpisodes}
                            />
                          }
                          preview={
                            <section
                              ref={setPreviewHost}
                              className="studio-panel-scroll studio-panel-preview"
                              aria-label="片段预览"
                            />
                          }
                          editor={
                            <section
                              ref={setEditorHost}
                              className="studio-panel-scroll studio-panel-editor"
                              aria-label="片段编辑"
                            >
                              {selectedSegment && attempt ? (
                                <DramaSegmentHeading
                                  handle={projectHandle}
                                  segment={selectedSegment}
                                  attempt={attempt}
                                  order={doc.episode_order ?? 0}
                                  saved={(saved) =>
                                    setDoc((current) =>
                                      current && current.revision > saved.revision
                                        ? current
                                        : saved,
                                    )
                                  }
                                />
                              ) : (
                                <DramaEmptyState
                                  compact
                                  title="这一集还没有片段"
                                  description="点击下方时间线末尾的「+」新建第一个片段。"
                                />
                              )}
                            </section>
                          }
                        >
                          {content}
                        </StudioPanels>
                      );
                    })()
                  )}
                </div>
              </article>
              <DramaAssistant
                visible={withAssistant}
                close={toggleAssistant ?? close}
                loadingModels={loadingModels}
                projectHandle={projectHandle}
                models={textModels}
                providers={providers}
                plugins={plugins}
                refresh={read}
                beforeWrite={flushNavigation}
                document={doc}
                go={go}
                assetSelection={assistantAsset?.selection}
                context={{
                  stage,
                  ...(activeEpisode && { episodeNo: activeEpisode.episode_no }),
                  episodeOrder: doc.episode_order ?? 0,
                  ...(stage === "studio" &&
                    selectedSegment && {
                      segmentId: selectedSegment.id,
                      segmentNumber: selectedSegment.seq + 1,
                    }),
                  ...(selectedAssistantAsset &&
                    assistantAssetMeta && {
                      assetId: selectedAssistantAsset.id,
                      assetName: assistantAssetMeta.name,
                    }),
                }}
              />
            </div>
          )}
        </main>
      </DramaSaveStatus.Provider>
    </DramaFlushers.Provider>
  );
}
