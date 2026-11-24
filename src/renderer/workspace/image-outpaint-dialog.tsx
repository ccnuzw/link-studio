import {
  type GenerationInput,
  mediaReferenceBytes,
  modelGenerationOptions,
  type SettingsValues,
} from "@link-studio/core";
import { NodeToolbar, Position, useStore } from "@xyflow/react";
import { Expand, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type OutpaintRatio, outpaintRatios, outpaintSize } from "./image-outpaint";
import { planCompose } from "./outpaint-compose";
import { OutpaintFrameLayer } from "./outpaint-frame-layer";
import {
  fitsCap,
  frameByMult,
  frameByRatio,
  frameHeight,
  frameWidth,
  type OutpaintFrame,
  parseAspect,
  ratioOfFrame,
  snapRatio,
} from "./outpaint-geometry";

export type OutpaintDraft = Pick<
  GenerationInput,
  "providerId" | "expectedProviderRevision" | "prompt" | "aspectRatio" | "size"
> & { pngData: string };

export function ImageOutpaintDialog({
  nodeId,
  assetName,
  url,
  settings,
  busy,
  error,
  submit,
  close,
}: {
  nodeId: string;
  assetName: string;
  url: string;
  settings: SettingsValues["list"];
  busy: boolean;
  error: string;
  submit: (draft: OutpaintDraft) => void;
  close: () => void;
}) {
  const measured = useStore((state) => state.nodeLookup.get(nodeId)?.measured);
  const origin = { w: measured?.width || 1, h: measured?.height || 1 };
  const zoom = useStore((state) => state.transform[2]);
  const [edited, setEdited] = useState<OutpaintFrame>();
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
  const preset = parseAspect(ratio);
  const base = preset === null ? frameByMult(origin, scale) : frameByRatio(origin, preset);
  const width = frameWidth(base),
    height = ratio === "自由" ? origin.h * heightScale : frameHeight(base);
  const left = ((origin.w - width) * horizontal) / 100,
    top = ((origin.h - height) * vertical) / 100;
  const frame = edited ?? { x0: left, y0: top, x1: left + width, y1: top + height };
  const composed =
    sourceSize &&
    planCompose({ natural: { w: sourceSize.width, h: sourceSize.height }, origin, frame });
  const positionFrame = (axis: "x" | "y", value: number) => {
    const wide = frameWidth(frame),
      tall = frameHeight(frame);
    const x0 = axis === "x" ? ((origin.w - wide) * value) / 100 : frame.x0;
    const y0 = axis === "y" ? ((origin.h - tall) * value) / 100 : frame.y0;
    setEdited({ x0, y0, x1: x0 + wide, y1: y0 + tall });
  };
  const plan = composed && {
    ...composed,
    left: composed.imageX,
    top: composed.imageY,
    imageWidth: composed.imageW,
    imageHeight: composed.imageH,
  };
  const size = plan && selected ? outpaintSize(selected.options.sizes, plan) : undefined;
  const aspectRatio = selected?.options.ratios.length
    ? snapRatio(ratioOfFrame(origin, frame), selected.options.ratios)
    : undefined;
  const instruction = "保持原图内容不变，自然补全图片中的透明区域。";
  const fullPrompt = instruction + prompt.trim();
  const promptLimit = Math.min(16000, selected?.options.promptLimit ?? 16000);
  const locked = busy || Boolean(draft);

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [busy, close]);

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

  if (!measured?.width || !measured.height) return null;
  return (
    <>
      <OutpaintFrameLayer
        nodeId={nodeId}
        origin={origin}
        frame={frame}
        onChange={(next) => {
          setEdited(next);
          setRatio("自由");
          setScale(frameWidth(next) / origin.w);
          setHeightScale(frameHeight(next) / origin.h);
          setHorizontal((next.x0 * 100) / (origin.w - frameWidth(next)) || 0);
          setVertical((next.y0 * 100) / (origin.h - frameHeight(next)) || 0);
        }}
        disabled={locked}
        sizeLabel={plan && `${plan.width} × ${plan.height}`}
      />
      <NodeToolbar
        nodeId={nodeId}
        position={Position.Bottom}
        offset={Math.max(0, frame.y1 - origin.h) * zoom + 12}
        isVisible
      >
        <section
          role="dialog"
          className="image-doodle-dialog image-outpaint-dialog outpaint-node-panel nodrag nopan nowheel"
          aria-labelledby="image-outpaint-title"
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
          <img
            hidden
            ref={image}
            crossOrigin="anonymous"
            src={url}
            alt=""
            onLoad={({ currentTarget }) =>
              setSourceSize({
                width: currentTarget.naturalWidth,
                height: currentTarget.naturalHeight,
              })
            }
            onError={() => setPreviewError("原图加载失败，请关闭后重新打开图片。")}
          />
          <fieldset className="outpaint-fields" disabled={locked}>
            <label>
              画框比例
              <select
                value={ratio}
                onChange={(event) => {
                  setEdited(undefined);
                  setHorizontal(50);
                  setVertical(50);
                  setRatio(event.target.value as OutpaintRatio);
                }}
              >
                {outpaintRatios.map((value) => {
                  const aspect = parseAspect(value);
                  const disabled =
                    aspect !== null && !fitsCap(origin, frameByRatio(origin, aspect));
                  return (
                    <option key={value} disabled={disabled}>
                      {value}
                    </option>
                  );
                })}
              </select>
            </label>
            <label>
              {ratio === "自由" ? "宽度倍数" : "扩展倍数"}
              <select
                disabled={!!preset}
                value={scale}
                onChange={(event) => {
                  setEdited(undefined);
                  if (ratio !== "自由") {
                    setHorizontal(50);
                    setVertical(50);
                  }
                  setScale(Number(event.target.value));
                }}
              >
                {![1, 1.25, 1.5, 2, 3].includes(scale) && (
                  <option value={scale}>{scale.toFixed(2)}×</option>
                )}
                {[1, 1.25, 1.5, 2, 3].map((value) => (
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
                  onChange={(event) => {
                    setEdited(undefined);
                    setHeightScale(Number(event.target.value));
                  }}
                >
                  {![1, 1.25, 1.5, 2, 2.5, 3].includes(heightScale) && (
                    <option value={heightScale}>{heightScale.toFixed(2)}×</option>
                  )}
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
                onChange={(event) => {
                  setEdited(undefined);
                  positionFrame("x", Number(event.target.value));
                  setHorizontal(Number(event.target.value));
                }}
              />
            </label>
            <label>
              垂直位置
              <input
                type="range"
                min="0"
                max="100"
                value={vertical}
                onChange={(event) => {
                  setEdited(undefined);
                  positionFrame("y", Number(event.target.value));
                  setVertical(Number(event.target.value));
                }}
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
                maxLength={Math.max(0, promptLimit - instruction.length)}
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
        </section>
      </NodeToolbar>
    </>
  );
}
