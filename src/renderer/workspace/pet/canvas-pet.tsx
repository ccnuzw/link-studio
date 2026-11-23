import { type GenerationJob, jobIsTerminal, type SettingsApproval } from "@link-studio/core";
import { Sparkles } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { saveAgentLayout, useAgentLayout } from "../agent-layout";
import { buildKeyframes } from "./atlas";
import { IDLE_SLEEP_MS, petMood } from "./mood";
import { NoticeBubble, usePetNotices } from "./notices";
import { PetSprite } from "./pet-sprite";
import { anchorOf, DEFAULT_ANCHOR, type PetBounds, rectOf } from "./placement";
import { PET_CELL, PET_ROWS } from "./rows";
import {
  usePageVisible,
  usePetGreeting,
  usePetSleep,
  useReducedMotionPref,
} from "./use-pet-activity";
import { type DragDir, petTransform, usePetDrag } from "./use-pet-drag";
import { usePetSheet } from "./use-pet-sheet";
import "./pet.css";

const animations = buildKeyframes(PET_ROWS, PET_CELL);

export function CanvasPet({
  stage,
  peek,
  open,
  toggle,
  runId,
  pending,
  available,
  jobs,
  ended,
  locateResults,
  onBounds,
}: {
  stage: HTMLElement;
  peek: HTMLElement | null;
  open: boolean;
  toggle: () => void;
  runId?: string;
  pending?: SettingsApproval;
  available: boolean;
  jobs: GenerationJob[];
  ended?: { runId: string; status: string };
  locateResults: (ids: string[]) => void;
  onBounds: (value: PetBounds) => void;
}) {
  const { mode, anchor } = useAgentLayout();
  const { sheet, status } = usePetSheet(mode !== "hidden");
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [narrow, setNarrow] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragDir, setDragDir] = useState<DragDir>(null);
  const target = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLFieldSetElement>(null);
  const fallback = useRef<HTMLButtonElement>(null);
  const active = status === "ready";
  const busy = !!runId;
  const runningTasks = jobs.filter((job) => !jobIsTerminal(job.status)).length;
  const pageVisible = usePageVisible();
  const reducedMotion = useReducedMotionPref();
  const { bubble, reaction, dismiss } = usePetNotices(
    {
      mode,
      panelOpen: open,
      assistantBusy: busy,
      assistantPending: !!pending,
      pageVisible,
      dragging,
    },
    active,
    pending,
    runId,
    ended,
    jobs,
  );
  const greeting = usePetGreeting(mode);
  const { asleep, touch } = usePetSleep(mode, greeting.wave);
  useLayoutEffect(() => {
    const measure = () => {
      setArea({ width: stage.clientWidth, height: stage.clientHeight });
      setNarrow(innerWidth < 768);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [stage]);
  useEffect(() => {
    if (busy || pending || runningTasks) touch();
  }, [busy, pending, runningTasks, touch]);
  const save = (next: Parameters<typeof saveAgentLayout>[0]) => {
    saveAgentLayout(next);
    menu.current?.hidePopover();
  };
  const width = narrow ? 56 : 80;
  const rect = rectOf(narrow ? DEFAULT_ANCHOR : anchor, area, {
    width,
    height: Math.round((width * 208) / 192),
  });
  const { x, y, height } = rect;
  useLayoutEffect(() => {
    if (!area.width || !area.height) return;
    const bounds = stage.getBoundingClientRect();
    onBounds({
      pet: active ? { x, y, width, height } : null,
      stage: { x: bounds.x, y: bounds.y, ...area },
    });
  }, [stage, area, active, x, y, width, height, onBounds]);
  const drag = usePetDrag({
    elRef: target,
    rect,
    area,
    enabled: !narrow,
    onDraggingChange: setDragging,
    onDirChange: setDragDir,
    onCommit: (next) => save({ anchor: anchorOf(next, area) }),
    onClick: toggle,
  });
  const mood = petMood({
    dragging,
    dragDir,
    reaction,
    now: reaction ? reaction.until - 1 : 0,
    pending: !!pending,
    busy,
    runningTasks,
    available,
    idleMs: !open && asleep ? IDLE_SLEEP_MS : 0,
    hovering: !open && (greeting.greet || bubble?.mood === "waving"),
    mode,
    reducedMotion,
    hasSleeping: true,
  });
  const sprite = (size: number) => (
    <PetSprite
      size={size}
      row={mood.row}
      loop={mood.loop}
      paused={!pageVisible}
      sheet={sheet}
      onEnd={greeting.clear}
    />
  );
  const showMenu = (x: number, y: number) => {
    if (!menu.current) return;
    menu.current.showPopover();
    menu.current.style.left = `${Math.max(0, Math.min(innerWidth - menu.current.offsetWidth, x))}px`;
    menu.current.style.top = `${Math.max(0, Math.min(innerHeight - menu.current.offsetHeight, y))}px`;
    menu.current.querySelector("button")?.focus();
  };
  return (
    <>
      <style>{animations}</style>
      {createPortal(
        <>
          {!open && active && (
            <button
              ref={target}
              type="button"
              className="pet-launcher"
              aria-label="打开小灵"
              aria-expanded={false}
              style={{ width, height: rect.height, transform: petTransform(rect.x, rect.y) }}
              onPointerEnter={greeting.onHover}
              onContextMenu={(event) => {
                event.preventDefault();
                showMenu(event.clientX, event.clientY);
              }}
              {...drag}
            >
              {sprite(width)}
            </button>
          )}
          {!open && active && bubble && (
            <NoticeBubble
              key={bubble.id}
              bubble={bubble}
              area={area}
              rect={rect}
              pageVisible={pageVisible}
              dismiss={dismiss}
              open={bubble.source === "result" ? () => locateResults(bubble.nodeIds ?? []) : toggle}
            />
          )}
          {(status === "off" || status === "failed") && (
            <button
              type="button"
              ref={fallback}
              className="canvas-launcher"
              aria-label={open ? "收起小灵" : "打开小灵"}
              aria-expanded={open}
              onContextMenu={(event) => {
                event.preventDefault();
                showMenu(event.clientX, event.clientY);
              }}
              onClick={toggle}
            >
              <Sparkles size={21} />
              小灵
            </button>
          )}
          <fieldset ref={menu} popover="auto" className="pet-options" aria-label="桌宠偏好">
            {(
              [
                ["lively", "活泼"],
                ["quiet", "安静"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-label={label}
                aria-pressed={mode === value}
                onClick={() => save({ mode: value })}
              >
                {label}
              </button>
            ))}
            {!narrow && (
              <button type="button" onClick={() => save({ anchor: DEFAULT_ANCHOR })}>
                回到右下角
              </button>
            )}
            <button type="button" onClick={() => save({ mode: "hidden" })}>
              隐藏桌宠
            </button>
          </fieldset>
        </>,
        stage,
      )}
      {open && active && peek && createPortal(sprite(60), peek)}
    </>
  );
}
