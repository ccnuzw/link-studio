import { Tooltip } from "@base-ui/react/tooltip";
import { contextUsage, formatTokens } from "@link-studio/core";
import { Layers, TriangleAlert } from "lucide-react";
import type { Compaction } from "./compaction-history";
import "./compaction-divider.css";

export function CompactionDivider({ item, limit }: { item: Compaction; limit: number }) {
  const format = (tokens: number) =>
    limit > 0 ? `${contextUsage(tokens, limit).percent}%` : formatTokens(tokens);
  const after = item.after === null ? "…" : format(item.after);
  return (
    <Tooltip.Provider delay={0}>
      <Tooltip.Root>
        <Tooltip.Trigger
          render={<div />}
          role="separator"
          tabIndex={0}
          aria-label={item.failed ? "较早的对话没能整理" : "已整理较早的对话"}
          className="compaction-divider"
          data-failed={item.failed}
        >
          <i />
          <span>
            {item.failed ? (
              <>
                <TriangleAlert />
                较早的对话没能整理 · 这一轮不再自动整理，建议新开对话
              </>
            ) : (
              <>
                <Layers />
                已整理较早的对话 · 上下文 <b>{format(item.before)}</b> →{" "}
                <b key={after} data-revealed={item.after !== null}>
                  {after}
                </b>
              </>
            )}
          </span>
          <i />
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner side="top" sideOffset={8} className="agent-context-tip-position">
            <Tooltip.Popup role="tooltip" className="agent-context-tip">
              <span className="compaction-description">
                {item.failed
                  ? "这次没能把较早的对话整理成摘要（比如模型暂时不可用）。这一轮不会再自动整理，对话继续变长可能很快到上限；可以新开一个对话接着做。"
                  : "聊天记录没有变：上面的消息都还在。只是 Agent 读到的上下文里，较早的部分换成了一份摘要（要点、已完成的事、节点和任务信息都保留）。"}
              </span>
              <Tooltip.Arrow className="agent-context-tip-arrow" />
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
