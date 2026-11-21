import {
  type GenerationInput,
  mediaReferenceBytes,
  modelGenerationOptions,
  type SettingsValues,
} from "@link-studio/core";
import { Expand, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type OutpaintRatio,
  outpaintAspect,
  outpaintRatios,
  outpaintSize,
  planOutpaint,
} from "./image-outpaint";

export type OutpaintDraft = Pick<
  GenerationInput,
  "providerId" | "expectedProviderRevision" | "prompt" | "aspectRatio" | "size"
> & { pngData: string };

export function ImageOutpaintDialog({
  assetName,
  url,
  settings,
  busy,
  error,
  submit,
  close,
}: {
  assetName: string;
  url: string;
  settings: SettingsValues["list"];
  busy: boolean;
  error: string;
  submit: (draft: OutpaintDraft) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number }>();
  const [ratio, setRatio] = useState<OutpaintRatio>("原比例");
  const [scale, setScale] = useState(1.5);
  const [heightScale, setHeightScale] = useState(1.5);
  const [horizontal, setHorizontal] = useState(50);
  const [vertical, setVertical] = useState(50);
  const [providerId, setProviderId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [draft, setDraft] = useState<OutpaintDraft>();
  const providers = settings.providers.flatMap((provider) => {
    const plugin = settings.plugins.find(({ hash }) => hash === provider.pluginHash);
    if (
      !provider.enabled ||
      provider.channelEnabled === false ||
      provider.config?.kind === "agent" ||
      plugin?.kind !== "image" ||
      plugin.disabled ||
      (plugin.auth !== "none" && !provider.hasSecret)
    )
      return [];
    const options = modelGenerationOptions(
      "image",
      plugin.origin === "builtin" ? plugin.key : undefined,
      provider.model,
      provider.channel,
      provider.config,
    );
    return options.references.image && !options.referenceNeedsURL("image")
      ? [{ provider, options }]
      : [];
  });
  const selected = providers.find(({ provider }) => provider.id === providerId) ?? providers[0];
  const plan =
    sourceSize &&
    planOutpaint(
      sourceSize.width,
      sourceSize.height,
      scale,
      ratio,
      horizontal,
      vertical,
      heightScale,
    );
  const size = plan && selected ? outpaintSize(selected.options.sizes, plan) : undefined;
  const aspectRatio = plan && selected ? outpaintAspect(selected.options.ratios, plan) : undefined;
  const instruction = "保持原图内容不变，自然补全透明区域。输出一张完整图片，不留空白或边框。";
  const fullPrompt = `${instruction}${prompt.trim() ? `\n${prompt.trim()}` : ""}`;
  const promptLimit = Math.min(16000, selected?.options.promptLimit ?? 16000);
  const locked = busy || Boolean(draft);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const generate = () => {
    if (busy) return;
    if (draft) return submit(draft);
    if (!selected || !plan || !image.current || Array.from(fullPrompt).length > promptLimit) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = plan.width;
      canvas.height = plan.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法合成扩图底图");
      context.drawImage(image.current, plan.left, plan.top, plan.imageWidth, plan.imageHeight);
      const pngData = canvas.toDataURL("image/png");
      const encoded = pngData.slice("data:image/png;base64,".length);
      const bytes =
        encoded.length * 0.75 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
      if (bytes > (selected.options.referenceBytes.image ?? mediaReferenceBytes)) {
        setPreviewError("底图超过模型参考图大小限制，请调小扩展倍数或选择其他模型。");
        return;
      }
      setPreviewError("");
      const next = {
        pngData,
        providerId: selected.provider.id,
        expectedProviderRevision: selected.provider.revision,
        prompt: fullPrompt,
        ...(size ? { size } : aspectRatio ? { aspectRatio } : {}),
      };
      setDraft(next);
      submit(next);
    } catch {
      setPreviewError("无法合成扩图底图，请重新打开图片后重试。");
    }
  };

  return (
    <dialog
      ref={dialog}
      className="image-doodle-dialog image-outpaint-dialog"
      aria-labelledby="image-outpaint-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <header>
        <div>
          <h2 id="image-outpaint-title">图片扩图</h2>
          <p>{assetName}</p>
        </div>
        <button type="button" aria-label="关闭扩图" disabled={busy} onClick={close}>
          <X size={18} />
        </button>
      </header>
      <div className="outpaint-preview">
        <div
          className="outpaint-frame"
          style={
            plan
              ? {
                  aspectRatio: `${plan.width} / ${plan.height}`,
                  width: `min(100%, ${Math.round((300 * plan.width) / plan.height)}px)`,
                }
              : undefined
          }
        >
          <img
            ref={image}
            crossOrigin="anonymous"
            src={url}
            alt={assetName}
            style={
              plan
                ? {
                    width: `${(100 * plan.imageWidth) / plan.width}%`,
                    height: `${(100 * plan.imageHeight) / plan.height}%`,
                    left: `${(100 * plan.left) / plan.width}%`,
                    top: `${(100 * plan.top) / plan.height}%`,
                  }
                : undefined
            }
            onLoad={(event) =>
              setSourceSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={() => setPreviewError("原图加载失败，请关闭后重新打开图片。")}
          />
        </div>
      </div>
      <fieldset className="outpaint-fields" disabled={locked}>
        <label>
          画框比例
          <select value={ratio} onChange={(event) => setRatio(event.target.value as OutpaintRatio)}>
            {outpaintRatios.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          {ratio === "自由" ? "宽度倍数" : "扩展倍数"}
          <select value={scale} onChange={(event) => setScale(Number(event.target.value))}>
            {[1.25, 1.5, 2, 2.5, 3].map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
        </label>
        {ratio === "自由" && (
          <label>
            高度倍数
            <select
              value={heightScale}
              onChange={(event) => setHeightScale(Number(event.target.value))}
            >
              {[1, 1.25, 1.5, 2, 2.5, 3].map((value) => (
                <option key={value} value={value}>
                  {value}×
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          水平位置
          <input
            type="range"
            min="0"
            max="100"
            value={horizontal}
            onChange={(event) => setHorizontal(Number(event.target.value))}
          />
        </label>
        <label>
          垂直位置
          <input
            type="range"
            min="0"
            max="100"
            value={vertical}
            onChange={(event) => setVertical(Number(event.target.value))}
          />
        </label>
        <label className="outpaint-full">
          图片模型
          <select
            value={selected?.provider.id ?? ""}
            onChange={(event) => setProviderId(event.target.value)}
          >
            {!selected && <option value="">没有可接收本地参考图的图生图模型</option>}
            {providers.map(({ provider }) => (
              <option key={provider.id} value={provider.id}>
                {provider.config?.name ?? provider.model} · {provider.label}
              </option>
            ))}
          </select>
        </label>
        <label className="outpaint-full">
          补画内容（选填）
          <textarea
            rows={2}
            maxLength={Math.max(0, promptLimit - instruction.length - 1)}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="例如：在右侧延展街景和路灯"
          />
        </label>
      </fieldset>
      {plan && (
        <p className="outpaint-info">
          底图 {plan.width} × {plan.height}
          {size
            ? ` · 模型输出 ${size.replace("x", " × ")}`
            : aspectRatio && aspectRatio !== "adaptive"
              ? ` · 模型比例 ${aspectRatio}`
              : ""}
          。确认后将参考图发送给所选模型。
        </p>
      )}
      {(error || previewError) && (
        <p className="image-doodle-error" role="alert">
          {error || previewError}
        </p>
      )}
      <footer>
        <button type="button" onClick={close} disabled={busy}>
          {draft ? "关闭" : "取消"}
        </button>
        <button
          type="button"
          className="settings-primary"
          onClick={generate}
          disabled={busy || !selected || !plan || Array.from(fullPrompt).length > promptLimit}
        >
          <Expand size={16} /> {busy ? "正在准备扩图…" : draft ? "重试提交" : "确认扩图"}
        </button>
      </footer>
    </dialog>
  );
}
