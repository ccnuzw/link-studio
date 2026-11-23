import type { ProviderView, SettingsEvent } from "@link-studio/core";
import { ArrowUp, Plus, Square } from "lucide-react";
import { type ReactNode, useId } from "react";
import { AgentModelMenu } from "./agent-model-menu";
import { AssistantContextRing } from "./assistant-context-ring";

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
  attachmentsLocked = locked,
  canSend,
  active,
  stop,
  stopDisabled,
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
  attachmentsLocked?: boolean;
  canSend: boolean;
  active: boolean;
  stop?: () => void;
  stopDisabled?: boolean;
}) {
  const current = models.find((model) => model.id === modelId) ?? models[0];
  return (
    <div className="composer-toolbar">
      {attachments && (
        <ComposerTool
          label="添加附件"
          icon={<Plus size={17} aria-hidden="true" />}
          disabled={attachmentsLocked}
        >
          {attachments}
        </ComposerTool>
      )}
      {attachments && <span className="composer-divider" aria-hidden="true" />}
      {media}
      {skills}
      {current ? (
        <AgentModelMenu current={current} models={models} locked={locked} select={onModel} />
      ) : openSettings ? (
        <button type="button" className="composer-model" onClick={openSettings}>
          模型设置
        </button>
      ) : (
        <span className="composer-model muted">暂无对话模型</span>
      )}
      <AssistantContextRing events={events} model={current} />
      <button
        type={stop ? "button" : "submit"}
        className="settings-primary composer-send"
        disabled={stop ? stopDisabled : !canSend}
        aria-label={stop ? "停止" : active ? "插话" : "发送"}
        title={stop ? "停止" : active ? "插话" : "发送"}
        onClick={stop}
      >
        {stop ? (
          <Square size={14} fill="currentColor" aria-hidden />
        ) : (
          <ArrowUp size={18} aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
