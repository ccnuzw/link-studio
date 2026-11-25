// @vitest-environment jsdom
import { type ChannelView, configuredGenerationInput, type PluginView } from "@link-studio/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ModelEditor } from "../../src/renderer/settings/model-editor";
import { applyKindTemplate } from "../../src/renderer/settings/model-kind-template";

const channel: ChannelView = {
  id: "channel",
  name: "测试渠道",
  enabled: true,
  revision: 1,
  endpoint: "",
  allowLocal: false,
  sort: 1,
  headers: [],
  hasSecret: true,
  hasSecretKey: false,
};

it.each(["openai-image", "openai-chat-image"])(
  "%s 已保存的三项参数在编辑器打开和恢复时都可见",
  (adapter) => {
    const plugin: PluginView = {
      key: adapter,
      hash: "a".repeat(64),
      name: adapter,
      kind: "image",
      mode: "sync",
      apiVersion: 1,
      version: "1",
      origin: "builtin",
      auth: "key",
      fields: {},
      hooks: [],
      disabled: false,
      source: "",
    };
    const upstream = "gpt-image-2.6";
    const config = applyKindTemplate(
      { kind: "image", name: upstream, description: "", sort: 1 },
      "image",
      false,
      { adapter, model: upstream },
    );
    const model = {
      ...channel,
      config,
      label: upstream,
      channelId: channel.id,
      id: "image",
      model: upstream,
      pluginHash: plugin.hash,
      agentEnabled: false,
      channel: {},
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
    try {
      act(() =>
        root.render(
          createElement(ModelEditor, {
            channel,
            channels: [channel],
            providers: [model],
            model,
            plugins: [plugin],
            pluginsStatus: "ready",
            saved: async () => {},
            close: () => {},
          }),
        ),
      );
      function click(label: string) {
        const button = [...container.querySelectorAll("button")].find(
          (button) => button.getAttribute("aria-label") === label || button.textContent === label,
        );
        expect(button).toBeDefined();
        act(() => button?.click());
      }
      const names = () =>
        [...container.querySelectorAll(".parameter-heading code")].map(
          (element) => element.textContent,
        );
      const expected = ["aspect_ratio", "resolution", "count"];
      click("能力与参数");
      expect(names()).toEqual(expected);
      expect(
        [...container.querySelectorAll(".model-enum-editor [data-default=true]")].map(
          (element) => element.textContent,
        ),
      ).toEqual(["1:1", "1K", "1"]);
      click("下移");
      expect(names()).toEqual(["resolution", "aspect_ratio", "count"]);
      click("恢复协议默认能力与参数");
      expect(names()).toEqual(expected);
      expect(
        configuredGenerationInput(config, { size: "1024x1024", quality: "high", count: 2 }),
      ).toEqual({ aspectRatio: "1:1", resolution: "1K", count: 2 });
    } finally {
      act(() => root.unmount());
      container.remove();
      Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
      Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    }
  },
);
