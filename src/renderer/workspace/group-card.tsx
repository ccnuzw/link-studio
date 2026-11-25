import type { GroupHue } from "@link-studio/core";
import { type Node, type NodeProps, NodeResizer, useReactFlow } from "@xyflow/react";
import type { CSSProperties } from "react";
import { useAgentMark } from "./agent-marks";
import { GroupTitle } from "./node-title";

type GroupNode = Node<{ label: string; color?: GroupHue; labelColor?: GroupHue }, "group">;

export function GroupNodeCard({
  data,
  id,
  selected,
  draggable,
  writing,
}: NodeProps<GroupNode> & { writing?: boolean }) {
  const mark = useAgentMark(id);
  const { updateNodeData, getNode, getNodes } = useReactFlow();
  return (
    <div className="canvas-group" data-agent-mark={mark}>
      <NodeResizer
        isVisible={selected && draggable && !writing}
        minWidth={200}
        minHeight={140}
        handleClassName="group-resize-corner"
        lineClassName="group-resize-line"
        shouldResize={(_event, next) => {
          const group = getNode(id);
          if (!group) return false;
          const { x, y } = group.position;
          const width = group.width ?? group.measured?.width ?? 200;
          const height = group.height ?? group.measured?.height ?? 140;
          return getNodes()
            .filter((node) => node.parentId === id)
            .every((member) => {
              const left = x + member.position.x,
                top = y + member.position.y;
              const right = left + (member.measured?.width ?? member.width ?? 576);
              const bottom = top + (member.measured?.height ?? member.height ?? 324);
              return (
                next.x <= Math.max(x, left - 8) &&
                next.y <= Math.max(y, top - 40) &&
                next.x + next.width >= Math.min(x + width, right + 8) &&
                next.y + next.height >= Math.min(y + height, bottom + 8)
              );
            });
        }}
      />
      <div
        className="canvas-group-frame"
        style={
          data.color
            ? ({
                backgroundColor: `color-mix(in oklch,var(--group-${data.color}) 16%,transparent)`,
                "--group-frame-color": `color-mix(in oklch,var(--group-${data.color}) 40%,transparent)`,
              } as CSSProperties)
            : undefined
        }
      />
      <GroupTitle
        id={id}
        label={data.label}
        labelColor={data.labelColor}
        disabled={writing}
        commit={(label) => updateNodeData(id, { label })}
      />
    </div>
  );
}
