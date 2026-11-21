import { Eraser, PenLine, Redo2, RotateCcw, Save, Undo2, X } from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

type Tool = "pen" | "eraser";
type Point = { x: number; y: number };

const colors = ["#ef4444", "#f59e0b", "#22c55e", "#06b6d4", "#3b82f6", "#a855f7", "#ffffff"];
const maxEdge = 4096;

export function ImageDoodleDialog({
  assetName,
  url,
  busy,
  error,
  onSave,
  onClose,
}: {
  assetName: string;
  url: string;
  busy: boolean;
  error?: string;
  onSave: (pngData: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(colors[0] ?? "#ef4444");
  const [width, setWidth] = useState(8);
  const [ready, setReady] = useState(false);
  const [aspect, setAspect] = useState(1);
  const [drawing, setDrawing] = useState(false);
  const [undoStack, setUndoStack] = useState<ImageData[]>([]);
  const [redoStack, setRedoStack] = useState<ImageData[]>([]);
  const [hasMarks, setHasMarks] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const last = useRef<Point | undefined>(undefined);

  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);

  const resize = () => {
    const source = image.current;
    const canvas = overlay.current;
    if (!source || !canvas || !source.naturalWidth || !source.naturalHeight) return;
    const scale = Math.min(1, maxEdge / Math.max(source.naturalWidth, source.naturalHeight));
    setAspect(source.naturalWidth / source.naturalHeight);
    canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setUndoStack([]);
    setRedoStack([]);
    setHasMarks(false);
    setReady(true);
  };

  const snapshot = () => {
    const canvas = overlay.current;
    const context = canvas?.getContext("2d");
    return canvas && context ? context.getImageData(0, 0, canvas.width, canvas.height) : undefined;
  };

  const keepHistory = (states: ImageData[], state: ImageData) => {
    const limit = Math.max(1, Math.min(30, Math.floor((64 * 1024 * 1024) / state.data.byteLength)));
    return [...states, state].slice(-limit);
  };

  const containsMarks = (state: ImageData | undefined) =>
    state?.data.some((value, index) => index % 4 === 3 && value !== 0) ?? false;

  const restore = (state: ImageData | undefined) => {
    const canvas = overlay.current;
    const context = canvas?.getContext("2d");
    if (canvas && context && state) context.putImageData(state, 0, 0);
  };

  const begin = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (busy || !ready || event.button !== 0 || last.current) return;
    const canvas = overlay.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const bounds = canvas.getBoundingClientRect();
    const point = {
      x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
      y: ((event.clientY - bounds.top) / bounds.height) * canvas.height,
    };
    const state = snapshot();
    if (state) setUndoStack((current) => keepHistory(current, state));
    setRedoStack([]);
    canvas.setPointerCapture(event.pointerId);
    setDrawing(true);
    last.current = point;
    context.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    context.strokeStyle = color ?? "#ef4444";
    context.lineWidth = width * (canvas.width / bounds.width);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(point.x, point.y);
    context.lineTo(point.x + 0.01, point.y + 0.01);
    context.stroke();
    setHasMarks(true);
  };

  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const canvas = overlay.current;
    const context = canvas?.getContext("2d");
    const previous = last.current;
    if (!canvas || !context || !previous) return;
    const bounds = canvas.getBoundingClientRect();
    const point = {
      x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
      y: ((event.clientY - bounds.top) / bounds.height) * canvas.height,
    };
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    setHasMarks(true);
    last.current = point;
  };

  const end = () => {
    if (last.current && tool === "eraser") setHasMarks(containsMarks(snapshot()));
    setDrawing(false);
    last.current = undefined;
  };

  const undo = () => {
    const current = snapshot();
    const previous = undoStack.at(-1);
    if (!current || !previous) return;
    setRedoStack((stack) => keepHistory(stack, current));
    setUndoStack((stack) => stack.slice(0, -1));
    restore(previous);
    setHasMarks(containsMarks(previous));
  };

  const redo = () => {
    const current = snapshot();
    const next = redoStack.at(-1);
    if (!current || !next) return;
    setUndoStack((stack) => keepHistory(stack, current));
    setRedoStack((stack) => stack.slice(0, -1));
    restore(next);
    setHasMarks(containsMarks(next));
  };

  const clear = () => {
    const canvas = overlay.current;
    const context = canvas?.getContext("2d");
    const current = snapshot();
    if (!canvas || !context || !current) return;
    setUndoStack((stack) => keepHistory(stack, current));
    setRedoStack([]);
    context.clearRect(0, 0, canvas.width, canvas.height);
    setHasMarks(false);
  };

  const save = () => {
    const source = image.current;
    const layer = overlay.current;
    if (busy || !ready || !source || !layer) return;
    const output = document.createElement("canvas");
    output.width = layer.width;
    output.height = layer.height;
    const context = output.getContext("2d");
    if (!context) return;
    try {
      context.drawImage(source, 0, 0, output.width, output.height);
      context.drawImage(layer, 0, 0);
      onSave(output.toDataURL("image/png"));
    } catch {
      setPreviewError("无法读取原图像素，请关闭标注后重新打开图片。");
    }
  };

  return (
    <dialog
      ref={dialog}
      className="image-doodle-dialog"
      aria-labelledby="image-doodle-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <div>
          <h2 id="image-doodle-title">图片涂鸦标注</h2>
          <p>{assetName}</p>
        </div>
        <button type="button" aria-label="关闭涂鸦标注" onClick={onClose} disabled={busy}>
          <X size={18} />
        </button>
      </header>
      <div className="image-doodle-stage">
        <div className="image-doodle-frame" style={{ "--doodle-aspect": aspect } as CSSProperties}>
          <img
            ref={image}
            crossOrigin="anonymous"
            src={url}
            alt={assetName}
            onLoad={resize}
            onError={() => setPreviewError("原图加载失败，请关闭标注后重新打开图片。")}
          />
          <canvas
            ref={overlay}
            aria-label="涂鸦画布"
            onPointerDown={begin}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onLostPointerCapture={end}
          />
        </div>
      </div>
      <div className="image-doodle-toolbar" role="toolbar" aria-label="涂鸦工具">
        <button
          type="button"
          className={tool === "pen" ? "active" : ""}
          onClick={() => setTool("pen")}
        >
          <PenLine size={16} /> 画笔
        </button>
        <button
          type="button"
          className={tool === "eraser" ? "active" : ""}
          onClick={() => setTool("eraser")}
        >
          <Eraser size={16} /> 橡皮擦
        </button>
        <span className="image-doodle-colors">
          {colors.map((entry) => (
            <button
              key={entry}
              type="button"
              aria-label={`颜色 ${entry}`}
              className={entry === color ? "active" : ""}
              style={{ background: entry }}
              onClick={() => {
                setColor(entry);
                setTool("pen");
              }}
            />
          ))}
        </span>
        <label className="image-doodle-width">
          粗细
          <input
            type="range"
            min="2"
            max="40"
            value={width}
            onChange={(event) => setWidth(Number(event.target.value))}
          />
        </label>
        <button
          type="button"
          aria-label="撤销标注"
          onClick={undo}
          disabled={!undoStack.length || busy}
        >
          <Undo2 size={16} />
        </button>
        <button
          type="button"
          aria-label="重做标注"
          onClick={redo}
          disabled={!redoStack.length || busy}
        >
          <Redo2 size={16} />
        </button>
        <button
          type="button"
          aria-label="清空标注"
          onClick={clear}
          disabled={!ready || busy || !hasMarks}
        >
          <RotateCcw size={16} /> 清空
        </button>
      </div>
      {(previewError || error) && (
        <p className="image-doodle-error" role="alert">
          {previewError || error}
        </p>
      )}
      <footer>
        <button type="button" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          type="button"
          className="settings-primary"
          onClick={save}
          disabled={!ready || busy || drawing || !hasMarks || Boolean(previewError)}
        >
          <Save size={16} /> {busy ? "正在保存…" : "保存为新图片"}
        </button>
      </footer>
    </dialog>
  );
}
