import { Tooltip } from "@base-ui/react/tooltip";
import { ArrowRight, LayoutGrid, TriangleAlert } from "lucide-react";
import { motion } from "motion/react";
import { useRef } from "react";
import { CanvasControlTip } from "./canvas-control-tip";
import { reportLinkNotice } from "./canvas-toaster";

export function CanvasStatsBar({
  edgeCount,
  nodeCount,
  failed,
  focus,
}: {
  edgeCount: number;
  nodeCount: number;
  failed: string[];
  focus: (id: string) => boolean;
}) {
  const cursor = useRef(0);
  function locateFailure() {
    const id = failed[cursor.current % failed.length];
    if (!id) {
      reportLinkNotice("没有失败的节点");
      return;
    }
    focus(id);
    cursor.current++;
  }
  return (
    <fieldset className="canvas-controls canvas-stats-zone" data-ui-group aria-label="画布统计">
      <div className="canvas-control-pill">
        <span title="连线">
          <ArrowRight size={14} />
          {edgeCount}
        </span>
        <span title="节点">
          <LayoutGrid size={14} />
          {nodeCount}
        </span>
        <Tooltip.Provider delay={0}>
          <CanvasControlTip label={failed.length ? "定位失败的节点" : "没有失败的节点"}>
            <motion.button
              type="button"
              aria-label={`失败节点 ${failed.length} 个`}
              data-warning={!!failed.length}
              whileTap={{ scale: 0.96 }}
              onClick={locateFailure}
            >
              <TriangleAlert size={14} />
              {failed.length}
            </motion.button>
          </CanvasControlTip>
        </Tooltip.Provider>
      </div>
    </fieldset>
  );
}
