import { NodeToolbar, Position, useStore, ViewportPortal } from "@xyflow/react";
import { Loader2 } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { canvasNotice } from "./canvas-toaster";
import { DOODLE_COLORS, DOODLE_WIDTH_DEFAULT, doodleCanvasSize, doodleDisplayRect } from "./doodle";
import { createDoodleEngine, type DoodleEngine, type DoodleTool } from "./doodle-engine";
import { DoodleToolbar } from "./doodle-toolbar";

export function ImageDoodleOverlay({
  nodeId,
  url,
  error,
  onSave,
  onClose,
}: {
  nodeId: string;
  url: string;
  error?: string;
  onSave: (render: () => Promise<string>, aspect: number) => boolean;
  onClose: () => void;
}) {
  const zoom = useStore((state) => state.transform[2]);
  const host = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<HTMLImageElement>();
  const close = useRef(onClose);
  close.current = onClose;
  const engine = useRef<DoodleEngine>(null);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");
  const [tool, setTool] = useState<DoodleTool>("pen");
  const [color, setColor] = useState<string>(DOODLE_COLORS[0]);
  const [width, setWidth] = useState(DOODLE_WIDTH_DEFAULT);
  const settings = useRef({ tool, color, width });
  settings.current = { tool, color, width };
  const saving = useRef(false);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const geometry = useStore((state) => {
    const node = state.nodeLookup.get(nodeId);
    if (!node?.measured.width || !node.measured.height) return "";
    const { x, y } = node.internals.positionAbsolute;
    return `${x},${y},${node.measured.width},${node.measured.height}`;
  });
  const [left = 0, top = 0, widthPx = 0, heightPx = 0] = geometry.split(",").map(Number);
  const rect =
    source && widthPx && heightPx
      ? doodleDisplayRect(
          { w: source.naturalWidth, h: source.naturalHeight },
          { width: widthPx, height: heightPx },
        )
      : undefined;
  const display = useRef(rect);
  display.current = rect;
  const hasRect = !!rect;
  const fail = useCallback(() => {
    toast.error("涂鸦组件加载失败，请检查网络后重试", canvasNotice);
    close.current();
  }, []);
  useEffect(() => {
    let disposed = false;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.src = url;
    setSource(undefined);
    void image
      .decode()
      .then(() => {
        if (!disposed) setSource(image);
      })
      .catch(() => {
        if (!disposed) fail();
      });
    return () => {
      disposed = true;
    };
  }, [url, fail]);
  useEffect(() => {
    const stage = host.current;
    if (!hasRect || !stage || !source) return;
    let disposed = false;
    setReady(false);
    void import("fabric")
      .then((fabric) => {
        if (disposed || !display.current) return;
        engine.current = createDoodleEngine({
          fabric,
          host: stage,
          size: doodleCanvasSize({ w: source.naturalWidth, h: source.naturalHeight }),
          display: display.current,
          ...settings.current,
          onChange: () => {
            if (!disposed)
              setHistory({ undo: !!engine.current?.canUndo(), redo: !!engine.current?.canRedo() });
          },
        });
        setReady(true);
      })
      .catch(() => {
        if (!disposed) fail();
      });
    return () => {
      disposed = true;
      engine.current?.dispose();
      engine.current = null;
    };
  }, [source, hasRect, fail]);
  useEffect(() => {
    if (display.current) engine.current?.setDisplay(display.current);
  }, [rect?.width, rect?.height]);
  useEffect(() => {
    const exit = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.isComposing ||
        (event.target instanceof HTMLElement && event.target.dataset.fabric === "textarea")
      )
        return;
      if (!event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", exit);
    return () => window.removeEventListener("keydown", exit);
  }, [onClose]);
  const save = () => {
    const active = engine.current;
    if (!active || !source || saving.current) return;
    active.commit();
    if (!active.hasContent()) return void toast("还没有标注内容", canvasNotice);
    const image = source;
    try {
      const layer = active.exportLayer();
      const render = async () => {
        const output = document.createElement("canvas");
        output.width = layer.width;
        output.height = layer.height;
        const context = output.getContext("2d");
        if (!context) throw new Error("涂鸦图导出失败：浏览器不支持画布");
        const bitmap = await createImageBitmap(image);
        try {
          context.drawImage(bitmap, 0, 0, layer.width, layer.height);
        } finally {
          bitmap.close();
        }
        context.drawImage(layer, 0, 0);
        const blob = await new Promise<Blob>((resolve, reject) =>
          output.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error("涂鸦图导出失败"))),
            "image/png",
          ),
        );
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      };
      saving.current = onSave(render, image.naturalWidth / image.naturalHeight);
    } catch {
      setMessage("无法读取原图像素");
    }
  };
  return (
    <>
      {rect && (
        <ViewportPortal>
          <div
            style={{
              transform: `translate(${left + rect.x}px,${top + rect.y}px)`,
              width: rect.width,
              height: rect.height,
            }}
            aria-label="涂鸦画布"
            role="application"
            className="canvas-doodle-stage nodrag nopan nowheel"
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            <div ref={host} className="doodle-host" />
            {!ready && (
              <div className="doodle-stage-loading">
                <Loader2 aria-label="涂鸦画布加载中" />
              </div>
            )}
          </div>
        </ViewportPortal>
      )}
      <NodeToolbar nodeId={nodeId} isVisible position={Position.Top} offset={28 * zoom + 16}>
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
        >
          <DoodleToolbar
            tool={tool}
            color={color}
            width={width}
            canUndo={history.undo}
            canRedo={history.redo}
            saveDisabled={!ready}
            onToolChange={(value) => {
              setTool(value);
              engine.current?.setTool(value);
            }}
            onWidthChange={(value) => {
              setWidth(value);
              engine.current?.setWidth(value);
            }}
            onColorChange={(value) => {
              setColor(value);
              engine.current?.setColor(value);
            }}
            onUndo={() => engine.current?.undo()}
            onRedo={() => engine.current?.redo()}
            onSave={save}
            onClose={onClose}
            onInteract={() => engine.current?.commit()}
          />
        </motion.div>
        {(message || error) && <output className="canvas-surface">{error || message}</output>}
      </NodeToolbar>
    </>
  );
}
