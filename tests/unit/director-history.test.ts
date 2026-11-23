import { defaultDirectorScene, retimeDirectorScene } from "@link-studio/core";
import { expect, it } from "vitest";
import {
  directorHistory,
  initDirectorHistory,
} from "../../src/renderer/workspace/director-history";

it("只保留最近 100 个场景，普通编辑截断重做分支", () => {
  let state = initDirectorHistory(defaultDirectorScene());
  for (let index = 0; index < 104; index++)
    state = directorHistory(state, {
      type: "edit",
      update: (current) => ({ ...current, duration: (index % 15) + 1 }),
    });
  expect(state.past).toHaveLength(100);
  const target = state.past[0];
  for (let index = 0; index < 102; index++) state = directorHistory(state, { type: "undo" });
  expect(state.scene).toBe(target);
  expect(state.future).toHaveLength(100);
  state = directorHistory(state, { type: "redo" });
  const branch = directorHistory(state, {
    type: "edit",
    update: (current) => ({ ...current, duration: 14 }),
  });
  expect(branch.future).toHaveLength(0);
  expect(directorHistory(branch, { type: "redo" })).toBe(branch);
});

it("手势中间帧不单独入栈，空拖动和等效时长都保留重做", () => {
  const initial = initDirectorHistory(defaultDirectorScene());
  let state = directorHistory(initial, { type: "begin" });
  for (const duration of [6, 7, 8])
    state = directorHistory(state, {
      type: "edit",
      update: (current) => retimeDirectorScene(current, duration),
    });
  state = directorHistory(state, { type: "end" });
  expect(state.past).toEqual([initial.scene]);
  state = directorHistory(state, { type: "undo" });
  state = directorHistory(directorHistory(state, { type: "begin" }), { type: "end" });
  state = directorHistory(state, {
    type: "edit",
    update: (current) => retimeDirectorScene(current, 5.1),
  });
  expect(state.scene).toBe(initial.scene);
  expect(directorHistory(state, { type: "redo" }).scene.duration).toBe(8);
});
