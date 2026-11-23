import { Bot } from "lucide-react";

import "./assistant-model-state.css";

export function AssistantModelState({
  loading,
  settings = false,
}: {
  loading: boolean;
  settings?: boolean;
}) {
  return loading ? (
    <div className="agent-model-skeleton" aria-busy="true">
      <i />
      <i />
    </div>
  ) : (
    <div className="agent-model-empty">
      <span>
        <Bot size={20} aria-hidden="true" />
      </span>
      <div>暂时没有可用的 Agent 模型</div>
      <p>{settings ? "请先在模型渠道发布 Agent 模型" : "请联系管理员发布 Agent 模型后再来。"}</p>
    </div>
  );
}
