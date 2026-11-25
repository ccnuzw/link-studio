import type { ProjectValues } from "@link-studio/core";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import { useLayoutEffect, useRef } from "react";

export type ReadonlyView = Extract<ProjectValues["open"], { disposition: "readOnly" }>;

export function ReadonlyCanvas({
  view,
  busy,
  error,
  retry,
  close,
}: {
  view: ReadonlyView;
  busy: boolean;
  error: string;
  retry: () => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    dialog.current?.showModal();
  }, []);
  const nodes = view.canvas.nodes.map((node) => ({
    id: node.id,
    position: node.position,
    ...("parentId" in node && { parentId: node.parentId }),
    type: node.type === "group" ? "group" : "default",
    style: {
      width: node.type === "group" ? node.width : 220,
      height: node.type === "group" ? node.height : 100,
    },
    data: {
      label: (
        <>
          <b>{node.data.label}</b>
          {node.type === "creative" && <p>{node.data.text}</p>}
        </>
      ),
    },
  }));
  return (
    <dialog
      ref={dialog}
      className="readonly-canvas"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
      aria-label="只读画布"
    >
      <header>
        <b>{view.name} · 只读</b>
        <span>版本 {view.revision}。另一实例正在编辑；请先在原实例保存并关闭项目。</span>
        <button type="button" disabled={busy} onClick={retry}>
          刷新并尝试接管
        </button>
        <button type="button" disabled={busy} onClick={close}>
          关闭
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      <div className="readonly-stage">
        <ReactFlow
          nodes={nodes}
          edges={view.canvas.edges}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          defaultViewport={view.canvas.viewport}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </dialog>
  );
}
