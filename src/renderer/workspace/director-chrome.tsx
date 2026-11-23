import {
  CloudCheck,
  Download,
  Grid2x2,
  LoaderCircle,
  Redo2,
  TriangleAlert,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";

const tap = { scale: 0.96 };

export function DirectorTool({
  title,
  active,
  wide,
  disabled,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  wide?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <motion.button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      whileTap={disabled ? undefined : tap}
      className={wide ? "director-tool wide" : "director-tool"}
      onClick={onClick}
    >
      {children}
    </motion.button>
  );
}

export function DirectorHeader({
  label,
  undo,
  redo,
  snap,
  labels,
  toggleSnap,
  toggleLabels,
  status,
  blocked,
  onExport,
  close,
}: {
  label: string;
  undo?: () => void;
  redo?: () => void;
  snap: boolean;
  labels: boolean;
  toggleSnap: () => void;
  toggleLabels: () => void;
  status: string;
  blocked: string | null;
  onExport: () => void;
  close: () => void;
}) {
  const saving = status === "保存中…",
    oversize = !saving && status !== "已保存到节点";
  return (
    <header className="director-header">
      <span className="director-title">{label}</span>
      <DirectorTool title="撤销（Ctrl+Z）" disabled={!undo} onClick={() => undo?.()}>
        <Undo2 />
      </DirectorTool>
      <DirectorTool title="重做（Ctrl+Shift+Z）" disabled={!redo} onClick={() => redo?.()}>
        <Redo2 />
      </DirectorTool>
      <span className="director-tool-rule" />
      <DirectorTool
        title="吸附：移动 0.25 米、旋转 15° 一档"
        active={snap}
        wide
        onClick={toggleSnap}
      >
        <Grid2x2 />
        吸附
      </DirectorTool>
      <DirectorTool title="显示人物和机位名称" active={labels} wide onClick={toggleLabels}>
        <Type />
        标签
      </DirectorTool>
      <span className="director-header-spacer" />
      <span
        role="status"
        data-oversize={oversize || undefined}
        title={oversize ? status : undefined}
      >
        {saving ? (
          <LoaderCircle className="director-saving" />
        ) : oversize ? (
          <TriangleAlert />
        ) : (
          <CloudCheck />
        )}
        {oversize ? "场景过大，未保存" : status}
      </span>
      <motion.button
        type="button"
        className="director-open-export"
        disabled={!!blocked}
        whileTap={blocked ? undefined : tap}
        onClick={onExport}
        title={blocked ?? "导出运镜预览视频"}
      >
        <Download />
        导出视频
      </motion.button>
      <DirectorTool title="关闭（自动保存）" onClick={close}>
        <X />
      </DirectorTool>
    </header>
  );
}
