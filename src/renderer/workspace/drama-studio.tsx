import type {
  CanvasAgentAction,
  CanvasAgentValues,
  DramaDocument,
  DramaImageParams,
  DramaSourcePreview,
  DramaStartRatio,
  PluginView,
  ProviderView,
} from "@link-studio/core";
import {
  canvasAgentMediaModels,
  defaultDramaStyle,
  dramaAgentModels,
  dramaAssetSlots,
  dramaImageFields,
  dramaVideoModelIssue,
  settleDramaImageParams,
} from "@link-studio/core";
import { ArrowUp, FileText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AssistantTimeline } from "../assistant/activity-timeline";
import {
  AssistantCompactionStatus,
  AssistantHeading,
  AssistantStatus,
  AssistantTranscript,
  submitShortcut,
} from "../assistant/assistant-panel";
import { AssistantPreferences, AssistantReply } from "../assistant/assistant-preferences";
import { useAssistantAction, useAssistantSession } from "../assistant/use-assistant-session";
import { Activity } from "../settings/settings-assistant";
import { settingsError } from "../settings/settings-page";
import { CanvasAssistantEmpty } from "./assistant-empty";
import { AssistantHistory } from "./assistant-history";
import { AssistantQuestionnaire, QuestionRecord } from "./assistant-questionnaire";
import { AssistantSkillMenu, useCanvasSkills } from "./assistant-skill-menu";
import { DramaStartModel } from "./drama-start-model";
import { DramaStartParams } from "./drama-start-params";
import { emptyStartImages, loadDramaStartPrefs, saveDramaStartPrefs } from "./drama-start-prefs";
import { PromptEditor, PromptRows, useStartPrompts } from "./drama-start-prompts";
import { DramaStartStyle, FieldMenu } from "./drama-start-style";
import "./drama-studio.css";
import { AssistantContextRing } from "../assistant/assistant-context-ring";
import { AssistantModelState } from "../assistant/assistant-model-state";
import { type DramaAssetEditor, StageAssets } from "./drama-asset-browser";
import { DramaContinueDialog } from "./drama-continue-dialog";
import { EpisodePaper } from "./drama-episode-paper";
import { type DramaPage, EpisodeRail } from "./drama-episode-rail";
import { DramaProjectSettings } from "./drama-project-settings";
import { DramaScriptNext, scriptNextStep } from "./drama-script-next";
import { DramaScriptsDialog } from "./drama-scripts-dialog";
import { DramaSegmentVideo } from "./drama-segment-video";
import { StageOverview, stageHints, useStageCanvas } from "./drama-stage-areas";
import { DramaStageTabs } from "./drama-stage-tabs";
import { DramaStoryboardGate, storyboardSeconds } from "./drama-storyboard-gate";
import { DramaStudioGate, studioPrerequisite } from "./drama-studio-gate";
import { TakeVideo } from "./drama-take-carousel";
import { type Stage, stages, useDramaNav } from "./drama-workspace-nav";
import { parsePrompt } from "./prompt-tokens";

