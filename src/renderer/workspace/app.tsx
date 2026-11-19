import { type AppInfo, isAppInfo } from "@link-studio/core";
import {
  addEdge,
  Background,
  type Connection,
  Controls,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import {
  ArrowDownLeft,
  AudioLines,
  Check,
  ChevronRight,
  CircleHelp,
  Cpu,
  Image,
  Layers3,
  MessageCircle,
  Plus,
  ScanLine,
  Settings2,
  Sparkles,
  Type,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import brandIcon from "../../../resources/brand/icon.svg";
import { NODE_KINDS, NODE_LABELS, type NodeKind, useWorkspace } from "./store";

const NODE_ICONS = { script: Type, image: Image, video: Video, audio: AudioLines };
type CreativeNode = Node<{ kind: NodeKind; label: string; text: string }, "creative">;

const initialNodes: CreativeNode[] = [
  {
    id: "welcome",
    type: "creative",
    position: { x: 100, y: 130 },
    data: {
      kind: "script",
      label: "从一个想法开始",
      text: "写下一段故事，或将你的创作想法放在这里。",
    },
  },
];

function CreativeCard({ data, id, selected }: NodeProps<CreativeNode>) {
  const Icon = NODE_ICONS[data.kind];
  const { updateNodeData } = useReactFlow<CreativeNode>();
  return (
    <article className={`creative-card ${selected ? "is-selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <header>
        <span className={`node-icon ${data.kind}`}>
          <Icon size={17} />
        </span>
        <strong>{data.label}</strong>
        <span className="node-kind">{NODE_LABELS[data.kind]}</span>
      </header>
      <label className="node-body nodrag nopan">
        <span className="sr-only">{data.label}内容</span>
        <textarea
          value={data.text}
          onChange={(event) => updateNodeData(id, { text: event.target.value })}
          aria-label={`${data.label}内容`}
          placeholder={data.kind === "script" ? "写下你的创作想法…" : "描述你希望生成的内容…"}
          data-node-id={id}
        />
      </label>
      <footer>
        <span className="status-dot" />
        临时画布 · 未保存
      </footer>
      <Handle type="source" position={Position.Right} />
    </article>
  );
}

const nodeTypes = { creative: CreativeCard };

function RuntimePanel() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inspect = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await window.desktop.app.getInfo();
      if (result.ok && isAppInfo(result.data)) setInfo(result.data);
      else setError(result.ok ? "桌面返回的数据格式无效" : result.error.message);
    } catch {
      setError("未连接桌面宿主，请使用桌面应用启动。");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void inspect();
  }, [inspect]);

  return (
    <section className="runtime-panel">
      <div className="panel-title">
        <Cpu size={18} />
        <h2>运行环境</h2>
      </div>
      <p className="muted">通过受限桌面接口读取当前应用信息。</p>
      {loading && <p role="status">正在检查…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {info && (
        <>
          <div className="connection-status">
            <Check size={15} />
            桌面连接正常
          </div>
          <dl>
            <div>
              <dt>应用</dt>
              <dd>
                {info.productName} {info.version}
              </dd>
            </div>
            <div>
              <dt>平台</dt>
              <dd>
                {info.platform} / {info.arch}
              </dd>
            </div>
            <div>
              <dt>Electron</dt>
              <dd>{info.electron}</dd>
            </div>
            <div>
              <dt>Chromium</dt>
              <dd>{info.chromium}</dd>
            </div>
            <div>
              <dt>Node.js</dt>
              <dd>{info.node}</dd>
            </div>
          </dl>
        </>
      )}
      <button
        type="button"
        className="secondary-button"
        disabled={loading}
        onClick={() => void inspect()}
      >
        重新检查
      </button>
    </section>
  );
}

export function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState<CreativeNode>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { sidePanel, setSidePanel } = useWorkspace();
  const [showGuide, setShowGuide] = useState(false);
  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) => addEdge(connection, current));
    },
    [setEdges],
  );

  const addNode = (kind: NodeKind) => {
    setNodes((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        type: "creative",
        position: {
          x: 100 + (current.length % 2) * 350,
          y: 130 + Math.floor(current.length / 2) * 280,
        },
        data: { kind, label: `新的${NODE_LABELS[kind]}节点`, text: "" },
      },
    ]);
  };

  return (
    <div className="studio-shell">
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark" src={brandIcon} alt="" width={36} height={36} />
          <strong>灵可</strong>
          <span>Link Studio</span>
        </div>
        <div className="workspace-path">
          <span>本地工作区</span>
          <ChevronRight size={14} />
          <strong>创作练习</strong>
        </div>
        <span className="stage-label">M0 开发预览</span>
      </header>
      <nav className="rail" aria-label="工作区导航">
        <button
          type="button"
          className="rail-button active"
          aria-label="创作画布"
          onClick={() => setSidePanel("assistant")}
        >
          <Layers3 size={21} />
          <span>画布</span>
        </button>
        <div className="rail-bottom">
          <button
            type="button"
            className="rail-button"
            aria-label="操作说明"
            onClick={() => setShowGuide((shown) => !shown)}
          >
            <CircleHelp size={21} />
            <span>帮助</span>
          </button>
          <button
            type="button"
            className="rail-button"
            aria-label="运行环境"
            onClick={() => setSidePanel("runtime")}
          >
            <Settings2 size={21} />
            <span>环境</span>
          </button>
        </div>
      </nav>
      <main className="canvas-area">
        <div className="canvas-heading">
          <div>
            <h1>让想法，连成画面</h1>
            <p>添加节点，自由组织你的创作思路。</p>
          </div>
          <span className="local-badge">
            <span className="status-dot" />
            本地模式
          </span>
        </div>
        <div className="canvas-toolbar" role="toolbar" aria-label="添加创作节点">
          <span className="toolbar-label">
            <Plus size={16} />
            添加节点
          </span>
          {NODE_KINDS.map((kind) => {
            const Icon = NODE_ICONS[kind];
            return (
              <button type="button" key={kind} onClick={() => addNode(kind)}>
                <Icon size={17} />
                {NODE_LABELS[kind]}
              </button>
            );
          })}
        </div>
        <div className="flow-container">
          <ReactFlow<CreativeNode>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            defaultViewport={{ x: 20, y: 10, zoom: 0.9 }}
            minZoom={0.2}
            maxZoom={2}
            colorMode="dark"
            deleteKeyCode={["Backspace", "Delete"]}
          >
            <Background gap={24} size={1} color="#343b46" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        {showGuide && (
          <section className="guide" aria-label="操作说明">
            <strong>画布操作</strong>
            <p>
              拖动节点调整位置，拖动两侧连接点建立连线。选中后按 Delete
              删除，使用左下角控件缩放或适配视图。
            </p>
            <button type="button" onClick={() => setShowGuide(false)}>
              知道了
            </button>
          </section>
        )}
        <div className="canvas-notice">
          <ScanLine size={15} />
          <span>临时验证画布：关闭后内容不保留，项目保存与模型生成尚未接入。</span>
        </div>
      </main>
      <aside className="side-panel">
        <div className="panel-tabs">
          <button
            type="button"
            aria-pressed={sidePanel === "assistant"}
            onClick={() => setSidePanel("assistant")}
          >
            <Sparkles size={16} />
            小灵
          </button>
          <button
            type="button"
            aria-pressed={sidePanel === "runtime"}
            onClick={() => setSidePanel("runtime")}
          >
            <Cpu size={16} />
            运行环境
          </button>
        </div>
        {sidePanel === "runtime" ? (
          <RuntimePanel />
        ) : (
          <section className="assistant-panel">
            <span className="assistant-avatar">
              <Sparkles size={27} />
            </span>
            <h2>你好，我是小灵</h2>
            <p>
              未来，我会在这里陪你打磨创意，
              <br />
              组织画布，完成视频创作。
            </p>
            <div className="assistant-state">
              <MessageCircle size={18} />
              <div>
                <strong>助手引擎正在迁移</strong>
                <span>当前预览暂不支持对话和执行任务。</span>
              </div>
            </div>
            <div className="assistant-hint">
              <ArrowDownLeft size={18} />
              <span>先从画布上添加一个节点开始。</span>
            </div>
          </section>
        )}
        <footer className="panel-footer">项目在本地，创意由你掌控。</footer>
      </aside>
      <footer className="statusbar">
        <span>
          <span className="status-dot" />
          离线可编辑
        </span>
        <span>
          {nodes.length} 个节点 · {edges.length} 条连线
        </span>
        <span>灵可 · 开发验证工作区</span>
      </footer>
    </div>
  );
}
