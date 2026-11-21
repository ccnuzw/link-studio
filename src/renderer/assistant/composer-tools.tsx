import type { ProviderView, SettingsEvent } from "@link-studio/core";
import { ArrowUp, Gauge, Paperclip, Sparkles, Video } from "lucide-react";
import { type ReactNode, useId } from "react";

export function ComposerTool({
  label,
  icon,
  children,
  disabled,
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <>
      <button
        type="button"
        className="composer-tool"
        aria-label={label}
        title={label}
        popoverTarget={id}
        disabled={disabled}
      >
        {icon}
      </button>
      <div id={id} className="composer-popover" popover="auto">
        <strong>{label}</strong>
        {children}
      </div>
    </>
  );
}

export function ComposerTools({
  attachments,
  media,
  skills,
  models,
  modelId,
  onModel,
  openSettings,
  events,
  locked,
  canSend,
  active,
}: {
  attachments?: ReactNode;
  media?: ReactNode;
  skills?: ReactNode;
  models: ProviderView[];
  modelId?: string;
  onModel: (id: string) => void;
  openSettings?: () => void;
  events: SettingsEvent[];
  locked: boolean;
  canSend: boolean;
  active: boolean;
}) {
  const usage = events.findLast(({ type }) => type === "model.usage")?.payload;
  const tokens =
    usage &&
    typeof usage === "object" &&
    "input_tokens" in usage &&
    typeof usage.input_tokens === "number" &&
    usage.input_tokens > 0
      ? usage.input_tokens
      : undefined;
  return (
    <div className="composer-toolbar">
      <ComposerTool
        label="添加附件"
        icon={<Paperclip size={16} aria-hidden="true" />}
        disabled={locked}
      >
        {attachments ?? <small>设置助手仅接收文本消息。</small>}
      </ComposerTool>
      <ComposerTool
        label="图片或视频模型"
        icon={<Video size={17} aria-hidden="true" />}
        disabled={locked}
      >
        {media ?? <small>请在画布小灵中选择生成模型。</small>}
      </ComposerTool>
      <ComposerTool
        label="Skills 技能"
        icon={<Sparkles size={16} aria-hidden="true" />}
        disabled={locked}
      >
        {skills ?? <small>创作技能可在画布小灵中使用。</small>}
      </ComposerTool>
      {models.length ? (
        <select
          className="composer-model"
          aria-label="对话模型"
          value={modelId ?? ""}
          onChange={({ target }) => onModel(target.value)}
          disabled={locked}
        >
          {models.map(({ id, model, label }) => (
            <option key={id} value={id}>
              {model} · {label}
            </option>
          ))}
        </select>
      ) : openSettings ? (
        <button type="button" className="composer-model" onClick={openSettings}>
          模型设置
        </button>
      ) : (
        <span className="composer-model muted">暂无对话模型</span>
      )}
      <ComposerTool label="模型上下文" icon={<Gauge size={16} aria-hidden="true" />}>
        <small>
          {tokens === undefined
            ? "暂无上下文用量。模型返回用量后会显示。"
            : `最近一次请求的输入用量：${tokens.toLocaleString()} tokens。`}
        </small>
      </ComposerTool>
      <button
        type="submit"
        className="settings-primary composer-send"
        disabled={!canSend}
        aria-label={active ? "插话" : "发送"}
        title={active ? "插话" : "发送"}
      >
        <ArrowUp size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
