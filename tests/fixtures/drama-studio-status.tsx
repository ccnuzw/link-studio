import { createRoot } from "react-dom/client";
import {
  DramaEmptyState,
  DramaNotice,
  DramaTaskStatusStack,
  DramaWorkspaceState,
} from "../../src/renderer/workspace/drama-studio-status";
import "./drama-studio-status.css";

const jobs = [
  {
    id: "00000000000000000000000000000001",
    step: "breakdown",
    episodes: [1],
    request: { step: "breakdown", episodes: [1] },
    status: "running",
    frozen_credits: 12,
    created_at: "2026-11-26T00:00:00.000Z",
    progress: 68,
  },
  {
    id: "00000000000000000000000000000002",
    step: "storyboard",
    episodes: [1],
    request: { step: "storyboard", episodes: [1] },
    status: "failed",
    frozen_credits: 20,
    created_at: "2026-11-26T00:00:00.000Z",
    error_message: "故事板模型暂时不可用",
  },
] as const;

function App() {
  return (
    <main className="status-fixture">
      <header>
        <small>短剧工作台 · 非助手状态</small>
        <h1>工程化状态预览</h1>
      </header>
      <div className="status-grid">
        <DramaWorkspaceState
          kind="loading"
          title="正在读取短剧"
          description="正在准备片场、分集和制作状态。"
        />
        <DramaWorkspaceState
          kind="error"
          title="短剧读取失败"
          description="项目数据暂时不可用。"
          action={{ label: "重试读取", onClick: () => undefined }}
        />
        <DramaEmptyState
          title="还没有分集"
          description="完成研读或分集规划后，分集会出现在这里。"
          action={{ label: "回到大纲", onClick: () => undefined }}
        />
        <DramaEmptyState
          compact
          title="未找到匹配的资产"
          description="换个关键词，或清空搜索查看全部资产。"
        />
      </div>
      <DramaNotice tone="warning">画布尚未保存，请检查保存状态后重试</DramaNotice>
      <DramaNotice tone="error">引用栏试听失败，请重试</DramaNotice>
      <DramaTaskStatusStack jobs={jobs} />
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
