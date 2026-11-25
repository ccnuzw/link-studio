// @vitest-environment jsdom
import { type ModelConfig, modelGenerationOptions } from "@link-studio/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { applyKindTemplate } from "../../src/renderer/settings/model-kind-template";
import { MediaParameterPicker } from "../../src/renderer/workspace/media-pickers";

const base: ModelConfig = { kind: "text", name: "样例", description: "", sort: 100 };
const roots: ReturnType<typeof createRoot>[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

function renderedPicker(kind: "image" | "video", adapter: string, model: string, order: string[]) {
  const config = applyKindTemplate(base, kind, false, { adapter, model });
  config.parameterOrder = order;
  const options = modelGenerationOptions(kind, adapter, model, {}, config);
  return renderToStaticMarkup(
    createElement(MediaParameterPicker, {
      options,
      value: {},
      size: "",
      duration: "",
      change: () => undefined,
      setSize: () => undefined,
      setDuration: () => undefined,
    }),
  );
}

it("图片预览控件按参数配置顺序渲染", () => {
  const html = renderedPicker("image", "openai-image", "gpt-image-1", [
    "count",
    "resolution",
    "aspectRatio",
  ]);
  const labels = ["生成张数", "清晰度", "比例"];
  expect(labels.map((label) => html.indexOf(label))).toEqual(
    [...labels].map((label) => html.indexOf(label)).sort((left, right) => left - right),
  );
  expect(html).not.toContain("质量");
  expect(html).not.toContain("尺寸");
});

it("视频预览控件按参数配置顺序渲染", () => {
  const html = renderedPicker("video", "sora", "sora-2", [
    "duration",
    "resolution",
    "aspectRatio",
    "count",
  ]);
  const labels = ["时长", "清晰度", "比例"];
  expect(labels.map((label) => html.indexOf(label))).toEqual(
    [...labels].map((label) => html.indexOf(label)).sort((left, right) => left - right),
  );
});

it("参数顺序更新后同一预览实例立即重排", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  const render = (order: string[]) =>
    createElement(MediaParameterPicker, {
      options: modelGenerationOptions(
        "video",
        "sora",
        "sora-2",
        {},
        {
          ...applyKindTemplate(base, "video", false, { adapter: "sora", model: "sora-2" }),
          parameterOrder: order,
        },
      ),
      value: {},
      size: "",
      duration: "",
      change: () => undefined,
      setSize: () => undefined,
      setDuration: () => undefined,
    });
  act(() => root.render(render(["duration", "resolution", "aspectRatio"])));
  act(() => root.render(render(["aspectRatio", "duration", "resolution"])));
  const html = container.querySelector(".media-parameter-stack")?.textContent ?? "";
  expect(html.indexOf("比例")).toBeLessThan(html.indexOf("时长"));
  expect(html.indexOf("时长")).toBeLessThan(html.indexOf("清晰度"));
});
