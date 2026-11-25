import { type GenerationJob, jobFailureReason, type SettingsApproval } from "@link-studio/core";
import { X } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { type PetRunEnd, runEndBubble } from "./assistant-notice";
import { type Bubble, type BubbleContext, type BubbleInput, bubbleText } from "./bubble-queue";
import { claimFirstOpenToday, claimNightEgg, pickEasterLine } from "./easter";
import { initialNoticeState, noticeState } from "./notice-state";
import type { Rect, Size } from "./placement";
import { CanvasResultObserver } from "./result-observer";

export function usePetNotices(
  context: BubbleContext,
  active: boolean,
  approval: SettingsApproval | undefined,
  runId: string | undefined,
  ended: PetRunEnd | undefined,
  jobs: GenerationJob[],
) {
  const [{ queue, reaction }, dispatch] = useReducer(noticeState, undefined, initialNoticeState);
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
      id: `assistant:approval:${id}`,
      source: "assistant",
      priority: "approval",
      mood: "waiting",
      text: kind === "ask" ? "有个问题想问问你" : "这一步要你点个头",
      ttl: null,
    });
    return () => dismiss(`assistant:approval:${id}`);
  }, [id, kind, panelOpen, active, push, dismiss]);
  const watched = useRef<string | undefined>(undefined);
  const endedId = ended?.runId,
    status = ended?.status,
    error = ended?.error;
  const finish = useCallback(
    (
      id: string,
      success: boolean,
      source: "assistant" | "result",
      text: string,
      key?: string,
      nodeIds?: string[],
    ) => {
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
    if (runId || !active) {
      watched.current = runId;
      return;
    }
    if (!endedId || watched.current !== endedId || !status) return;
    const bubble = runEndBubble({ runId: endedId, status, error });
    if (!bubble && status !== "canceled") return;
    watched.current = undefined;
    if (!bubble) return;
    if (panelOpen)
      dispatch({
        type: "react",
        kind: bubble.mood === "jumping" ? "celebrate" : "failed",
        now: Date.now(),
      });
    else push(bubble);
  }, [runId, status, endedId, error, active, panelOpen, push]);
  const [resultObserver] = useState(() => new CanvasResultObserver(Date.now()));
  useEffect(() => {
    for (const job of resultObserver.collect(jobs)) {
      if (!active) continue;
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
  }, [jobs, active, finish, resultObserver]);
  useEffect(() => {
    if (!reaction) return;
    const timer = setTimeout(
      () => dispatch({ type: "endReaction", until: reaction.until }),
      Math.max(0, reaction.until - Date.now()),
    );
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
  const { id, ttl, version } = bubble;
  useEffect(() => {
    if (!pageVisible || hover || ttl === null) return;
    const timer = setTimeout(() => dismiss(id), ttl);
    return () => clearTimeout(timer);
  }, [id, ttl, version, hover, pageVisible, dismiss]);
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
      className="pet-request-anchor"
      style={{
        top: rect.y + rect.height / 2,
        maxWidth: Math.max(120, Math.min(264, room - 4)),
        ...(left ? { right: area.width - rect.x + 8 } : { left: rect.x + rect.width + 8 }),
      }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <div
        role="status"
        className="pet-request"
        data-priority={bubble.priority}
        style={{ transformOrigin: left ? "right center" : "left center" }}
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
    </div>
  );
}
