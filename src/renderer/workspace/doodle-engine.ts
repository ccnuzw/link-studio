import type * as Fabric from "fabric";
import type { Canvas, FabricObject, IText, Rect } from "fabric";

import {
  createHistoryStack,
  DEFAULT_DOODLE_COLOR,
  DOODLE_WIDTH_DEFAULT,
  type DoodleItemLike,
  doodleFontSize,
  doodleScale,
  doodleStrokeWidth,
  hasDoodleContent,
  type PixelSize,
} from "./doodle";

export type FabricModule = typeof Fabric;

export type DoodleTool = "pen" | "rect" | "text";

const MIN_RECT_EDGE = 3;

const TEXT_FONT_FAMILY = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

export type DoodleEngine = {
  setTool: (tool: DoodleTool) => void;

  setColor: (color: string) => void;

  setWidth: (screenWidth: number) => void;

  setDisplay: (display: PixelSize) => void;

  commit: () => void;

  undo: () => void;

  redo: () => void;

  canUndo: () => boolean;

  canRedo: () => boolean;

  hasContent: () => boolean;

  exportLayer: () => HTMLCanvasElement;

  dispose: () => void;
};

export type DoodleEngineInput = {
  fabric: FabricModule;

  host: HTMLElement;

  size: PixelSize;

  display: PixelSize;

  tool: DoodleTool;

  color: string;

  width: number;

  onChange: () => void;
};

function lock(object: FabricObject): void {
  object.set({ selectable: false, evented: false });
}

function preventFocusScroll(text: IText): void {
  const init = text.initHiddenTextarea.bind(text);
  text.initHiddenTextarea = () => {
    init();
    const input = text.hiddenTextarea;
    if (!input) return;
    const focus = input.focus.bind(input);
    input.focus = (options?: FocusOptions) => focus({ ...options, preventScroll: true });
  };
}

export function createDoodleEngine(input: DoodleEngineInput): DoodleEngine {
  const { fabric, host, size, onChange } = input;
  const element = document.createElement("canvas");
  host.appendChild(element);

  const canvas: Canvas = new fabric.Canvas(element, {
    width: size.width,
    height: size.height,
    selection: false,
    preserveObjectStacking: true,

    enableRetinaScaling: false,
    stopContextMenu: true,
    fireRightClick: false,
  });

  const stack = createHistoryStack<FabricObject>();
  let tool = input.tool;
  let color = input.color || DEFAULT_DOODLE_COLOR;
  let screenWidth = input.width || DOODLE_WIDTH_DEFAULT;
  let scale = doodleScale(size.width, input.display.width);
  let closed = false;

  let draftRect: Rect | null = null;
  let draftOrigin = { x: 0, y: 0 };

  let pendingText: IText | null = null;

  let textEndedByThisDown = false;

  const applyBrush = () => {
    const brush = canvas.freeDrawingBrush;
    if (!brush) return;
    brush.color = color;
    brush.width = doodleStrokeWidth(screenWidth, scale);
  };

  canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
  canvas.freeDrawingCursor = "crosshair";

  const applyDisplay = (display: PixelSize) => {
    canvas.setDimensions(
      { width: `${display.width}px`, height: `${display.height}px` },
      { cssOnly: true },
    );
    scale = doodleScale(size.width, display.width);
    applyBrush();
  };
  applyDisplay(input.display);

  const setTool = (next: DoodleTool) => {
    canvas.discardActiveObject();
    tool = next;
    canvas.isDrawingMode = next === "pen";
    canvas.defaultCursor = next === "text" ? "text" : "crosshair";
    canvas.hoverCursor = canvas.defaultCursor;
    applyBrush();
    canvas.requestRenderAll();
  };
  setTool(tool);

  canvas.on("path:created", (event) => {
    lock(event.path);
    stack.push(event.path);
    onChange();
  });

  canvas.on("mouse:down:before", () => {
    textEndedByThisDown = false;
  });

  canvas.on("mouse:down", (event) => {
    if (tool === "rect") {
      const point = canvas.getScenePoint(event.e);
      draftOrigin = { x: point.x, y: point.y };
      draftRect = new fabric.Rect({
        left: point.x,
        top: point.y,

        originX: "left",
        originY: "top",
        width: 0,
        height: 0,

        fill: null,
        stroke: color,
        strokeWidth: doodleStrokeWidth(screenWidth, scale),

        strokeUniform: true,
        selectable: false,
        evented: false,
      });
      canvas.add(draftRect);
      return;
    }
    if (tool !== "text") return;

    if (event.target && (event.target as IText).isEditing) return;

    if (textEndedByThisDown) return;
    const point = canvas.getScenePoint(event.e);
    const text = new fabric.IText("", {
      left: point.x,
      top: point.y,
      originX: "left",
      originY: "top",
      fill: color,
      fontSize: doodleFontSize(screenWidth, scale),
      fontFamily: TEXT_FONT_FAMILY,

      hasControls: false,
      hasBorders: false,
      lockMovementX: true,
      lockMovementY: true,
    });
    text.on("editing:exited", () => {
      if (closed) return;
      textEndedByThisDown = true;
      if (text.text.trim() === "") {
        canvas.remove(text);
      } else {
        lock(text);
        stack.push(text);
      }
      canvas.requestRenderAll();
      onChange();
    });
    preventFocusScroll(text);
    canvas.add(text);
    canvas.setActiveObject(text);
    pendingText = text;
  });

  canvas.on("mouse:move", (event) => {
    if (tool !== "rect" || !draftRect) return;
    const point = canvas.getScenePoint(event.e);
    draftRect.set({
      left: Math.min(point.x, draftOrigin.x),
      top: Math.min(point.y, draftOrigin.y),
      width: Math.abs(point.x - draftOrigin.x),
      height: Math.abs(point.y - draftOrigin.y),
    });
    canvas.requestRenderAll();
  });

  canvas.on("mouse:up", () => {
    if (draftRect) {
      const rect = draftRect;
      draftRect = null;
      if ((rect.width ?? 0) < MIN_RECT_EDGE || (rect.height ?? 0) < MIN_RECT_EDGE) {
        canvas.remove(rect);
      } else {
        rect.setCoords();
        stack.push(rect);
        onChange();
      }
      canvas.requestRenderAll();
    }
    if (pendingText) {
      const text = pendingText;
      pendingText = null;
      text.enterEditing();
    }
  });

  const commit = () => {
    canvas.discardActiveObject();
  };

  return {
    setTool,
    setColor: (next) => {
      color = next;
      applyBrush();
    },
    setWidth: (next) => {
      screenWidth = next;
      applyBrush();
    },
    setDisplay: applyDisplay,
    commit,
    undo: () => {
      commit();
      const item = stack.undo();
      if (item) canvas.remove(item);
      canvas.requestRenderAll();
      onChange();
    },
    redo: () => {
      commit();
      const item = stack.redo();
      if (item) canvas.add(item);
      canvas.requestRenderAll();
      onChange();
    },
    canUndo: stack.canUndo,
    canRedo: stack.canRedo,
    hasContent: () => hasDoodleContent(stack.items() as DoodleItemLike[]),
    exportLayer: () => {
      commit();
      return canvas.toCanvasElement(1);
    },
    dispose: () => {
      if (closed) return;
      commit();
      closed = true;

      void canvas.dispose().catch(() => undefined);
      host.replaceChildren();
    },
  };
}
