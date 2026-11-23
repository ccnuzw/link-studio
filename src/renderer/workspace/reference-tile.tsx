import { Link2, Play, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useContext } from "react";
import { Thumb, useThumbURL } from "./canvas-prompt-editor";
import type { MentionSource } from "./mention-sources";
import { RefHighlight } from "./ref-highlight";
import { useRefPeek } from "./use-ref-peek";

export function ReferenceTile({
  source,
  projectHandle,
  used,
  disabled,
  running,
  locate,
  remove,
}: {
  source: MentionSource;
  projectHandle?: string;
  used: boolean;
  disabled: boolean;
  running?: boolean;
  locate?: (id: string) => void;
  remove: () => void;
}) {
  const highlight = useContext(RefHighlight);
  const url = useThumbURL(source, projectHandle);
  const { bind, peek } = useRefPeek(
    { kind: source.kind, mediaType: source.kind === "character" ? "image" : undefined, src: url },
    `${source.label} 的大图`,
  );
  const label = locate ? `断开「${source.label}」的引用` : "移除这份素材";
  const thumb = <Thumb source={source} url={url} projectHandle={projectHandle} />;
  const reduce = useReducedMotion();
  const empty = source.kind === "script" ? !source.text?.trim() : !source.assetId;
  const note = running || empty ? " · 还没生成" : used ? "" : " · 当前生成方式用不到";
  return (
    <motion.span
      className="canvas-reference-tile"
      data-empty={(!!locate && empty) || undefined}
      data-linked={!!locate || undefined}
      title={locate ? undefined : `${source.label}（手动添加）`}
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.126, ease: [0.2, 0, 0, 1] } }}
      transition={{ type: "spring", stiffness: 500, damping: 38, mass: 0.8 }}
      {...bind}
      data-lit={(!!locate && highlight?.id === source.id) || undefined}
      onMouseEnter={() => locate && highlight?.set(source.id)}
      onMouseLeave={() => locate && highlight?.set(null)}
    >
      {locate ? (
        <>
          <motion.button
            whileTap={{ scale: 0.96 }}
            type="button"
            className="reference-locate"
            aria-label={`引用：${source.label}，点击定位到节点`}
            title={`${source.label}${note}\n点击定位到节点`}
            style={{ opacity: used ? 1 : 0.4 }}
            onClick={() => locate(source.id)}
          >
            {thumb}
          </motion.button>
          <span className="reference-link-badge">
            <Link2 />
          </span>
          {source.kind === "video" && !empty && (
            <span className="reference-video-badge">
              <Play />
            </span>
          )}
        </>
      ) : (
        thumb
      )}
      <motion.button
        whileTap={{ scale: 0.96 }}
        type="button"
        className="reference-remove"
        title={label}
        aria-label={label}
        disabled={disabled}
        onClick={() => {
          highlight?.set(null);
          remove();
        }}
      >
        <X />
      </motion.button>
      {peek}
    </motion.span>
  );
}
