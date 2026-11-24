import { type BubbleQueueAction, bubbleQueue, initialBubbleQueue } from "./bubble-queue";
import { nextReaction, type PetReaction, type PetReactionKind } from "./mood";

export const initialNoticeState = () => ({
  queue: initialBubbleQueue(),
  reaction: null as PetReaction | null,
});

export function noticeState(
  state: ReturnType<typeof initialNoticeState>,
  action:
    | BubbleQueueAction
    | { type: "react"; kind: PetReactionKind; now: number }
    | { type: "endReaction"; until: number },
) {
  if (action.type === "endReaction")
    return state.reaction?.until === action.until ? { ...state, reaction: null } : state;
  if (action.type === "react")
    return { ...state, reaction: nextReaction(state.reaction, action.kind, action.now) };
  const queue = bubbleQueue(state.queue, action);
  if (queue === state.queue) return state;
  const previous = state.queue.current;
  const current = queue.current;
  let reaction = state.reaction;
  if (
    current &&
    action.type !== "clear" &&
    (current.id !== previous?.id || current.version !== previous.version)
  ) {
    if (current.mood === "jumping" || current.mood === "failed")
      reaction = nextReaction(
        reaction,
        current.mood === "jumping" ? "celebrate" : "failed",
        action.now,
      );
  }
  return { queue, reaction };
}
