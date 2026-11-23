import type { SettingsEvent } from "@link-studio/core";
import { expect, test } from "vitest";
import { projectSteers } from "../../src/renderer/assistant/steer-history";

const event = (seq: number, type: string, payload: unknown): SettingsEvent => ({
  seq,
  type,
  payload,
  runId: "run",
});
const queued = event(1, "message.user", { id: "first", steer: true, text: "保留机位" });

test("插话在等审批时留在托盘，读到后排在审批结果后", () => {
  const history = [queued, event(2, "run.status", { status: "waiting_approval" })];
  expect(projectSteers(history).waiting.map((item) => item.text)).toEqual(["保留机位"]);
  const replay = projectSteers([
    ...history,
    event(3, "approval.decided", {}),
    event(4, "steer.read", { ids: ["first"] }),
  ]);
  expect(replay.waiting).toHaveLength(0);
  expect(replay.transcript.map((item) => item.seq)).toEqual([2, 3, 4, 1]);
});

test("遗留插话在停止后标为未读，后续新消息关闭重发资格", () => {
  const stopped = event(2, "run.status", { status: "canceled" });
  const missed = projectSteers([queued, stopped]);
  expect(missed.waiting).toHaveLength(0);
  expect(missed.missed.get(queued.seq)).toBeGreaterThanOrEqual(missed.lastUser);
  const replay = projectSteers([
    queued,
    stopped,
    event(3, "steer.dropped", { ids: ["first"] }),
    event(4, "message.user", { text: "重开" }),
  ]);
  expect(replay.missed.get(queued.seq)).toBeLessThan(replay.lastUser);
  expect(replay.transcript.filter((item) => item.seq === queued.seq)).toHaveLength(1);
});
