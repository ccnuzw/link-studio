import type { ProjectCanvasView } from "@link-studio/core";
import { Group } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { linkKind } from "./link-rules";
import "./assistant-selection.css";

const labels = {
  group: "节点组",
  script: "文本节点",
  image: "图片节点",
  video: "视频节点",
  audio: "音频节点",
  character: "角色卡节点",
  storyboard: "分镜表节点",
  director: "导演台",
};

export function AssistantSelection({
  ids,
  nodes,
  locate,
}: {
  ids: string[];
  nodes: ReadonlyMap<string, ProjectCanvasView["nodes"][number]>;
  locate: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const reduce = useReducedMotion();
  const unique = [...new Set(ids)];
  if (!unique.length) return null;
  return (
    <fieldset
      data-ui-group
      className="assistant-selection"
      aria-label={`引用了 ${unique.length} 个节点`}
    >
      {(expanded ? unique : unique.slice(0, 3)).map((id, index) => {
        const node = nodes.get(id);
        const kind = node?.type === "creative" ? linkKind(node.data) : node?.type;
        const missing = !kind || kind === "unknown" || kind === "director";
        return (
          <motion.button
            key={id}
            type="button"
            disabled={missing}
            title={missing ? "这个节点已经被删除了" : "在画布上定位"}
            initial={expanded && index >= 3 ? { opacity: 0, y: reduce ? 0 : 2 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.12, ease: [0.2, 0, 0, 1] }}
            whileTap={missing ? undefined : { scale: 0.96 }}
            onClick={() => locate(id)}
          >
            {kind === "group" ? <Group aria-hidden /> : <i aria-hidden />}
            <span>{missing ? "已删除的节点" : node?.data.label.trim() || labels[kind]}</span>
          </motion.button>
        );
      })}
      {!expanded && unique.length > 3 && (
        <motion.button
          type="button"
          aria-label={`再展开 ${unique.length - 3} 个节点`}
          whileTap={{ scale: 0.96 }}
          onClick={() => setExpanded(true)}
        >
          +{unique.length - 3}
        </motion.button>
      )}
    </fieldset>
  );
}
