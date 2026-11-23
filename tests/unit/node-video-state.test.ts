import { expect, test, vi } from "vitest";
import {
  createVideoSlotPool,
  nextFacadePhase,
  remainingLoadingMs,
} from "../../src/renderer/workspace/node-video-state";

test("加载态至少持续 320ms，失选之后过期的首帧不会重新开播", () => {
  expect(remainingLoadingMs(100, 350)).toBe(70);
  expect(remainingLoadingMs(100, 421)).toBe(0);
  const loading = nextFacadePhase("idle", "play");
  expect(nextFacadePhase(loading, "ready")).toBe("playing");
  expect(nextFacadePhase(nextFacadePhase(loading, "deactivate"), "ready")).toBe("idle");
});

test("播放名额满时回收暂停的播放器，正在播放的保留", () => {
  const pool = createVideoSlotPool(2);
  const releasePaused = vi.fn();
  const releasePlaying = vi.fn();
  const playing = { isPlaying: () => true, release: releasePlaying };
  pool.acquire("playing", playing);
  pool.acquire("paused", { isPlaying: () => false, release: releasePaused });
  pool.acquire("third", playing);
  expect(releasePaused).toHaveBeenCalledOnce();
  expect(pool.size()).toBe(2);
  pool.acquire("fourth", playing);
  expect(releasePlaying).not.toHaveBeenCalled();
  expect(pool.size()).toBe(3);
});
