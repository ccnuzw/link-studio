import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useStore } from "zustand";
import { AgentMarks, createAgentMarks } from "../../src/renderer/workspace/agent-marks";
import { AssistantQuestionnaire } from "../../src/renderer/workspace/assistant-questionnaire";
import { AssistantWatchStrip } from "../../src/renderer/workspace/assistant-watch";
import {
  CanvasApprovalRequest,
  CanvasNotificationRequest,
  CanvasRequestReceipt,
} from "../../src/renderer/workspace/canvas-request-cards";
import "../../src/renderer/styles.css";
import "../../src/renderer/workspace/canvas-workspace.css";
import "../../src/renderer/assistant/workspace-shell.css";
import "../../src/renderer/settings/channel-workspace.css";

const marks = createAgentMarks();
const withEdges = new URLSearchParams(location.search).has("edges");
const noticeWithWatch = new URLSearchParams(location.search).has("notice-with-watch");
const nodes = [
  { node_id: "draft", label: "直接编辑样本", hasOutput: true },
  { node_id: "opening", label: "从一个想法开始" },
];
const operations = [
  {
    type: "putNode",
    node: {
      id: "storyboard",
      data: {
        label: "夜班分镜",
        storyboard: [{ id: "arrival", shot: "远景", duration: 3, scene: "列车进站。" }],
      },
    },
  },
  { type: "removeEdge", id: "long-".repeat(30) },
];

function Fixture() {
  const [decision, setDecision] = useState<unknown>(null);
  const [waiting, setWaiting] = useState(true);
  const busy = new URLSearchParams(location.search).has("busy");
  const highlighted = useStore(marks.store, (state) => state.size);
  return (
    <main
      className="canvas-workspace"
      style={{ display: "block", position: "static", height: "auto" }}
    >
      <div className="assistant-frame" style={{ position: "static" }}>
        <section className="assistant-surface canvas-assistant" aria-label="画布小灵">
          <header className="assistant-heading">
            <span className="assistant-header-orb" aria-hidden="true" />
            <h2>开场画面创作</h2>
          </header>
          {(!noticeWithWatch || typeof decision !== "boolean") && (
            <CanvasNotificationRequest choose={setDecision} />
          )}
          {noticeWithWatch && waiting && (
            <AssistantWatchStrip
              summary={{
                total: 1,
                settled: 0,
                failed: 0,
                queued: false,
                text: "后台等待生成 · 0/1 已结束",
                tasks: [{ id: "task", node: "shot", label: "夜班站台", status: "生成中" }],
              }}
              locate={setDecision}
              cancel={() => setWaiting(false)}
            />
          )}
          <div
            className="assistant-history-content"
            style={noticeWithWatch ? { display: "none" } : undefined}
          >
            <AgentMarks.Provider value={marks}>
              <CanvasApprovalRequest
                approval={{
                  id: "deletion",
                  kind: "delete",
                  status: "pending",
                  payload: {
                    action: "delete",
                    reason: "清理开场草稿",
                    items: withEdges ? [...nodes, { edges: true }] : nodes,
                    edgeIds: withEdges ? ["edge-first", "edge-second"] : [],
                  },
                }}
                busy={busy}
                decide={setDecision}
              />
            </AgentMarks.Provider>
            <CanvasApprovalRequest
              approval={{ id: "edit", kind: "delete", status: "pending", payload: { operations } }}
              busy={busy}
              decide={setDecision}
            />
            <CanvasApprovalRequest
              approval={{
                id: "generation",
                kind: "generate",
                status: "pending",
                payload: {
                  reason: "为开场准备一个镜头。",
                  items: [
                    {
                      node_id: "shot",
                      label: "夜班站台",
                      model: "镜头模型",
                      endpoint: `https://example.test/${"very-long-path".repeat(7)}`,
                      price: 12,
                      request: {
                        prompt: "拍一个雨夜列车进站的镜头。",
                        referenceAssetIds: ["站台参考"],
                      },
                    },
                  ],
                },
              }}
              busy={busy}
              decide={setDecision}
            />
            <AssistantQuestionnaire
              quickChoices
              payload={{
                questions: [
                  {
                    id: "tone",
                    label: "选一个开场氛围",
                    kind: "choice",
                    options: ["安静", "紧张"],
                  },
                  {
                    id: "detail",
                    label: "还有什么要补充？",
                    kind: "text",
                    placeholder: "写一句说明",
                  },
                ],
              }}
              busy={busy}
              models={[]}
              onAnswer={setDecision}
            />
            <CanvasRequestReceipt deletion status="partially_approved" />
            <CanvasRequestReceipt deletion={false} status="failed" error="画布已更新" />
            <CanvasRequestReceipt deletion status="expired" />
          </div>
        </section>
      </div>
      <output data-testid="decision" hidden>
        {JSON.stringify(decision)}
      </output>
      <output data-testid="highlighted" hidden>
        {highlighted}
      </output>
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
