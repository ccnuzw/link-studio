import { Tooltip } from "@base-ui/react/tooltip";
import {
  agentContextWindow,
  contextUsage,
  formatTokens,
  type ProviderView,
  type SettingsEvent,
  sessionContextTokens,
} from "@link-studio/core";
import NumberFlow from "@number-flow/react";
import { useId } from "react";
import "./assistant-context-ring.css";

export function AssistantContextRing({
  events,
  model,
}: {
  events: SettingsEvent[];
  model?: ProviderView;
}) {
  const id = useId();
  const limit = agentContextWindow(model);
  const { used, known, ratio, percent, tone } = contextUsage(sessionContextTokens(events), limit);
  const summary = known ? `${formatTokens(used)} / ${formatTokens(limit)}` : formatTokens(used);
  const circumference = 14 * Math.PI;
  return (
    <span className="agent-context" data-tone={tone}>
      <Tooltip.Provider delay={0}>
        <Tooltip.Root>
          <Tooltip.Trigger type="button" aria-label={`上下文用量 ${summary}`} popoverTarget={id}>
            <svg viewBox="0 0 18 18" aria-hidden="true" fill="none" strokeWidth="2">
              <circle cx="9" cy="9" r="7" className="context-track" />
              <circle
                cx="9"
                cy="9"
                r="7"
                stroke="var(--context-tone)"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - ratio)}
              />
            </svg>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Positioner side="top" sideOffset={8} className="agent-context-tip-position">
              <Tooltip.Popup role="tooltip" className="agent-context-tip">
                {`上下文 ${summary}${known ? `（${percent}%）` : ""}`}
                <Tooltip.Arrow className="agent-context-tip-arrow" />
              </Tooltip.Popup>
            </Tooltip.Positioner>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
      <div id={id} popover="auto" className="agent-context-popup">
        <div className="context-counts">
          <div>
            <p>上下文</p>
            <strong>{formatTokens(used)}</strong>
          </div>
          {known && (
            <div>
              <p>上限</p>
              <strong>{formatTokens(limit)}</strong>
            </div>
          )}
        </div>
        {known && (
          <>
            <div className="context-bar">
              <span style={{ width: `${ratio * 100}%` }} />
            </div>
            <p>
              已用 <NumberFlow value={percent} />%
            </p>
          </>
        )}
        <p className="context-hint">
          {known ? "快满时会自动压缩较早的对话，不影响继续使用" : "这个模型没有配置上下文上限"}
        </p>
      </div>
    </span>
  );
}
