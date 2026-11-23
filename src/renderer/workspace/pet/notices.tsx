import {
  type GenerationJob,
  jobFailureReason,
  jobIsTerminal,
  type SettingsApproval,
} from "@link-studio/core";
import { X } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  type Bubble,
  type BubbleContext,
  type BubbleInput,
  bubbleQueue,
  bubbleText,
  initialBubbleQueue,
} from "./bubble-queue";
import { claimFirstOpenToday, claimNightEgg, pickEasterLine } from "./easter";
import { nextReaction, type PetReaction } from "./mood";
import type { Rect, Size } from "./placement";

export function usePetNotices(
  context: BubbleContext,
  active: boolean,
  approval: SettingsApproval | undefined,
  runId: string | undefined,
  ended: { runId: string; status: string } | undefined,
  jobs: GenerationJob[],
) {
  const [queue, dispatch] = useReducer(bubbleQueue, undefined, initialBubbleQueue);
  const [reaction, setReaction] = useState<PetReaction | null>(null);
  const push = useCallback(
    (bubble: BubbleInput) => dispatch({ type: "push", bubble, now: Date.now() }),
    [],
  );
  const dismiss = useCallback(
    (id: string) => dispatch({ type: "dismiss", id, now: Date.now() }),
    [],
  );
  const { mode, panelOpen, assistantBusy, assistantPending, pageVisible, dragging } = context;
  useEffect(() => {
    dispatch({
      type: "context",
      patch: { mode, panelOpen, assistantBusy, assistantPending, pageVisible, dragging },
      now: Date.now(),
    });
    if (!active) dispatch({ type: "clear" });
  }, [mode, panelOpen, assistantBusy, assistantPending, pageVisible, dragging, active]);
  const id = approval?.id;
  const kind = approval?.kind;
  useEffect(() => {
    if (!id || panelOpen || !active) return;
    push({
      id,
      source: "assistant",
      priority: "approval",
      mood: "waiting",
      text: kind === "ask" ? "有个问题想问问你" : "这一步要你点个头",
      ttl: null,
    });
    return () => dismiss(id);
  }, [id, kind, panelOpen, active, push, dismiss]);
  const watched = useRef<string | undefined>(undefined);
  const endedId = ended?.runId,
    status = ended?.status;
  const finish = useCallback(
    (
      id: string,
      success: boolean,
      source: "assistant" | "result",
      text: string,
      key?: string,
      nodeIds?: string[],
    ) => {
      const now = Date.now();
      setReaction((prev) => nextReaction(prev, success ? "celebrate" : "failed", now));
      push({
        id,
        key,
        nodeIds,
        source,
        priority: success ? "result" : "error",
        mood: success ? "jumping" : "failed",
        text,
        ttl: success ? 4000 : 6000,
      });
    },
    [push],
  );
  useEffect(() => {
    if (
      watched.current &&
      watched.current === endedId &&
      watched.current !== runId &&
      active &&
      status &&
      [
        "succeeded",
        "failed",
        "timeout",
        "expired",
        "interrupted",
        "step_limit",
        "budget_exhausted",
      ].includes(status)
    )
      finish(
        `run:${endedId}`,
        status === "succeeded",
        "assistant",
        status === "succeeded" ? "好啦，回复写完了" : "卡住了，这一轮没跑完",
      );
    watched.current = runId;
  }, [runId, status, endedId, active, finish]);
  const running = useRef(new Set<string>());
  useEffect(() => {
    for (const job of jobs) {
      if (!active || !running.current.has(job.id) || !["failed", "succeeded"].includes(job.status))
        continue;
      const success = job.status === "succeeded";
      const noun =
        job.kind === "image"
          ? "张图"
          : job.kind === "video"
            ? "个视频"
            : job.kind === "audio"
              ? "段声音"
              : "段文字";
      finish(
        `job:${job.id}`,
        success,
        "result",
        success ? `{n} ${noun}好了` : `生成失败：${jobFailureReason(job) || "生成失败"}`,
        success ? `done:${job.kind}` : undefined,
        [job.nodeId],
      );
    }
    running.current = new Set(
      jobs.filter((job) => !jobIsTerminal(job.status)).map((job) => job.id),
    );
  }, [jobs, active, finish]);
  useEffect(() => {
    if (!reaction) return;
    const timer = setTimeout(() => setReaction(null), Math.max(0, reaction.until - Date.now()));
    return () => clearTimeout(timer);
  }, [reaction]);
  useEffect(() => {
    if (!active || mode !== "lively" || panelOpen) return;
    const now = new Date();
    const first = claimFirstOpenToday(now);
    const egg = claimNightEgg(now) ? "night" : first ? "firstOpen" : null;
    if (egg)
      push({
        id: `greeting:${egg}`,
        source: "easter",
        priority: "easter",
        mood: "waving",
        text: pickEasterLine(egg),
        ttl: 4000,
      });
  }, [active, mode, panelOpen, push]);
  return { bubble: queue.current, reaction, dismiss };
}

export function NoticeBubble({
  bubble,
  area,
  rect,
  pageVisible,
  dismiss,
  open,
}: {
  bubble: Bubble;
  area: Size;
  rect: Rect;
  pageVisible: boolean;
  dismiss: (id: string) => void;
  open: () => void;
}) {
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (!pageVisible || hover || bubble.ttl === null) return;
    const timer = setTimeout(() => dismiss(bubble.id), bubble.ttl);
    return () => clearTimeout(timer);
  }, [bubble, hover, pageVisible, dismiss]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) dismiss(bubble.id);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [dismiss, bubble.id]);
  const left = rect.x + rect.width / 2 >= area.width / 2;
  const room = left ? rect.x - 8 : area.width - rect.x - rect.width - 8;
  const chars = Array.from(bubbleText(bubble).replace(/\s*\n\s*/g, " "));
  const text = chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : chars.join("");
  return (
    <div
      role="status"
      className="pet-request"
      data-priority={bubble.priority}
      style={{
        top: rect.y + rect.height / 2,
        maxWidth: Math.max(120, Math.min(264, room - 4)),
        ...(left ? { right: area.width - rect.x + 8 } : { left: rect.x + rect.width + 8 }),
      }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      {bubble.source === "easter" ? (
        <span className="pet-request-text">{text}</span>
      ) : (
        <button
          type="button"
          className="pet-request-text"
          onClick={() => {
            dismiss(bubble.id);
            open();
          }}
        >
          {text}
        </button>
      )}
      <button type="button" aria-label="关闭提醒" onClick={() => dismiss(bubble.id)}>
        <X size={14} />
      </button>
    </div>
  );
}
