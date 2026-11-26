import { Minus, PanelRight, PictureInPicture2 } from "lucide-react";
import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { AssistantPreferences } from "../assistant/assistant-preferences";
import { saveAgentLayout, useAgentLayout } from "./agent-layout";
import { type PetBounds, panelSize, placePanel } from "./pet/placement";

const origin = { x: 0, y: 0 };
const fallbackBottomInset = 68;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

export function AssistantFrame({
  visible,
  close,
  closeLabel = "关闭小灵",
  bounds,
  preferences,
  children,
}: {
  visible: boolean;
  close: () => void;
  closeLabel?: string;
  bounds?: PetBounds;
  preferences?: ReactNode;
  children: (controls: ReactNode) => ReactNode;
}) {
  const layout = useAgentLayout();
  const [viewport, setViewport] = useState(() => ({ width: innerWidth, height: innerHeight }));
  const drag = useRef<{ id: number; x: number; y: number; dx: number; dy: number } | null>(null);
  const [previewWidth, setPreviewWidth] = useState<number>();
  const sheet = viewport.width < 768;
  const canDock = !sheet && viewport.width - layout.width >= 480;
  const docked = layout.docked && canDock;
  const mode = sheet ? "sheet" : docked ? "dock" : "float";
  const area = bounds?.stage ?? { ...viewport, x: 0, y: 0 };
  const pet = bounds?.pet;
  const { width, height } = panelSize(area, pet ? undefined : fallbackBottomInset);
  const anchor = pet
    ? placePanel(pet, area, { width, height })
    : {
        x: area.width - 12 - width,
        y: area.height - fallbackBottomInset - height,
        origin: "bottom right",
      };
  const [preview, setPreview] = useState<typeof origin>();
  useEffect(() => {
    setPreview(undefined);
  }, [visible, mode, pet?.x, pet?.y, !!pet, area.width, area.height]);
  const limitX = (value: number) => clamp(value, 12 - anchor.x, area.width - 12 - width - anchor.x);
  const limitY = (value: number) =>
    clamp(value, 12 - anchor.y, area.height - 12 - height - anchor.y);
  const offset = preview ?? (pet ? origin : layout.offset);
  const { x: dx, y: dy } = offset;
  const outside = Math.abs(limitX(dx) - dx) > 1 || Math.abs(limitY(dy) - dy) > 1;
  useEffect(() => {
    if (visible && mode === "float" && bounds && !pet && !preview && (dx || dy) && outside)
      saveAgentLayout({ offset: origin });
  }, [visible, mode, bounds, pet, preview, dx, dy, outside]);
  const dockWidth = (size: number) =>
    Math.round(clamp(size, 320, Math.min(560, viewport.width / 2)));
  useEffect(() => {
    const resize = () => setViewport({ width: innerWidth, height: innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (
      mode !== "float" ||
      event.button !== 0 ||
      !(event.target instanceof Element) ||
      !event.target.closest(".assistant-heading") ||
      event.target.closest("button,select,input")
    )
      return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dx, dy };
  };
  const controls = (
    <>
      {!sheet && (
        <button
          type="button"
          aria-label={docked ? "改为浮窗" : canDock ? "停靠到右侧" : "窗口太窄，无法停靠"}
          aria-pressed={docked}
          title={docked ? "改为浮窗" : "停靠到右侧"}
          disabled={!canDock}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => saveAgentLayout({ docked: !docked })}
        >
          {docked ? <PictureInPicture2 size={16} /> : <PanelRight size={16} />}
        </button>
      )}
      <AssistantPreferences>{preferences}</AssistantPreferences>
      <button type="button" aria-label={closeLabel} title="收起" onClick={close}>
        <Minus size={16} />
      </button>
    </>
  );
  return (
    <div
      className="assistant-layout"
      hidden={!visible}
      data-mode={mode}
      style={{ width: docked ? layout.width : undefined }}
    >
      <div
        className="assistant-frame"
        style={
          mode === "float"
            ? {
                width,
                height,
                right: "auto",
                left: area.x + anchor.x + dx,
                top: area.y + anchor.y + dy,
                transformOrigin: anchor.origin,
              }
            : docked
              ? { width: previewWidth ?? layout.width }
              : undefined
        }
        onPointerDown={start}
        onPointerMove={(event) => {
          const origin = drag.current;
          if (origin?.id === event.pointerId && mode === "float")
            setPreview({
              x: limitX(origin.dx + event.clientX - origin.x),
              y: limitY(origin.dy + event.clientY - origin.y),
            });
        }}
        onPointerUp={(event) => {
          const start = drag.current;
          if (start?.id === event.pointerId && mode === "float" && !pet) {
            saveAgentLayout({
              offset: {
                x: limitX(start.dx + event.clientX - start.x),
                y: limitY(start.dy + event.clientY - start.y),
              },
            });
            setPreview(undefined);
          }
        }}
        onLostPointerCapture={(event) => {
          if (drag.current?.id === event.pointerId) {
            drag.current = null;
          }
        }}
      >
        {children(controls)}
        {docked && (
          <hr
            aria-orientation="vertical"
            aria-label="调整小灵面板宽度"
            aria-valuemin={320}
            aria-valuemax={Math.min(560, viewport.width / 2)}
            aria-valuenow={previewWidth ?? layout.width}
            tabIndex={0}
            className="assistant-dock-resizer"
            title="拖动调宽 · 双击恢复"
            onPointerDown={(event) => {
              if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                setPreviewWidth(dockWidth(viewport.width - event.clientX));
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                saveAgentLayout({ width: dockWidth(viewport.width - event.clientX) });
            }}
            onLostPointerCapture={() => setPreviewWidth(undefined)}
            onDoubleClick={() => saveAgentLayout({ width: 400 })}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                saveAgentLayout({
                  width: dockWidth(layout.width + (event.key === "ArrowLeft" ? 16 : -16)),
                });
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
