import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import { DramaOutputTruncatedError } from "../../packages/provider-runtime/src/runner";
import { applyCanvas, projectCanvas } from "../../src/main/project/canvas";
import { createDrama, dramaDocument } from "../../src/main/project/drama";
import { estimateDramaJob } from "../../src/main/project/drama-estimate";
import { submitApprovedDramaJob } from "../../src/main/project/drama-job";
import { runDramaAssetJob } from "../../src/main/project/drama-worker";
import { ProjectStore } from "../../src/main/project/store";
import type { SettingsRegistry } from "../../src/main/settings/registry";
import { parseCharacters } from "../../src/renderer/workspace/drama-parse-characters";
import { requireTestValue } from "../require-test-value";

test("已锁定集仅补缺失提示词，中断重开保留人工修改与节点身份", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-repair-"));
  const fixture = process.env.DRAMA_REPAIR_FIXTURE;
  const model = { id: "764da0df-7117-448b-8dd8-f25ba29e09e6", revision: 1 };
  const signal = new AbortController().signal;
  let store: ProjectStore | undefined;
  const batches: string[][] = [];
  let fail = true;
  const registry = {
    dramaJobQuote: async () => ({ model, estimate: 2 }),
    agentBinding: () => ({ profile: { config: { contextWindow: 32768 } } }),
    redact: (reason: string) => reason,
    async dramaAssetStage(
      _model: unknown,
      stage: string,
      input: Record<string, unknown>,
      scope: { nodes: string[] },
    ) {
      if (stage === "breakdown") {
        expect(input.assets).toEqual([]);
        return "资产草稿";
      }
      if (stage === "breakdown_format")
        return {
          assets: Array.from({ length: 9 }, (_, index) => ({
            name: `道具${index}`,
            type: "prop",
            look: "",
            aliases: [],
            description: "铜铃",
            episodes: [1],
            voice_prompt: "",
          })),
        };
      if (stage === "asset_prompts") {
        if (fail) throw Error("模拟上游失败");
        batches.push(scope.nodes);
        if (batches.length === 1) {
          await requireTestValue(store).updateGeneration((state) => {
            const node = requireTestValue(
              projectCanvas(state.canvas).nodes.find((entry) => entry.id === scope.nodes[0]),
            );
            if (node.type !== "creative") throw Error("缺少资产");
            state.canvas = applyCanvas(state, [
              { type: "putNode", node: { ...node, data: { ...node.data, text: "手工提示词" } } },
            ]);
            return { changed: true, result: null };
          });
        } else if (batches.length === 2) throw Error("模拟最后一批失败");
        return "提示词草稿";
      }
      return { prompts: scope.nodes.map((node_id) => ({ node_id, prompt: `补写 ${node_id}` })) };
    },
  } as unknown as SettingsRegistry;
  try {
    if (fixture) {
      const directory = join(root, basename(fixture));
      await cp(fixture, directory, { recursive: true });
      store = await ProjectStore.open(directory);
      const cards = parseCharacters(requireTestValue(dramaDocument(store.snapshot)).characters_md);
      expect(cards).toHaveLength(23);
      expect(cards[0]).toMatchObject({ name: "上官淳儿", group: "上官家" });
    } else {
      store = await ProjectStore.create(root, "九件道具");
      await createDrama(store, { title: "来信", script: "第一集 雨夜\n门铃响了。" });
      const breakdown = await submitApprovedDramaJob(store, registry, "fixture", "extract", {
        args: { step: "breakdown", episodes: [1] },
        estimate: 2,
      });
      await runDramaAssetJob(store, registry, breakdown.id, signal);
      const completed = requireTestValue(
        requireTestValue(requireTestValue(dramaDocument(store.snapshot)).jobs)[0],
      );
      expect(completed).toMatchObject({
        status: "succeeded",
        done_episodes: [1],
        prompt_error: "模拟上游失败",
      });
      expect(completed.deferred_nodes).toEqual(completed.new_nodes);
      const directory = store.directory;
      await store.close();
      store = await ProjectStore.open(directory);
      expect(requireTestValue(dramaDocument(store.snapshot)).jobs).toEqual([completed]);
    }
    const before = projectCanvas(store.snapshot.canvas);
    fail = false;
    const args = { step: "asset_prompts", episodes: [1] } as const;
    for (const [index, count] of [9, 1].entries()) {
      const quote = await estimateDramaJob(
        requireTestValue(dramaDocument(store.snapshot)),
        args,
        registry,
        store.snapshot,
      );
      expect("nodes" in quote && quote.nodes).toHaveLength(count);
      expect(quote.estimate).toBe(index === 0 ? 4 : 2);
      const job = await submitApprovedDramaJob(store, registry, "fixture", `repair-${index}`, {
        args: { ...args, episodes: [1] },
        estimate: quote.estimate,
      });
      await runDramaAssetJob(store, registry, job.id, signal);
      expect(
        requireTestValue(requireTestValue(dramaDocument(store.snapshot)).jobs).at(-1)?.status,
      ).toBe(index === 0 ? "failed" : "succeeded");
      const directory = store.directory;
      await store.close();
      store = await ProjectStore.open(directory);
    }
    const after = projectCanvas(store.snapshot.canvas);
    expect(after.nodes.map((node) => node.id)).toEqual(before.nodes.map((node) => node.id));
    expect(after.edges).toEqual(before.edges);
    expect(batches.map((batch) => batch.length)).toEqual([8, 1, 1]);
    for (const id of [...requireTestValue(batches[0]), ...requireTestValue(batches[2])]) {
      const node = requireTestValue(after.nodes.find((node) => node.id === id));
      expect(node.type === "creative" && node.data.text).toBe(
        id === requireTestValue(batches[0])[0] ? "手工提示词" : `补写 ${id}`,
      );
    }
    await expect(
      estimateDramaJob(
        requireTestValue(dramaDocument(store.snapshot)),
        args,
        registry,
        store.snapshot,
      ),
    ).rejects.toThrow("没有待补写");
  } finally {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("截断只缩小受影响范围，单卡补词失败不阻断其他集；重开不重做已拆集和已暂缓卡", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-split-"));
  let store = await ProjectStore.create(root, "分批恢复");
  const controller = new AbortController();
  const episodeCalls: number[][] = [];
  const promptCalls: string[][] = [];
  let missing: string | undefined;
  const registry = {
    dramaJobQuote: async () => ({
      model: { id: "764da0df-7117-448b-8dd8-f25ba29e09e6", revision: 1 },
      estimate: 2,
    }),
    agentBinding: () => ({ profile: {} }),
    redact: (reason: string) => reason,
    async dramaAssetStage(
      _model: unknown,
      stage: string,
      _input: unknown,
      scope: { episodes: number[]; nodes: string[] },
    ) {
      if (stage === "breakdown") {
        episodeCalls.push(scope.episodes);
        if (scope.episodes[0] === 3 && !controller.signal.aborted) {
          controller.abort();
          throw controller.signal.reason;
        }
        return "草稿";
      }
      if (stage === "breakdown_format") {
        if (scope.episodes.length > 2) throw new DramaOutputTruncatedError();
        return {
          assets: scope.episodes.map((no) => ({
            name: `门铃${no}`,
            type: "prop",
            look: "",
            aliases: [],
            description: "门铃",
            episodes: [no],
            voice_prompt: "",
          })),
        };
      }
      if (stage === "asset_prompts") {
        missing ??= scope.nodes[0];
        promptCalls.push(scope.nodes);
        if (scope.nodes.includes(requireTestValue(missing))) throw new DramaOutputTruncatedError();
        return "草稿";
      }
      return { prompts: scope.nodes.map((node_id) => ({ node_id, prompt: "铜铃" })) };
    },
  } as unknown as SettingsRegistry;
  const episodes = [1, 2, 3, 4];
  try {
    await createDrama(store, {
      title: "门铃",
      script: episodes.map((no) => `第${no}集 门铃\n门响了。`).join("\n"),
    });
    const job = await submitApprovedDramaJob(store, registry, "fixture", "split", {
      args: { step: "breakdown", episodes },
      estimate: 2,
    });
    await runDramaAssetJob(store, registry, job.id, controller.signal);
    const checkpoint = requireTestValue(
      requireTestValue(requireTestValue(dramaDocument(store.snapshot)).jobs)[0],
    );
    expect(checkpoint).toMatchObject({
      status: "running",
      done_episodes: [1, 2],
      deferred_nodes: [missing],
    });
    const directory = store.directory;
    await store.close();
    store = await ProjectStore.open(directory);
    await runDramaAssetJob(store, registry, job.id, new AbortController().signal);
    expect(episodeCalls).toEqual([episodes, [1, 2], [3, 4], [3, 4]]);
    expect(promptCalls.map((group) => group.length)).toEqual([2, 1, 1, 2]);
    const result = requireTestValue(dramaDocument(store.snapshot));
    expect(result.jobs).toMatchObject([
      { status: "succeeded", done_episodes: episodes, deferred_nodes: [missing], progress: 100 },
    ]);
    expect(requireTestValue(requireTestValue(result.jobs)[0]).prompted_nodes).toHaveLength(3);
    expect(result.episodes.every((ep) => ep.locked)).toBe(true);
    expect(
      await estimateDramaJob(result, { step: "asset_prompts", episodes }, registry, store.snapshot),
    ).toMatchObject({ nodes: [missing], estimate: 2 });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  [false, [[1, 2]]],
  [true, [[1, 2], [1]]],
] as const)(
  "拆解终止边界：只有明确截断才缩批，单集不反复调用 (%s)",
  async (truncated, expected) => {
    const root = await mkdtemp(join(tmpdir(), "drama-error-"));
    const store = await ProjectStore.create(root, "边界");
    const calls: number[][] = [];
    const registry = {
      dramaJobQuote: async () => ({
        model: { id: "764da0df-7117-448b-8dd8-f25ba29e09e6", revision: 1 },
        estimate: 2,
      }),
      agentBinding: () => ({ profile: {} }),
      redact: (reason: string) => reason,
      dramaAssetStage: async (
        _model: unknown,
        _stage: string,
        _input: unknown,
        scope: { episodes: number[] },
      ) => {
        calls.push(scope.episodes);
        throw truncated ? new DramaOutputTruncatedError() : Error("鉴权失败");
      },
    } as unknown as SettingsRegistry;
    try {
      await createDrama(store, {
        title: "来信",
        script: "第1集 来信\n门响了。\n第2集 回信\n拆信。",
      });
      const job = await submitApprovedDramaJob(store, registry, "fixture", "error", {
        args: { step: "breakdown", episodes: [1, 2] },
        estimate: 2,
      });
      await runDramaAssetJob(store, registry, job.id, new AbortController().signal);
      expect(calls).toEqual(expected);
      expect(
        requireTestValue(requireTestValue(dramaDocument(store.snapshot)).jobs)[0],
      ).toMatchObject({
        status: "failed",
        error_message: expect.stringContaining(truncated ? "长度上限" : "鉴权失败"),
      });
      expect(requireTestValue(dramaDocument(store.snapshot)).episodes.some((ep) => ep.locked)).toBe(
        false,
      );
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
