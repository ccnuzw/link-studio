import { expect, test } from "vitest";
import {
  mediaPanelLayout,
  mediaPanelOverflow,
  mediaPanelPan,
  mediaPanelViewport,
} from "../../src/renderer/workspace/media-panel-layout";

test("窄窗内上移生成面板，同时给节点工具条和卡面留出空间", () => {
  const overflow = mediaPanelOverflow(723, 672);
  expect(overflow).toBe(115);
  expect(mediaPanelPan(107, overflow)).toBe(3);
  expect(mediaPanelPan(80, overflow)).toBe(0);
  expect(mediaPanelPan(310, overflow)).toBe(115);
  expect(mediaPanelOverflow(723, 888)).toBe(0);
});

test("高卡片和生成面板不能同时放下时缩放，保留卡片中心横坐标", () => {
  const node = { x: 432, y: 193, width: 324, height: 598 };
  const view = { x: 0, y: -50, zoom: 1 };
  const fitted = mediaPanelViewport(node, view, 888, 228, 0.14);
  expect(fitted.zoom).toBeLessThan(1);
  expect(fitted.x + 594 * fitted.zoom).toBeCloseTo(594);
  expect(fitted.y + node.y * fitted.zoom).toBeCloseTo(104);
  expect(fitted.y + (node.y + node.height) * fitted.zoom + 16 + 228).toBeCloseTo(824);
});

test.each([
  [400, 576, 1369, 680, 0],
  [636, 167, 1369, 680, 0],
  [100, 1152, 1369, 680, 0],
  [50, 300, 400, 376, 0],
  [-188, 576, 1369, 680, 252],
  [1012, 576, 1369, 680, -283],
])("节点左端 %i、宽 %i、视口 %i：屏幕面板宽 %i、平移 %i", (left, size, viewport, width, shift) => {
  expect(mediaPanelLayout(left, size, viewport)).toEqual({ width, shift });
});
