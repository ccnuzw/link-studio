import { evenGridLines, GRID_MAX, GRID_MIN_GAP, type ProjectAsset } from "@link-studio/core";
import { Grid2X2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type GridSplitDraft = { xLines: number[]; yLines: number[] };
const gridCounts = Array.from({ length: GRID_MAX }, (_, index) => index + 1);

export function GridSplitDialog({
  asset,
  url,
  busy,
  error,
  capacity,
  close,
  cancel,
  cancelling,
  submit,
}: {
  asset: ProjectAsset;
  url: string;
  busy: boolean;
  error: string;
  capacity: number;
  close: () => void;
  cancel?: () => void;
  cancelling: boolean;
  submit: (draft: GridSplitDraft) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const width = Number(asset.metadata.width) || 1;
  const height = Number(asset.metadata.height) || 1;
  const [xLines, setXLines] = useState(() => evenGridLines(Math.min(2, width)));
  const [yLines, setYLines] = useState(() => evenGridLines(Math.min(2, height)));
  const [imageStatus, setImageStatus] = useState<"loading" | "ready" | "failed">("loading");
  const count = (xLines.length + 1) * (yLines.length + 1);
  const message = error || (count > capacity ? "画布剩余容量不足，请减少行列数。" : "");
  useEffect(() => dialog.current?.showModal(), []);

  const renderLines = (axis: "x" | "y", lines: number[], update: (next: number[]) => void) =>
    gridCounts.slice(0, lines.length).map((lineNumber) => {
      const index = lineNumber - 1;
      const line = lines[index] ?? 0;
      const adjust = (value: number) => {
        const minimum = (lines[index - 1] ?? 0) + GRID_MIN_GAP;
        const maximum = (lines[index + 1] ?? 1) - GRID_MIN_GAP;
        update(
          lines.map((item, itemIndex) =>
            itemIndex === index ? Math.max(minimum, Math.min(maximum, value)) : item,
          ),
        );
      };
      return (
        <button
          key={`${axis}-${lineNumber}`}
          type="button"
          className="grid-split-line"
          data-axis={axis}
          aria-label={`${axis === "x" ? "竖" : "横"}分割线 ${index + 1}，${Math.round(line * 100)}%`}
          style={axis === "x" ? { left: `${line * 100}%` } : { top: `${line * 100}%` }}
          disabled={busy}
          onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const rect = event.currentTarget.parentElement?.getBoundingClientRect();
            if (rect)
              adjust(
                axis === "x"
                  ? (event.clientX - rect.left) / rect.width
                  : (event.clientY - rect.top) / rect.height,
              );
          }}
          onKeyDown={(event) => {
            const negative = axis === "x" ? "ArrowLeft" : "ArrowUp";
            const positive = axis === "x" ? "ArrowRight" : "ArrowDown";
            if (event.key !== negative && event.key !== positive) return;
            event.preventDefault();
            adjust(line + (event.key === positive ? 0.01 : -0.01));
          }}
        />
      );
    });

  return (
    <dialog
      ref={dialog}
      className="grid-split-dialog"
      aria-labelledby="grid-split-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <header>
        <h2 id="grid-split-title">
          <Grid2X2 size={19} /> 宫格拆图
        </h2>
        <span>{asset.displayName}</span>
      </header>
      <div
        className="grid-split-preview"
        style={{
          width: `min(100%, ${Math.min(640, (width / height) * 360)}px)`,
          aspectRatio: width / height,
        }}
      >
        <img
          src={url}
          alt={asset.displayName}
          onLoad={() => setImageStatus("ready")}
          onError={() => setImageStatus("failed")}
        />
        {renderLines("x", xLines, setXLines)}
        {renderLines("y", yLines, setYLines)}
      </div>
      <section className="grid-split-controls" aria-label="宫格设置">
        <label>
          行数{" "}
          <select
            disabled={busy}
            value={yLines.length + 1}
            onChange={(event) => setYLines(evenGridLines(Number(event.target.value)))}
          >
            {gridCounts
              .filter((count) => count <= height)
              .map((count) => (
                <option key={count}>{count}</option>
              ))}
          </select>
        </label>
        <label>
          列数{" "}
          <select
            disabled={busy}
            value={xLines.length + 1}
            onChange={(event) => setXLines(evenGridLines(Number(event.target.value)))}
          >
            {gridCounts
              .filter((count) => count <= width)
              .map((count) => (
                <option key={count}>{count}</option>
              ))}
          </select>
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setXLines(evenGridLines(xLines.length + 1));
            setYLines(evenGridLines(yLines.length + 1));
          }}
        >
          恢复均分
        </button>
      </section>
      <p>拖动分割线调整。也可以聚焦分割线后用方向键微调。</p>
      {(message || imageStatus === "failed") && (
        <p role="alert">{message || "无法载入图片预览，请重新定位素材。"}</p>
      )}
      <footer>
        <button
          type="button"
          disabled={cancelling || (busy && !cancel)}
          onClick={busy ? cancel : close}
        >
          {cancelling ? "正在取消…" : busy ? "取消拆图" : "取消"}
        </button>
        <button
          type="button"
          className="grid-split-primary"
          disabled={busy || count < 2 || count > capacity || imageStatus !== "ready"}
          onClick={() => submit({ xLines, yLines })}
        >
          {busy ? "正在拆图…" : `拆成 ${count} 张图片`}
        </button>
      </footer>
    </dialog>
  );
}