export function DramaStudio({
  projectHandle,
  projectId,
  withAssistant,
  providers,
  loadingModels,
  plugins,
  assetEditor,
  close,
}: {
  projectHandle: string;
  projectId: string;
  withAssistant: boolean;
  providers: ProviderView[];
  loadingModels: boolean;
  plugins: PluginView[];
  assetEditor: DramaAssetEditor;
  close: () => void;
}) {
  const [doc, setDoc] = useState<DramaDocument | null>();
  const flushPaper = useRef<(() => Promise<void>) | null>(null);
  const nav = useDramaNav(doc, projectId),
    { stage } = nav,
    page = nav.paper ?? nav.ep,
    [notice, setNotice] = useState("");
  const canvas = useStageCanvas(projectHandle, doc);
  const activeEpisode =
    typeof page === "number" ? doc?.episodes.find((item) => item.episode_no === page) : undefined;
  const prerequisite = stage === "studio" && doc ? studioPrerequisite(doc, activeEpisode) : null;
  const storyboardGate =
    stage === "studio" &&
    activeEpisode &&
    (activeEpisode.storyboard_status === "generating" ||
      (activeEpisode.locked &&
        activeEpisode.storyboard_status !== "ready" &&
        (activeEpisode.storyboard_status === "failed" ||
          !doc?.segments?.some((segment) => segment.episode_no === activeEpisode.episode_no))));
  const [videoSegment, setVideoSegment] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scriptSelection, setScriptSelection] = useState<number[]>();
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [continueOpen, setContinueOpen] = useState(false);
  const mediaModels = canvasAgentMediaModels({ providers, plugins });
  const imageModels = mediaModels
    .filter((entry) => entry.kind === "image")
    .map((entry) => entry.provider);
  const videoModels = mediaModels
    .filter((entry) => entry.kind === "video")
    .map((entry) => entry.provider);
  const storyboardLimit =
    activeEpisode && stage === "studio"
      ? storyboardSeconds(projectId, doc?.video_model, videoModels, plugins)
      : 15;
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
    ? { value: preflight, error: undefined, code: undefined }
    : preview?.key === previewKey
      ? preview
      : undefined;
  const sourceUnits = currentPreview?.value ?? preview?.value ?? preflight;
  const modelBlocked = currentPreview?.code === "DRAMA_CONTEXT";
  const startBlock = !sourceKind
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
    if (response.ok) setDoc(response.value);
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
  function go(target: Stage, no?: number) {
    nav.go(target, no);
    setNotice("");
    setVideoSegment("");
  }
  function pick(next: DramaPage) {
    nav.pick(next);
    setNotice("");
    setVideoSegment("");
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
      if (/^[1-5]$/.test(event.key)) go((Object.keys(stages) as Stage[])[Number(event.key) - 1]!);
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
  return (
    <main className="drama-studio" aria-label="短剧工作室">
      <header>
        <button type="button" onClick={close}>
          返回画布
        </button>
        <h1>{doc?.title ?? "短剧工作室"}</h1>
        {doc && (
          <DramaStageTabs
            stage={stage}
            hints={stageHints(doc, canvas.snapshot?.freshBoards)}
            go={go}
          />
        )}
        {doc && (
          <button type="button" onClick={() => setSettingsOpen(true)}>
            项目设置
          </button>
        )}
      </header>
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
      {doc && breakdownOpen && (
        <DramaScriptsDialog
          mode="breakdown"
          projectHandle={projectHandle}
          doc={doc}
          initial={[]}
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
      {error && !setupOpen && <p role="alert">{settingsError(error)}</p>}
      {doc === undefined ? (
        error ? (
          <button type="button" onClick={() => void read()}>
            重试读取
          </button>
        ) : (
          <p>正在读取短剧…</p>
        )
      ) : doc === null ? (
        <div className="drama-source">
          <fieldset disabled={busy}>
            <div role="group" aria-label="剧本来源">
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
                onClick={() => sourceTab !== "paste" && changeSource(() => setSourceTab("paste"))}
              >
                粘贴正文
              </button>
            </div>
            {sourceTab === "file" ? (
              <div
                className="drama-file-drop"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
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
                <span>{file?.name ?? "拖入剧本文件，或"}</span>
                {file && (
                  <small>
                    {file.size >= 1024 * 1024
                      ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
                      : `${(file.size / 1024).toFixed(1)} KB`}
                  </small>
                )}
                <button type="button" onClick={() => fileInput.current?.click()}>
                  {file ? "更换" : "选择文件"}
                </button>
                {file && (
                  <button type="button" onClick={() => changeSource(() => setFile(null))}>
                    移除
                  </button>
                )}
              </div>
            ) : (
              <label>
                粘贴正文
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
                    const initialSeconds = String(prefs.seconds);
                    setSourceProblem("");
                    const result = preflight
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
                      setSourceProblem(result.error.message ?? settingsError(result.error.code));
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
            <p role="alert">{sourceProblem || pasteProblem}</p>
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
                  if (!sourceKind || !sourceToken || startBlock || busy || !prompts.ready) return;
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
                      setSourceProblem(result.error.message ?? settingsError(result.error.code));
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
                      sourceKind === "novel" ? "小说" : sourceKind === "script" ? "剧本" : "请选择"
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
                              {preflight.issues.map((issue, index) => (
                                <li key={index}>{issue.message}</li>
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
                        <span className="drama-start-episodes">剧本一次切完 · {countLabel} 集</span>
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
                                研读与规划约{" "}
                                <em>{previousEstimate.credits.toLocaleString("en-US")}</em> 积分
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
                      {currentPreview?.error && !modelBlocked && (
                        <p role="alert">{currentPreview.error}</p>
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
                  {modelBlocked && <p role="alert">{currentPreview.error}</p>}
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
                <PromptRows library={prompts} container={dialog} script={sourceKind === "script"} />
                {sourceProblem && <p role="alert">{sourceProblem}</p>}
                {error && <p role="alert">{settingsError(error)}</p>}
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
            {setupOpen && prompts.draft && <PromptEditor draft={prompts.draft} library={prompts} />}
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
                    const no = result.value.episodes.at(-1)!.episode_no;
                    setDoc(result.value);
                    nav.go("script", no);
                    setVideoSegment("");
                    setNotice(`已新增第 ${no} 集，可以直接手写剧本`);
                  })
                }
              />
            )}{" "}
            {prerequisite ? (
              <DramaStudioGate
                kind={prerequisite}
                no={nav.ep}
                go={go}
                openBreakdown={() => setBreakdownOpen(true)}
              />
            ) : storyboardGate && activeEpisode ? (
              <DramaStoryboardGate
                key={`${projectHandle}:${doc.episode_order ?? 0}:${activeEpisode.episode_no}:${storyboardLimit}`}
                doc={doc}
                episode={activeEpisode}
                projectHandle={projectHandle}
                maxSeconds={storyboardLimit}
                saved={setDoc}
              />
            ) : (
              <div className={scriptStep ? "drama-script-frame" : "drama-stage-frame"}>
                <div className="drama-script-area">
                  {notice && <p aria-live="polite">{notice}</p>}
                  {doc.planning && (
                    <section aria-label="小说规划">
                      <p>
                        {doc.planning.phase === "paused"
                          ? doc.planning.pause_reason
                          : doc.planning.phase === "done"
                            ? "规划完成"
                            : doc.planning.summary
                              ? "正在规划"
                              : "正在研读"}{" "}
                        · 已规划 {doc.planning.cursor} / {doc.planning.end}
                      </p>
                      {doc.planning.phase !== "done" && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              const result = await window.desktop.projects.drama({
                                projectHandle,
                                planningAction:
                                  doc.planning?.phase === "paused" ? "resume" : "pause",
                              });
                              if (result.ok) setDoc(result.value);
                              else setError(result.error.message ?? result.error.code);
                            })
                          }
                        >
                          {doc.planning.phase === "paused" ? "恢复规划" : "暂停规划"}
                        </button>
                      )}
                      {doc.planning.phase === "paused" &&
                        doc.planning.pause_code === "custom_prompt" && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                const result = await window.desktop.projects.drama({
                                  projectHandle,
                                  planningAction: "retry-builtin",
                                });
                                if (result.ok) setDoc(result.value);
                                else setError(result.error.message ?? result.error.code);
                              })
                            }
                          >
                            改用内置重试
                          </button>
                        )}
                    </section>
                  )}
                  {doc.jobs?.length ? (
                    <section aria-label="短剧任务">
                      {doc.jobs.map((job) => (
                        <p key={job.id}>
                          {
                            {
                              breakdown: "资产拆解",
                              asset_prompts: "资产提示词",
                              scripts: "分集剧本",
                              storyboard: "分镜脚本",
                              compose: "合成整集",
                            }[job.step]
                          }{" "}
                          ·{" "}
                          {
                            {
                              queued: "排队中",
                              running: "运行中",
                              succeeded: "已完成",
                              failed: "失败",
                              canceled: "已取消",
                            }[job.status]
                          }{" "}
                          {job.error_message}
                        </p>
                      ))}
                    </section>
                  ) : null}
                  {page === "outline" && (
                    <>
                      <h2>故事大纲</h2>
                      <p>{doc.outline_md || "暂无大纲"}</p>
                    </>
                  )}
                  {page === "characters" && (
                    <>
                      <h2>人物传记</h2>
                      <p>{doc.characters_md || "暂无人物传记"}</p>
                    </>
                  )}
                  {stage === "overview" && (
                    <StageOverview
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
                      saved={setDoc}
                      openBreakdown={() => setBreakdownOpen(true)}
                    />
                  )}
                  {scriptStep?.kind === "breakdown" && doc.planning && (
                    <button
                      type="button"
                      disabled={!!scriptStep.blocked}
                      onClick={() => openScriptAction("scripts", true)}
                    >
                      重新生成分集剧本
                    </button>
                  )}
                  {!activeEpisode && (stage === "studio" || stage === "final") && <p>还没有分集</p>}
                  {(stage !== "overview" && stage !== "assets" && activeEpisode
                    ? [activeEpisode]
                    : []
                  ).map((ep) => (
                    <section
                      key={`${doc.episode_order ?? 0}:${ep.episode_no}`}
                      aria-label="当前分集"
                    >
                      <h2>
                        第 {ep.episode_no} 集 · {ep.title}
                      </h2>
                      {stage === "script" && (
                        <>
                          <p>{ep.synopsis}</p>
                          {doc.jobs?.some(
                            (job) =>
                              job.step === "scripts" &&
                              ["queued", "running"].includes(job.status) &&
                              job.episodes.includes(ep.episode_no),
                          ) ? (
                            <p>正在生成这一集的剧本…</p>
                          ) : ep.unit_from &&
                            !ep.script_md.trim() &&
                            ep.script_status !== "ready" ? (
                            <div>
                              <p>这一集还没有剧本</p>
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
                                  current && current.revision > next.revision ? current : next,
                                )
                              }
                              refresh={read}
                              notify={setNotice}
                            />
                          )}
                        </>
                      )}
                      {stage === "final" && !ep.final_asset_id && (
                        <>
                          <h3>第 {ep.episode_no} 集还没有成片</h3>
                          <button type="button" onClick={() => go("studio", ep.episode_no)}>
                            去片场
                          </button>
                        </>
                      )}
                      {stage === "final" && ep.final_asset_id && (
                        <section aria-label="本集成片">
                          <h3>
                            {ep.segment_version === ep.final_segment_version
                              ? "成片已合成"
                              : "成片已过期，可重新合成"}
                          </h3>
                          <TakeVideo
                            key={ep.final_asset_id}
                            asset={{ projectHandle, assetId: ep.final_asset_id }}
                          />
                        </section>
                      )}
                      {stage === "studio" && (
                        <>
                          <h3>分镜片段</h3>
                          {ep.locked && ep.storyboard_status === "ready" && (
                            <DramaStoryboardGate
                              toolbar
                              key={`${projectHandle}:${doc.episode_order ?? 0}:${ep.episode_no}:${storyboardLimit}`}
                              doc={doc}
                              episode={ep}
                              projectHandle={projectHandle}
                              maxSeconds={storyboardLimit}
                              saved={setDoc}
                            />
                          )}
                          <ol>
                            {doc.segments
                              ?.filter((item) => item.episode_no === ep.episode_no)
                              .map((item) => (
                                <li key={item.id}>
                                  {ep.locked ? (
                                    <button
                                      type="button"
                                      aria-expanded={videoSegment === item.id}
                                      onClick={() =>
                                        setVideoSegment((value) =>
                                          value === item.id ? "" : item.id,
                                        )
                                      }
                                    >
                                      {parsePrompt(item.prompt)
                                        .map((part) =>
                                          part.type === "text" ? part.text : part.label,
                                        )
                                        .join("")}{" "}
                                      · {item.seconds} 秒
                                    </button>
                                  ) : (
                                    <>
                                      {item.prompt} · {item.seconds} 秒
                                    </>
                                  )}
                                  {videoSegment === item.id && (
                                    <DramaSegmentVideo
                                      projectHandle={projectHandle}
                                      projectId={projectId}
                                      segment={item}
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
                                      models={videoModels}
                                      preferredModel={doc.video_model}
                                      reload={read}
                                    />
                                  )}
                                </li>
                              ))}
                          </ol>
                          <form
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
                                  if (result.error.code === "AGENT_APPROVAL_STALE") await read();
                                  setError(result.error.code);
                                  return;
                                }
                                setDoc(result.value);
                                form.reset();
                              });
                            }}
                          >
                            <label>
                              片段提示词
                              <textarea name="prompt" required maxLength={24000} rows={2} />
                            </label>
                            <label>
                              片段秒数
                              <input
                                name="seconds"
                                type="number"
                                min={1}
                                max={86400}
                                defaultValue={5}
                                required
                              />
                            </label>
                            <button type="submit" disabled={busy}>
                              添加片段
                            </button>
                          </form>
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
            )}
          </article>
          {withAssistant &&
            (loadingModels || !textModels.length ? (
              <aside
                className="assistant-surface drama-assistant drama-model-state"
                aria-label="短剧助手"
              >
                <AssistantModelState loading={loadingModels} />
              </aside>
            ) : (
              <DramaAssistant
                projectHandle={projectHandle}
                providers={providers}
                plugins={plugins}
                refresh={read}
              />
            ))}
        </div>
      )}
    </main>
  );
}

