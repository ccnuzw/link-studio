import {
  type CanvasShot,
  type CreativeData,
  cameraMoves,
  type GenerationInput,
  type GenerationJob,
  modelGenerationModes,
  modelGenerationOptions,
  type ProviderView,
  type SettingsValues,
  shotSizes,
} from "@link-studio/core";
import { ArrowDown, ArrowUp, Copy, Plus, Trash2, WandSparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { generationStatuses } from "./generation";

type MediaKind = "image" | "video";
type LinkedNode = { id: string; data: CreativeData };
type BatchTarget = Pick<GenerationInput, "nodeId" | "prompt" | "duration">;
type MediaOptions = ReturnType<typeof modelGenerationOptions>;

function allowsDuration(options: MediaOptions, duration: number) {
  if (!Number.isInteger(duration) || duration < 1 || duration > 30) return false;
  if (options.durations.length) return options.durations.includes(duration);
  const range = options.durationRange;
  return range ? duration >= range.min && duration <= range.max : options.manualDuration;
}

export function StoryboardDialog({
  initial,
  linkedNodes,
  jobs,
  settings,
  submit,
  sourceText,
  submitSplit,
  canSplit,
  save,
  close,
}: {
  initial: CanvasShot[];
  linkedNodes: Record<MediaKind, LinkedNode[]>;
  jobs: GenerationJob[];
  settings: SettingsValues["list"];
  submit: (targets: BatchTarget[], provider: ProviderView) => Promise<string | undefined>;
  sourceText: string;
  submitSplit: (
    prompt: string,
    provider: ProviderView,
    mode: "replace" | "append",
  ) => Promise<string | undefined>;
  canSplit: (shots: CanvasShot[], kind: MediaKind) => boolean;
  save: (shots: CanvasShot[], split?: MediaKind) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const edited = useRef(false);
  const [shots, setShots] = useState(initial);
  const [invalidDuration, setInvalidDuration] = useState<string[]>([]);
  const [kind, setKind] = useState<MediaKind>(linkedNodes.image.length ? "image" : "video");
  const [picked, setPicked] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [batchError, setBatchError] = useState("");
  const [splitError, setSplitError] = useState("");
  const [splitSubmitting, setSplitSubmitting] = useState(false);
  const [splitMode, setSplitMode] = useState<"replace" | "append">("append");
  const [splitPicked, setSplitPicked] = useState("");
  const models = settings.providers.flatMap((provider) => {
    const plugin = settings.plugins.find(({ hash }) => hash === provider.pluginHash);
    const textMode = kind === "image" ? "t2i" : "t2v";
    if (
      !(
        provider.enabled &&
        provider.channelEnabled !== false &&
        plugin?.kind === kind &&
        !plugin.disabled &&
        provider.config?.kind !== "agent" &&
        (plugin.auth === "none" || provider.hasSecret) &&
        (provider.config?.modes?.includes(textMode) ?? true)
      )
    )
      return [];
    const options = modelGenerationOptions(
      kind,
      plugin.origin === "builtin" ? plugin.key : undefined,
      provider.model,
      provider.channel,
      provider.config,
    );
    return modelGenerationModes(kind, options).includes(textMode) ? [{ provider, options }] : [];
  });
  const selected = models.find(({ provider }) => provider.id === picked) ?? models[0];
  const model = selected?.provider;
  const textModels = settings.providers.flatMap((provider) => {
    const plugin = settings.plugins.find(({ hash }) => hash === provider.pluginHash);
    return provider.enabled &&
      provider.channelEnabled !== false &&
      plugin?.kind === "text" &&
      !plugin.disabled &&
      provider.config?.kind !== "agent" &&
      (plugin.auth === "none" || provider.hasSecret)
      ? [provider]
      : [];
  });
  const splitModel = textModels.find(({ id }) => id === splitPicked) ?? textModels[0];
  const splitJob = jobs.filter(({ purpose }) => purpose === "storyboard-split").at(-1);

  useEffect(() => {
    if (!edited.current) setShots(initial);
  }, [initial]);
  const activeNodes = linkedNodes[kind];
  const linkedByShot = new Map(activeNodes.map((node) => [node.data.shotId, node]));
  const latestByNode = new Map<string, GenerationJob>();
  for (const job of jobs) {
    const current = latestByNode.get(job.nodeId);
    if (!current || job.updatedAt > current.updatedAt) latestByNode.set(job.nodeId, job);
  }
  const pending = shots.flatMap(({ id }) => {
    const node = linkedByShot.get(id);
    return node?.data.text.trim() && !latestByNode.has(node.id) ? [node] : [];
  });
  const supportsShot = (shot: CanvasShot, retry = false) =>
    kind === "image" ||
    (!!selected &&
      (retry ||
        (!invalidDuration.includes(shot.id) && allowsDuration(selected.options, shot.duration))));
  const supportedPending = pending.filter(({ data }) => {
    const shot = shots.find(({ id }) => id === data.shotId);
    return shot && supportsShot(shot);
  });

  async function generate(targets: LinkedNode[], retryProvider?: ProviderView) {
    const submitModel = retryProvider ?? model;
    if (!submitModel || submitting || !targets.length) return;
    setSubmitting(true);
    setBatchError("");
    try {
      setBatchError(
        (await submit(
          targets.flatMap(({ id, data }) => {
            const shot = shots.find(({ id }) => id === data.shotId);
            const previous = latestByNode.get(id);
            if (
              !shot ||
              !supportsShot(shot, previous?.status === "failed" || previous?.status === "cancelled")
            )
              return [];
            return [
              {
                nodeId: id,
                prompt:
                  kind === "video" ? data.text.replace(/\n时长：\d+(?:\.\d+)? 秒$/, "") : data.text,
                ...(kind === "video" ? { duration: shot.duration } : {}),
              },
            ];
          }),
          submitModel,
        )) ?? "",
      );
    } catch {
      setBatchError("暂时无法提交，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }
  async function splitScript() {
    if (!splitModel || !sourceText.trim() || splitSubmitting) return;
    if (
      splitMode === "replace" &&
      shots.length > 0 &&
      !window.confirm("覆盖当前分镜表？此操作仍可通过画布撤销恢复。")
    )
      return;
    setSplitSubmitting(true);
    setSplitError("");
    try {
      const prompt = [
        "请把下面的剧本按叙事顺序拆成分镜，严格只输出 JSON 数组，不要 Markdown、解释或代码围栏。",
        "每项字段必须是 scene、shot、camera、action、dialogue、duration；duration 为 1 到 60 的数字，最多一位小数；shot 和 camera 使用常见中文术语。",
        "剧本：",
        sourceText.trim(),
      ].join("\n");
      const result = await submitSplit(prompt, splitModel, splitMode);
      if (result && !result.includes("已提交")) setSplitError(result);
    } catch {
      setSplitError("暂时无法提交拆镜任务，请稍后重试。");
    } finally {
      setSplitSubmitting(false);
    }
  }
  const update = (id: string, patch: Partial<CanvasShot>) => {
    edited.current = true;
    setShots((current) => current.map((shot) => (shot.id === id ? { ...shot, ...patch } : shot)));
  };
  const move = (index: number, offset: number) => {
    edited.current = true;
    setShots((current) => {
      const next = [...current];
      const [row] = next.splice(index, 1);
      if (row) next.splice(index + offset, 0, row);
      return next;
    });
  };
  const total = shots.reduce((sum, shot) => sum + shot.duration, 0);
  const ready = shots.every(({ id }) => !invalidDuration.includes(id));
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="image-doodle-dialog storyboard-dialog"
      aria-labelledby="storyboard-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting) close();
      }}
    >
      <header>
        <div>
          <h2 id="storyboard-title">分镜表</h2>
          <p>
            {shots.length} 个镜头 · {Number(total.toFixed(1))} 秒
          </p>
        </div>
        <button type="button" aria-label="关闭分镜表" disabled={submitting} onClick={close}>
          <X size={18} />
        </button>
      </header>
      {shots.map((row, index) => {
        const node = linkedByShot.get(row.id);
        const job = node && latestByNode.get(node.id);
        return (
          <fieldset className="storyboard-row outpaint-fields" key={row.id} disabled={submitting}>
            <legend>镜头 {index + 1}</legend>
            <label className="outpaint-full">
              画面描述
              <textarea
                rows={2}
                maxLength={2000}
                value={row.scene}
                onChange={(event) => update(row.id, { scene: event.target.value })}
              />
            </label>
            <label>
              景别
              <select
                value={row.shot}
                onChange={(event) =>
                  update(row.id, { shot: event.target.value as CanvasShot["shot"] })
                }
              >
                <option value="">未指定</option>
                {shotSizes.map((choice) => (
                  <option key={choice}>{choice}</option>
                ))}
              </select>
            </label>
            <label>
              运镜
              <select
                value={row.camera}
                onChange={(event) =>
                  update(row.id, { camera: event.target.value as CanvasShot["camera"] })
                }
              >
                <option value="">未指定</option>
                {cameraMoves.map((choice) => (
                  <option key={choice}>{choice}</option>
                ))}
              </select>
            </label>
            <label>
              动作 / 走位
              <textarea
                rows={2}
                maxLength={1000}
                value={row.action}
                onChange={(event) => update(row.id, { action: event.target.value })}
              />
            </label>
            <label>
              对白
              <textarea
                rows={2}
                maxLength={1000}
                value={row.dialogue}
                onChange={(event) => update(row.id, { dialogue: event.target.value })}
              />
            </label>
            <label>
              时长（秒）
              <input
                type="number"
                min="1"
                max="60"
                step="0.1"
                required
                defaultValue={row.duration}
                onChange={(event) => {
                  const valid = event.currentTarget.validity.valid;
                  setInvalidDuration((current) => [
                    ...current.filter((id) => id !== row.id),
                    ...(!valid ? [row.id] : []),
                  ]);
                  if (valid) update(row.id, { duration: event.currentTarget.valueAsNumber });
                }}
              />
            </label>
            <div className="storyboard-row-actions">
              <button
                type="button"
                aria-label="上移镜头"
                disabled={!index}
                onClick={() => move(index, -1)}
              >
                <ArrowUp size={15} />
              </button>
              <button
                type="button"
                aria-label="下移镜头"
                disabled={index === shots.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown size={15} />
              </button>
              <button
                type="button"
                aria-label="复制镜头"
                disabled={shots.length >= 100}
                onClick={() => {
                  edited.current = true;
                  setShots([
                    ...shots.slice(0, index + 1),
                    { ...row, id: crypto.randomUUID() },
                    ...shots.slice(index + 1),
                  ]);
                }}
              >
                <Copy size={15} />
              </button>
              <button
                type="button"
                aria-label="删除镜头"
                onClick={() => {
                  edited.current = true;
                  setShots(shots.filter(({ id }) => id !== row.id));
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
            {node && (
              <div className="outpaint-full storyboard-job">
                <span role="status">{job ? generationStatuses[job.status] : "待生成"}</span>
                {model && !supportsShot(row) && <small>当前模型不支持此镜头时长。</small>}
                {(job?.status === "failed" || job?.status === "cancelled") && (
                  <button
                    type="button"
                    disabled={
                      (!model && !settings.providers.some(({ id }) => id === job.providerId)) ||
                      !supportsShot(row, true)
                    }
                    onClick={() => {
                      const retryProvider = settings.providers.find(
                        ({ id }) => id === job.providerId,
                      );
                      if (retryProvider) void generate([node], retryProvider);
                    }}
                  >
                    重试生成
                  </button>
                )}
              </div>
            )}
          </fieldset>
        );
      })}
      <fieldset
        className="outpaint-fields storyboard-split"
        disabled={submitting || splitSubmitting}
      >
        <legend>
          <WandSparkles size={15} /> 从上游剧本拆分镜
        </legend>
        <p className="outpaint-full storyboard-batch-hint">
          {sourceText
            ? "已读取当前分镜表上游剧本。任务完成后会按模式写回镜头。"
            : "请先把剧本节点连到分镜表，或使用小灵读取引用剧本。"}
        </p>
        <label>
          拆镜模型
          <select
            aria-label="拆镜模型"
            value={splitModel?.id ?? ""}
            onChange={(event) => setSplitPicked(event.target.value)}
            disabled={!splitModel}
          >
            {!splitModel && <option value="">请在模型设置中启用文本模型</option>}
            {textModels.map(({ id, config, model: name, label }) => (
              <option value={id} key={id}>
                {config?.name ?? name} · {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          写入方式
          <select
            aria-label="拆镜写入方式"
            value={splitMode}
            onChange={(event) => setSplitMode(event.target.value as typeof splitMode)}
          >
            <option value="append">追加到现有镜头</option>
            <option value="replace">覆盖现有镜头</option>
          </select>
        </label>
        <button
          type="button"
          className="settings-primary"
          disabled={!splitModel || !sourceText.trim()}
          onClick={() => void splitScript()}
        >
          {splitSubmitting ? "正在拆分…" : "读取剧本并拆分镜"}
        </button>
        {splitJob && (
          <span className="storyboard-job" role="status">
            拆镜任务：{generationStatuses[splitJob.status]}
            {splitJob.error ? ` · ${splitJob.error}` : ""}
          </span>
        )}
        {splitError && (
          <p className="outpaint-full image-doodle-error" role="alert">
            {splitError}
          </p>
        )}
      </fieldset>
      <button
        className="storyboard-add"
        type="button"
        disabled={submitting || shots.length >= 100}
        onClick={() => {
          edited.current = true;
          setShots([
            ...shots,
            {
              id: crypto.randomUUID(),
              scene: "",
              action: "",
              dialogue: "",
              shot: "中景",
              camera: "固定",
              duration: 3,
            },
          ]);
        }}
      >
        <Plus size={16} /> 添加镜头
      </button>
      {!ready && (
        <p className="image-doodle-error" role="alert">
          镜头时长应为 1–60 秒，最多一位小数。
        </p>
      )}
      {(linkedNodes.image.length > 0 || linkedNodes.video.length > 0) && (
        <fieldset className="outpaint-fields storyboard-batch" disabled={submitting}>
          <legend>批量生成</legend>
          <label>
            生成类型
            <select value={kind} onChange={(event) => setKind(event.target.value as MediaKind)}>
              <option value="image" disabled={!linkedNodes.image.length}>
                图片
              </option>
              <option value="video" disabled={!linkedNodes.video.length}>
                视频
              </option>
            </select>
          </label>
          <label>
            批量生成模型
            <select value={model?.id ?? ""} onChange={(event) => setPicked(event.target.value)}>
              {!model && <option value="">请在模型设置中启用文生模型</option>}
              {models.map(({ provider: { id, config, model, label } }) => (
                <option value={id} key={id}>
                  {config?.name ?? model} · {label}
                </option>
              ))}
            </select>
          </label>
          <p className="outpaint-full storyboard-batch-hint">
            {kind === "video"
              ? "按每个镜头的时长生成。时长不兼容的镜头会跳过。"
              : "使用拆分节点的提示词与模型默认参数。"}
          </p>
          <button
            className="settings-primary"
            type="button"
            disabled={!model || !supportedPending.length}
            onClick={() => void generate(supportedPending)}
          >
            {submitting ? "正在提交…" : `生成 ${supportedPending.length} 个镜头`}
          </button>
          {batchError && (
            <p className="outpaint-full image-doodle-error" role="alert">
              {batchError}
            </p>
          )}
        </fieldset>
      )}
      <footer>
        <button type="button" disabled={submitting} onClick={close}>
          取消
        </button>
        <button
          type="button"
          disabled={submitting || !ready || !canSplit(shots, "image")}
          onClick={() => save(shots, "image")}
        >
          拆为图片节点
        </button>
        <button
          type="button"
          disabled={submitting || !ready || !canSplit(shots, "video")}
          onClick={() => save(shots, "video")}
        >
          拆为视频节点
        </button>
        <button
          type="button"
          className="settings-primary"
          disabled={submitting || !ready}
          onClick={() => save(shots)}
        >
          保存分镜
        </button>
      </footer>
    </dialog>
  );
}
