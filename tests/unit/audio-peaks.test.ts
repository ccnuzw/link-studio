import { expect, test } from "vitest";
import {
  clockParts,
  computePeaks,
  positionToTime,
  timeToPosition,
} from "../../src/renderer/workspace/audio-peaks";

test("波形按时间均分，取每段的绝对峰值并按整段最大值归一化", () => {
  expect(computePeaks(Float32Array.of(0, -0.25, 0.125, -0.5, 0.25), 2)).toEqual([0.5, 1]);
  expect(computePeaks(Float32Array.of(0, 0), 3)).toEqual([0, 0, 0]);
  expect(computePeaks(Float32Array.of(1, -0.5), 4)).toEqual([1, 1, 0.5, 0.5]);
  expect(computePeaks(Float32Array.of(), 56)).toEqual([]);
  expect(computePeaks(Float32Array.of(1), 0)).toEqual([]);
});

test("播放头夹在波形两端，时钟只弱化第一个有效数字之前的字符", () => {
  expect(timeToPosition(1, 0)).toBe(0);
  expect(timeToPosition(10, 8)).toBe(1);
  expect(positionToTime(-0.3, 8)).toBe(0);
  expect(positionToTime(0.625, 8)).toBe(5);
  expect(clockParts(0)).toEqual({ dim: "00:00:0", bright: "0" });
  expect(clockParts(62.8)).toEqual({ dim: "00:0", bright: "1:02" });
  expect(clockParts(3601)).toEqual({ dim: "0", bright: "1:00:01" });
});
