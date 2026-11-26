import {
  type CanvasAgentAction,
  type DramaDocument,
  defaultAgentLayout,
  type ProviderView,
  type SettingsApproval,
  type SettingsEvent,
} from "@link-studio/core";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasAssistant } from "../../src/renderer/workspace/canvas-assistant";
import type { DramaAssetEditor } from "../../src/renderer/workspace/drama-asset-browser";
import { DramaStudio } from "../../src/renderer/workspace/drama-studio";
import "../../src/renderer/styles.css";
import "../../src/renderer/workspace/canvas-workspace.css";
import "../../src/renderer/assistant/workspace-shell.css";
import "../../src/renderer/desktop-shell.css";

const noop = () => {};
const ok = <Value,>(value: Value) => ({ ok: true, value });
const model = {
  id: "assistant-model",
  label: "测试模型",
  enabled: true,
  hasSecret: true,
  agentEnabled: true,
} as ProviderView;
const doc: DramaDocument = {
  title: "夜班站台",
  outline_md: "列车抵达。",
  characters_md: "",
  revision: 1,
  episode_order: 3,
  episodes: [1, 2].map((episode_no) => ({
    episode_no,
    title: `来客 ${episode_no}`,
    synopsis: "",
    script_md: `第 ${episode_no} 集正文`,
    ...(episode_no === 2 && { locked: true, storyboard_status: "ready" as const }),
  })),
  segments: [
    { id: "2".repeat(32), seq: 0, episode_no: 2, revision: 1, prompt: "拍摄站台", seconds: 5 },
  ],
};
const graph: Pick<DramaAssetEditor["graph"], "nodes" | "edges"> = {
  nodes: [
    {
      id: "platform",
      type: "creative",
      position: { x: 0, y: 0 },
      data: {
        kind: "image",
        label: "夜班站台",
        text: "冬夜站台",
        drama: {
          type: "scene",
          name: "夜班站台",
          look: "",
          description: "",
          aliases: [],
          episodes: [1],
        },
      },
    },
    {
      id: "waiting-room",
      type: "creative",
      position: { x: 300, y: 0 },
      data: {
        kind: "image",
        label: "夜班候车室",
        text: "空荡的候车室",
        drama: {
          type: "scene",
          name: "夜班候车室",
          look: "",
          description: "",
          aliases: [],
          episodes: [1],
        },
      },
    },
  ],
  edges: [],
};
const assetEditor: DramaAssetEditor = {
  assets: [],
  graph: { ...graph, viewport: { x: 0, y: 0, zoom: 1 } },
  ready: true,
  jobs: new Map(),
  progress: new Map(),
  mount: noop,
  focus: () => true,
  save: async () => true,
  clearSelection: noop,
  classify: noop,
  create: noop,
  canCreate: false,
  prompt: () => null,
  character: noop,
  fill: noop,
  drop: noop,
  generate: async () => {},
  estimate: () => 0,
  voiceUnit: 0,
  batching: false,
};
let layout = defaultAgentLayout;
const events: SettingsEvent[] = [];
let approvals: SettingsApproval[] = [];
let lastSent: CanvasAgentAction | undefined;
let updateFixture = noop;
const request = { step: "breakdown", episodes: [1] } as const;
const approval: SettingsApproval = {
  id: "approval-1",
  kind: "drama_run_job",
  status: "pending",
  payload: {
    args: request,
    episodes: [1],
    title: "运行短剧任务：资产拆解",
    reason: "整理场景",
    estimate: 28,
  },
};
function addEvent(type: string, payload: unknown, approvalId?: string) {
  events.push({
    type,
    payload,
    seq: events.length + 1,
    runId: "run-1",
    ...(approvalId && { approvalId }),
  });
}

