import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { PluginRunner } from "../../packages/provider-runtime/src/runner";
import { createDrama, dramaDocument } from "../../src/main/project/drama";
import { controlDramaPlanning, runDramaPlanning } from "../../src/main/project/drama-planning";
import { ProjectStore } from "../../src/main/project/store";
import type { SettingsRegistry } from "../../src/main/settings/registry";
import { requireTestValue } from "../require-test-value";

test("旧项目恢复时按实际渲染长度抽样，逐批提交完整分集并持久化", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-fit-"));
  const runner = new PluginRunner(resolve("out/provider-runtime/runner"));
  const replay = process.env.DRAMA_PAUSED_FIXTURE;
  let store: ProjectStore | undefined;
  try {
    if (replay) {
      const copy = join(root, basename(replay));
      await cp(replay, copy, { recursive: true, filter: (path) => basename(path) !== ".runtime" });
      store = await ProjectStore.open(copy);
    } else {
      store = await ProjectStore.create(root, "来信");
      await createDrama(
        store,
        {
          title: "来信",
          sourceKind: "novel",
          script: Array.from(
            { length: 30 },
            (_, index) => `第${index + 1}章 来信\n${"“雨”<&>\\\n".repeat(120)}`,
          ).join("\n"),
        },
        [],
        [],
        undefined,
        undefined,
        { id: "764da0df-7117-448b-8dd8-f25ba29e09e6", revision: 1 },
      );
      await store.updateGeneration((state) => {
        const plan = requireTestValue(requireTestValue(dramaDocument(state)).planning);
        Object.assign(plan, {
          phase: "paused",
          pause_code: "context",
          pause_reason: "完整提示词超过模型上下文预算",
        });
        return { changed: true, result: null };
      });
    }
    const signal = new AbortController().signal;
    const sizes: number[] = [];
    const stages: string[] = [];
    const render = async (step: string, input: object) =>
      String(await runner.call("", "dramaAssetPrompt", [step, input], signal));
    const runtime = {
      recordDramaDuration: () => {},
      agentBinding: () => ({ profile: { config: {} } }),
      dramaPromptText: render,
      async dramaAssetStage(
        _model: unknown,
        step: string,
        input: object,
        scope: { unit_from: number; unit_to: number },
      ) {
        stages.push(step);
        sizes.push(Array.from(await render(step, input)).length);
        if (requireTestValue(sizes.at(-1)) > 12000) throw Error("超出完整输入预算");
        const output =
          step === "analyze"
            ? JSON.stringify({
                source_kind: "novel",
                summary: "来信",
                outline_md: "## 雨夜",
                characters_md: "信使",
              })
            : step === "plan"
              ? "雨夜来信，信使在门外等待。"
              : JSON.stringify({
                  episodes: [
                    {
                      title: "夜信",
                      synopsis: "信从远处来",
                      hook: "门响了",
                      cliffhanger: "谁先开门",
                      ...scope,
                    },
                  ],
                });
        return runner.call("", "dramaAssetOutput", [step, output, scope], signal);
      },
    } as unknown as SettingsRegistry;
    await controlDramaPlanning(store, "resume");
    await runDramaPlanning(store, runtime, signal);
    const finished = requireTestValue(dramaDocument(store.snapshot));
    expect(finished.planning).toMatchObject({ phase: "done", cursor: 30, end: 30 });
    expect(finished).toMatchObject({ characters_md: "信使", outline_md: "## 雨夜" });
    expect(stages.filter((step) => step === "analyze")).toHaveLength(1);
    expect(finished.episodes.length).toBeGreaterThan(1);
    expect(
      finished.episodes.flatMap((ep) =>
        Array.from(
          { length: requireTestValue(ep.unit_to) - requireTestValue(ep.unit_from) + 1 },
          (_, index) => requireTestValue(ep.unit_from) + index,
        ),
      ),
    ).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
    const directory = store.directory;
    await store.close();
    store = await ProjectStore.open(directory);
    const count = stages.length;
    await runDramaPlanning(store, runtime, signal);
    expect(stages).toHaveLength(count);
    expect(dramaDocument(store.snapshot)?.episodes).toEqual(finished.episodes);
  } finally {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
