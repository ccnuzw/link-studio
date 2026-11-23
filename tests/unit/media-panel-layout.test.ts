import { expect, test } from "vitest";
import { mediaPanelLayout } from "../../src/renderer/workspace/media-panel-layout";

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