window.desktop = {
  canvasWindow: { setNoticeCanvas: noop },
  projectEvents: { onAgentChanged: () => noop },
  settings: {
    agentLayout: async (patch: Partial<typeof layout>) => {
      layout = { ...layout, ...patch };
      return ok(layout);
    },
  },
  skills: { list: async () => ok([]) },
  projects: {
    drama: async () => ok(structuredClone(doc)),
    getCanvas: async () => ok({ canvas: graph }),
    listAssets: async () => ok({ assets: [] }),
    canvasAgent: async ({ action, mode }: { action: CanvasAgentAction; mode?: string }) => {
      if (action.method === "list") return ok([{ id: "history", title: "夜班创作" }]);
      if (action.method === "state")
        return ok({
          title: "夜班创作",
          events: mode ? events.filter(({ seq }) => seq > (action.after ?? 0)) : [],
          approvals: mode ? approvals : [],
          ...(mode && approvals.length && { activeRun: "run-1", activeStatus: "waiting_approval" }),
        });
      if (action.method === "send") {
        lastSent = action;
        addEvent("message.user", { text: action.message, page_context: action.dramaContext });
        approvals = [approval];
        addEvent("approval.created", approval, approval.id);
        updateFixture();
        return ok({ runId: "run-1" });
      }
      if (action.method === "decide") {
        approvals = [];
        const approved = !!action.selected?.length;
        addEvent(
          "approval.decided",
          {
            ...approval,
            status: approved ? "executed" : "rejected",
            result: approved ? { id: "job-1" } : null,
          },
          approval.id,
        );
        if (approved)
          doc.jobs = [
            {
              id: "job-1",
              step: "breakdown",
              episodes: [1],
              request: { step: "breakdown", episodes: [1] },
              status: "running",
              progress: 40,
              frozen_credits: 28,
              created_at: "2026-11-26",
              episode_order: 3,
              approval_id: approval.id,
              approval_hash: "",
            },
          ];
        return ok({ status: approved ? "approved" : "rejected" });
      }
      return ok({});
    },
  },
} as unknown as typeof window.desktop;

window.addEventListener("fixture-job-failed", () => {
  const job = doc.jobs?.[0];
  if (job) Object.assign(job, { status: "failed", error_message: "测试服务暂时不可用" });
});

function Fixture() {
  const [visible, setVisible] = useState(false);
  const [assetSelection, setAssetSelection] = useState<string>();
  const [models, setModels] = useState([model]);
  const [, tick] = useState(0);
  const flush = useRef<(() => Promise<boolean>) | null>(null);
  updateFixture = () => tick((value) => value + 1);
  useEffect(() => {
    const disable = () => setModels([]);
    const enable = () => setModels([model]);
    window.addEventListener("fixture-model-disabled", disable);
    window.addEventListener("fixture-model-enabled", enable);
    return () => {
      window.removeEventListener("fixture-model-disabled", disable);
      window.removeEventListener("fixture-model-enabled", enable);
    };
  }, []);
  if (location.search.includes("canvas"))
    return (
      <main className="canvas-workspace">
        <CanvasAssistant
          projectHandle="fixture"
          canvasName={null}
          petStage={null}
          toggle={noop}
          providers={[model]}
          plugins={[]}
          selection={[]}
          nodes={[]}
          assets={[]}
          visible
          close={noop}
          openSettings={noop}
          locateNode={noop}
          locateResults={noop}
          beforeWrite={async () => true}
          jobs={[]}
          openJobs={noop}
        />
      </main>
    );
  return (
    <>
      <DramaStudio
        projectHandle="fixture"
        projectId="fixture"
        withAssistant={visible}
        toggleAssistant={() => setVisible(!visible)}
        providers={models}
        plugins={[]}
        loadingModels={false}
        flushBeforeClose={flush}
        assetEditor={{
          ...assetEditor,
          selected: assetSelection,
          focus: (id) => {
            setAssetSelection(id);
            return true;
          },
          clearSelection: () => setAssetSelection(undefined),
        }}
        returnLabel="返回首页"
        close={noop}
      />
      <output data-testid="sent" hidden>
        {JSON.stringify(lastSent)}
      </output>
    </>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
