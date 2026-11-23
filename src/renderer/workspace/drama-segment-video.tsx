import {
  type DramaDocument,
  dramaVideoModelIssue,
  type GenerationJob,
  jobFailureReason,
  jobIsTerminal,
  modelGenerationOptions,
  type PluginView,
  type ProviderView,
} from "@link-studio/core";
import { useEffect, useState } from "react";
import { ChoiceButton } from "../choice-button";
import { DramaBoardStage } from "./drama-board-stage";
import { DramaReferenceBar } from "./drama-reference-bar";
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

export function DramaSegmentVideo({
  projectHandle,
  projectId,
  segment,
  episodeSegments,
  models,
  preferredModel,
  imageModels,
  boardSettings,
  settingsRevision,
  plugins,
  ratio,
  reload,
}: {
  projectHandle: string;
  projectId: string;
  segment: Segment;
  episodeSegments: Segment[];
  boardSettings: DramaDocument["board_settings"];
  settingsRevision: number;
  models: ProviderView[];
  preferredModel?: string;
  imageModels: ProviderView[];
  plugins: PluginView[];
  ratio: string;
  reload: () => Promise<void>;
}) {
  const preferenceKey = `drama-studio:${projectId}:video-model`;
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
    } catch {
      return;
    }
  }
  const [context, setContext] = useState<Awaited<ReturnType<typeof referenceContext>>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [boardOff, setBoardOff] = useState(false);
  const [view, setView] = useState<"board" | "video">(segment.chosen_task_id ? "video" : "board");
  const [refresh, setRefresh] = useState(0);
  const nodeId = `seg:${segment.id}`;
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
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
  }, [nodeId, projectHandle, refresh, reload, segment.prompt]);
  const issues = new Map(models.map((model) => [model.id, dramaVideoModelIssue(model, plugins)]));
  const usable = models.filter((model) => !issues.get(model.id));
  const model =
    usable.find((entry) => entry.id === providerId) ??
    usable.find((entry) => entry.id === preferredModel) ??
    usable[0];
  const adapter = plugins.find((entry) => entry.hash === model?.pluginHash);
  const options =
    model &&
    modelGenerationOptions(
      "video",
      adapter?.origin === "builtin" ? adapter.key : undefined,
      model.model,
      model.channel,
      model.config,
    );
  const planFor = (current: Awaited<ReturnType<typeof referenceContext>>) =>
    options &&
    dramaVideoInput(
      segment.prompt,
      segment.seconds,
      ratio,
      options,
      current.graph.canvas,
      current.assets,
      current.jobs,
      { segmentId: segment.id, sourceHash: current.sourceHash, off: boardOff },
    );
  const preview = context && planFor(context);
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
  async function generate() {
    if (!model || busy) return;
    setBusy(true);
    setError("");
    try {
      const current = await referenceContext(projectHandle, segment.prompt);
      setContext(current);
      const plan = planFor(current);
      if (!plan || plan.errors.length) return;
      const result = await window.desktop.projects.submitJob({
        projectHandle,
        confirmed: true,
        operationId: crypto.randomUUID(),
        generation: {
          purpose: "drama-segment",
          nodeId,
          expectedCanvasRevision: current.graph.canvasRevision,
          providerId: model.id,
          expectedProviderRevision: model.revision,
          ...plan.input,
        },
      });
      if (!result.ok) throw Error(result.error.message);
      await reload();
      setRefresh((value) => value + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "生成请求失败");
    } finally {
      setBusy(false);
    }
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
  const aspect = extra === undefined && Number.isFinite(quotient) && quotient > 0 ? quotient : 9 / 16;
  return (
    <section aria-label="片段视频">
      <div className="drama-preview-switch" role="radiogroup" aria-label="预览">
        <ChoiceButton
          type="button"
          role="radio"
          aria-checked={view === "board"}
          onClick={() => setView("board")}
        >
          故事板
        </ChoiceButton>
        <ChoiceButton
          type="button"
          role="radio"
          aria-checked={view === "video"}
          onClick={() => setView("video")}
        >
          视频
        </ChoiceButton>
      </div>
      {view === "board" && context && (
        <DramaBoardStage
          projectHandle={projectHandle}
          segment={segment}
          episodeSegments={episodeSegments}
          models={imageModels}
          plugins={plugins}
          context={context}
          settings={boardSettings}
          settingsRevision={settingsRevision}
          read={(prompt = segment.prompt) => referenceContext(projectHandle, prompt)}
          refresh={() => setRefresh((value) => value + 1)}
        />
      )}
      {view === "video" && (
        <>
          {takes.length > 0 && (
            <TakeCarousel
              takes={takes}
              chosenTaskId={segment.chosen_task_id ?? ""}
              aspect={aspect}
              onChoose={(taskId) => void choose(taskId)}
            />
          )}
          <label>
            视频模型{" "}
            <select
              value={model?.id ?? ""}
              onChange={(event) => pickProvider(event.currentTarget.value)}
            >
              {!usable.length && <option value="">暂无可用视频模型</option>}
              {models.map((entry) => (
                <option
                  key={entry.id}
                  value={entry.id}
                  disabled={!!issues.get(entry.id)}
                  title={issues.get(entry.id)}
                >
                  {entry.config?.name ?? entry.label}
                </option>
              ))}
            </select>
          </label>
          {preview && (
            <DramaReferenceBar
              plan={preview}
              projectHandle={projectHandle}
              setBoardOff={setBoardOff}
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
          <button
            type="button"
            disabled={
              !preview ||
              !!preview.errors.length ||
              busy ||
              jobs.some((job) => !jobIsTerminal(job.status))
            }
            onClick={() => void generate()}
          >
            生成视频
          </button>
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