function DramaAssistant({
  projectHandle,
  providers,
  plugins,
  refresh,
}: {
  projectHandle: string;
  providers: ProviderView[];
  plugins: PluginView[];
  refresh: () => Promise<void>;
}) {
  const models = providers.filter(
    (model) =>
      model.enabled && model.channelEnabled !== false && model.hasSecret && model.agentEnabled,
  );
  const [modelId, setModel] = useState("");
  const model = models.find((item) => item.id === modelId) ?? models[0];
  const [sessions, setSessions] = useState<CanvasAgentValues["list"]>();
  const [listAttempt, setListAttempt] = useState(0);
  const [session, setSession] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [explanation, setExplanation] = useState<{ id: string; text: string }>();
  const message = drafts[session] ?? "";
  const setMessage = (text: string) => setDrafts((previous) => ({ ...previous, [session]: text }));
  const editor = useRef<HTMLTextAreaElement>(null);
  const skillCatalog = useCanvasSkills(true);
  const [error, setError] = useState("");
  const { busy, run } = useAssistantAction(setError);
  const invoke = useCallback(
    async <Action extends CanvasAgentAction>(action: Action) => {
      const result = await window.desktop.projects.canvasAgent({
        projectHandle,
        mode: "drama",
        action,
      });
      if (!result.ok) throw new Error(result.error.code);
      return result.value as CanvasAgentValues[Action["method"]];
    },
    [projectHandle],
  );
  useEffect(() => {
    let live = true;
    if (listAttempt) setError("");
    void invoke({ method: "list" }).then(
      (list) => {
        if (live) {
          setSessions(list);
          setSession(list[0]?.id ?? "");
        }
      },
      (cause) => {
        if (live) setError(cause instanceof Error ? cause.message : "AGENT_STATE_UNAVAILABLE");
      },
    );
    return () => {
      live = false;
    };
  }, [invoke, listAttempt]);
  const read = useCallback(
    async (sessionId: string, after: number, before?: number) => ({
      ok: true as const,
      value: await invoke({ method: "state", sessionId, after, before }),
    }),
    [invoke],
  );
  const { events, state, readError, refreshSession, history } = useAssistantSession(session, read);
  const title = state?.title;
  useEffect(() => {
    if (title)
      setSessions((current) =>
        current?.map((entry) => (entry.id === session ? { ...entry, title } : entry)),
      );
  }, [session, title]);
  const decided = events.findLast((event) => event.type === "approval.decided");
  const lastRun = events.findLast((event) => event.type === "run.status");
  const resumable =
    lastRun &&
    ["interrupted", "step_limit"].includes(
      String((lastRun.payload as { status?: string })?.status),
    );
  useEffect(() => {
    if (decided) void refresh();
  }, [decided, refresh]);
  const locked = busy || !sessions || (!!session && !state) || !!readError;
  const create = async () => {
    const { sessionId } = await invoke({ method: "create" });
    setSessions((current) => [{ id: sessionId, title: "新对话" }, ...(current ?? [])]);
    setSession(sessionId);
    return sessionId;
  };
  const stop = () =>
    void run(async () => {
      if (!state?.activeRun) return;
      await invoke({ method: "stop", sessionId: session, runId: state.activeRun });
      await refreshSession();
    });
  const send = () =>
    run(async () => {
      if (!model || locked || !message.trim() || state?.otherActiveSession) return;
      const sessionId = session || (await create());
      await invoke({
        method: "send",
        providerId: model.id,
        sessionId,
        message: message.trim(),
        selection: [],
        runId: state?.activeRun,
      });
      setMessage("");
      await refreshSession();
    });
  return (
    <aside
      className="assistant-surface drama-assistant"
      aria-label="短剧助手"
      onKeyDown={(event) => {
        if (
          event.key !== "Escape" ||
          event.defaultPrevented ||
          event.repeat ||
          event.nativeEvent.isComposing ||
          locked ||
          !state?.activeRun ||
          state.approvals.length ||
          message.trim() ||
          document.querySelector(":popover-open,dialog[open],select:open")
        )
          return;
        event.preventDefault();
        stop();
      }}
    >
      <AssistantHeading
        title={
          <AssistantHistory
            key={session}
            current={session}
            sessions={sessions ?? []}
            title={title ?? sessions?.find((entry) => entry.id === session)?.title ?? "新对话"}
            locked={locked || !!state?.activeRun}
            select={setSession}
            rename={(next) =>
              void run(async () => {
                const result = await invoke({ method: "rename", sessionId: session, title: next });
                setSessions((current) =>
                  current?.map((entry) =>
                    entry.id === session ? { ...entry, title: result.title } : entry,
                  ),
                );
                await refreshSession();
              })
            }
            remove={(id) =>
              void run(async () => {
                const result = await invoke({ method: "remove", sessionId: id });
                if (!result.removed) return;
                const remaining = sessions?.filter((entry) => entry.id !== id) ?? [];
                setSessions(remaining);
                setDrafts((current) => {
                  const next = { ...current };
                  delete next[id];
                  return next;
                });
                if (id === session) setSession(remaining[0]?.id ?? "");
              })
            }
          />
        }
      >
        <button
          type="button"
          disabled={locked || !!state?.activeRun}
          onClick={() => {
            setError("");
            setSession("");
          }}
        >
          新对话
        </button>
        <AssistantPreferences />
      </AssistantHeading>
      <AssistantStatus
        state={state}
        stale={!!readError || (!sessions && !!error)}
        busy={busy}
        opening={
          (!sessions && !error) || history.phase === "latest" || history.phase === "latest-error"
        }
      />
      {state?.otherActiveSession && (
        <button type="button" onClick={() => setSession(state.otherActiveSession ?? "")}>
          返回运行中的会话
        </button>
      )}
      <AssistantTranscript
        history={history}
        loadingSessions={!sessions && !error}
        label="短剧对话与活动"
        sessionId={session}
        empty={
          !events.length && !locked ? (
            <CanvasAssistantEmpty
              drama
              hasModel
              onStarter={(text) => {
                setMessage(text);
                editor.current?.focus();
              }}
            />
          ) : undefined
        }
      >
        <AssistantTimeline
          model={model}
          events={events}
          render={(event) => {
            const payload = event.payload as Record<string, unknown> | null;
            return event.type === "approval.decided" && payload?.kind === "ask" ? (
              <QuestionRecord key={event.seq} payload={payload} providers={providers} />
            ) : (
              <Activity key={event.seq} event={event} />
            );
          }}
        />
        {state?.partial && (
          <AssistantReply
            streaming
            text={state.partial.text}
            thinking={state.partial.hasThinking}
          />
        )}
        <AssistantCompactionStatus state={state} events={events} />
      </AssistantTranscript>
      {state?.approvals.map((approval) => {
        if (approval.kind === "ask")
          return (
            <AssistantQuestionnaire
              key={approval.id}
              payload={approval.payload}
              busy={locked}
              models={canvasAgentMediaModels({ providers, plugins })}
              onAnswer={(answers) =>
                void run(async () => {
                  await invoke({
                    method: "answer",
                    sessionId: session,
                    approvalId: approval.id,
                    ...(answers ? { answers } : {}),
                  });
                  await refreshSession();
                })
              }
            />
          );
        const payload = approval.payload as {
          title: string;
          reason: string;
          before: Record<string, string | number>;
          after: Record<string, string | number>;
        };
        const job =
          approval.kind === "drama_run_job"
            ? (approval.payload as {
                before: string;
                after: string;
                estimate: number;
              })
            : undefined;
        return (
          <section className="settings-confirm" key={approval.id}>
            <h3>{payload.title}</h3>
            <p>{payload.reason}</p>
            {job ? (
              <div aria-label="修改前后">
                <div>
                  <strong>修改前</strong>
                  <del>{job.before}</del>
                </div>
                <div>
                  <strong>修改后</strong>
                  <ins>{job.after}</ins>
                </div>
              </div>
            ) : (
              Object.entries(payload.after).map(([field, text]) => (
                <div key={field}>
                  <strong>
                    {{
                      title: "标题",
                      script_md: "剧本",
                      synopsis: "梗概",
                      outline_md: "大纲",
                      characters_md: "人物传记",
                      prompt: "提示词",
                      seconds: "秒数",
                    }[field] ?? field}
                  </strong>
                  <del>{payload.before[field] || "空"}</del>
                  <ins>{text}</ins>
                </div>
              ))
            )}
            {(job
              ? ["批准修改", "不用了", "不用了，并告诉 Agent 怎么改…"]
              : ["保留原文", "批准修改"]
            ).map((label) => (
              <button
                key={label}
                type="button"
                disabled={locked}
                onClick={() =>
                  void run(async () => {
                    if (label.endsWith("…") && explanation?.id !== approval.id) {
                      setExplanation({ id: approval.id, text: "" });
                      return;
                    }
                    await invoke({
                      method: "decide",
                      sessionId: session,
                      approvalId: approval.id,
                      selected: label === "批准修改" ? [0] : [],
                      ...(label.endsWith("…") && { answer: explanation?.text }),
                    });
                    setExplanation(undefined);
                    await refreshSession();
                    await refresh();
                  })
                }
              >
                {label.endsWith("…") && explanation?.id === approval.id ? "提交说明" : label}
                {label === "批准修改" && job && job.estimate > 0 && ` ✦ ${job.estimate}`}
              </button>
            ))}
            {job && explanation?.id === approval.id && (
              <input
                aria-label="拒绝说明"
                autoFocus
                maxLength={2000}
                placeholder="比如：只改结尾，保留前两段"
                value={explanation.text}
                onChange={(event) => setExplanation({ id: approval.id, text: event.target.value })}
              />
            )}
          </section>
        );
      })}
      {(error || (readError && history.phase !== "latest-error")) && (
        <p role="alert">{settingsError(error || readError || "AGENT_STATE_UNAVAILABLE")}</p>
      )}
      {!sessions && error && (
        <button type="button" onClick={() => setListAttempt((attempt) => attempt + 1)}>
          重试读取会话
        </button>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label>
          短剧消息
          <textarea
            ref={editor}
            rows={3}
            maxLength={24000}
            value={message}
            onKeyDown={submitShortcut}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
        <div className="drama-composer-actions">
          <select
            aria-label="对话模型"
            value={model?.id ?? ""}
            onChange={(event) => setModel(event.target.value)}
            disabled={!!state?.activeRun}
          >
            {models.map((entry) => (
              <option value={entry.id} key={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
          <AssistantSkillMenu
            catalog={skillCatalog}
            editor={editor}
            disabled={locked || !!state?.activeRun}
            pick={(skill) => {
              const start = editor.current?.selectionStart ?? message.length,
                end = editor.current?.selectionEnd ?? start;
              const token = `@[${skill.title}](skill:${skill.id}) `;
              if (message.length - end + start + token.length <= 24000) {
                setMessage(message.slice(0, start) + token + message.slice(end));
                requestAnimationFrame(() =>
                  editor.current?.setSelectionRange(start + token.length, start + token.length),
                );
              }
            }}
          />
          <AssistantContextRing events={events} model={model} />
          <button
            type="submit"
            disabled={locked || !model || !message.trim() || !!state?.otherActiveSession}
          >
            {state?.activeRun ? "插话" : "发送"}
          </button>
        </div>
        {state?.activeRun && (
          <button type="button" disabled={locked} onClick={stop}>
            停止
          </button>
        )}
        {resumable && !state?.activeRun && (
          <button
            type="button"
            disabled={locked || !!state?.otherActiveSession}
            onClick={() =>
              void run(async () => {
                await invoke({ method: "continue", runId: lastRun.runId, sessionId: session });
                await refreshSession();
              })
            }
          >
            继续运行
          </button>
        )}
      </form>
    </aside>
  );
}
