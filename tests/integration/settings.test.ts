import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { LocalAgentRuntime } from "../../packages/agent-runtime/src/runtime";
import { SpikeTargets } from "../../packages/agent-runtime/src/targets";
import { openStore } from "../../packages/agent-runtime/upstream/src/store/store";
import type { SettingsInput } from "../../packages/link-studio-core/src/settings-api";
import { PluginRunner, ProviderError } from "../../packages/provider-runtime/src/runner";
import {
  createDrama,
  DramaTools,
  dramaDocument,
  updateDramaBoardSettings,
} from "../../src/main/project/drama";
import { commitBreakdownBatch } from "../../src/main/project/drama-assets";
import {
  estimateDramaJob,
  estimateDramaSource,
  quoteDramaContinuation,
} from "../../src/main/project/drama-estimate";
import { submitApprovedDramaJob } from "../../src/main/project/drama-job";
import { ProjectStore } from "../../src/main/project/store";
import { SettingsAgent } from "../../src/main/settings/agent";
import { openAgentStream, probeAgentStream } from "../../src/main/settings/agent-model";
import { arkFiling } from "../../src/main/settings/ark-filing";
import {
  storageFields,
  storageReadURL,
  uploadFilingImage,
} from "../../src/main/settings/filing-storage";
import { fetchModelCatalog } from "../../src/main/settings/model-catalog";
import { openProviderResponse, providerTransport } from "../../src/main/settings/network";
import { SettingsRegistry } from "../../src/main/settings/registry";
import { cleanModelStream } from "../../src/main/settings/stream";
import { SkillLibrary } from "../../src/main/skills/library";
import { channelModelHealth } from "../../src/renderer/settings/channel-model-list";
import { quoteVideoModel } from "../fixtures/agent-quote";

const scope = { kind: "settings" } as const;

async function testRelease(bundle: string) {
  const names = (await readdir(bundle)).filter((name) => name.endsWith(".js"));
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(join(bundle, name)))
          .digest("hex"),
      ]),
    ),
  );
}

async function withRegistry(
  action: (fixture: {
    registry: SettingsRegistry;
    directory: string;
    input: SettingsInput<"save">;
    failEncryption: () => void;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "link-studio-settings-test-"));
  let fail = false;
  let registry: SettingsRegistry | undefined;
  try {
    registry = await SettingsRegistry.open(
      directory,
      "resources/provider-plugins",
      "out/provider-runtime/runner",
      {
        encrypt: (secret) => {
          if (fail) throw new ProviderError("PROVIDER_SECRET_STORE_UNAVAILABLE");
          return Buffer.from(secret).reverse();
        },
        decrypt: (value) => Buffer.from(value).reverse().toString(),
      },
    );
    const plugin = registry.list().plugins.find(({ key }) => key === "openai");
    if (!plugin) throw new Error("内置文本插件不存在");
    await action({
      registry,
      directory,
      failEncryption: () => {
        fail = true;
      },
      input: {
        expectedRevision: 0,
        pluginHash: plugin.hash,
        approve: true,
        secret: "fixture-credential",
        fields: {
          label: "测试文本",
          endpoint: "http://127.0.0.1:1",
          allowLocal: true,
          model: "fixture",
          agentEnabled: true,
          channel: { api: "chat_completions" },
        },
      },
    });
  } finally {
    registry?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

describe("S3 设置持久化", () => {
  it("营销技能试跑发送样例图片并按固定协议重写一次，文本模型不能冒充视觉模型", async () => {
    await withRegistry(async ({ registry, input, directory }) => {
      const valid = await readFile(
        "packages/provider-runtime/runner/marketing/samples/perfume_facts.json",
        "utf8",
      );
      const requests: string[] = [];
      const server = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        requests.push(body);
        const content = requests.length === 1 ? "{}" : valid;
        response
          .writeHead(200, { "content-type": "text/event-stream" })
          .end(
            `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw Error("测试模型未监听");
        const fields = { ...input.fields, endpoint: `http://127.0.0.1:${address.port}` };
        const model = registry.save({ ...input, fields: { ...fields, agentVision: true } });
        const trial = {
          step: "marketing.facts" as const,
          sample: "perfume",
          candidate: { source: "builtin" as const },
          model: model.id,
          revision: model.revision,
        };
        const method = {
          Source: "skill",
          SkillTitle: "测试方法",
          Version: 1,
          Body: "检查外观锚点",
        };
        const result = await registry.methodTrial(trial, method, new AbortController().signal);
        expect(result.passed).toBe(true);
        expect(requests).toHaveLength(2);
        expect(requests[0]).toContain("检查外观锚点");
        expect(requests[0]).toContain("data:image/jpeg;base64");
        expect(requests[1]).toContain("上次输出没有通过校验");
        const text = registry.save({
          ...input,
          fields: { ...fields, label: "纯文字", agentVision: false },
        });
        await expect(
          registry.methodTrial(
            { ...trial, model: text.id, revision: text.revision },
            method,
            new AbortController().signal,
          ),
        ).rejects.toThrow("媒体输入");
        expect(requests).toHaveLength(2);
        const skills = new SkillLibrary(join(directory, "method-library"));
        try {
          const live = await registry.runBoundMethod(
            skills,
            trial.step,
            model,
            { vars: { description: "生产输入标记" }, images: ["data:image/jpeg;base64,/9j/"] },
            new AbortController().signal,
          );
          expect(live).toMatchObject({
            passed: true,
            fallback: false,
            candidate: { source: "builtin" },
            output: { name: "BRUME 晨雾香水" },
          });
          expect(requests[2]).toContain("生产输入标记");
        } finally {
          skills.close();
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
  it("个人提示词库检查重名与修订，建剧保存快照，删除后不能再用旧选择建剧", async () => {
    await withRegistry(async ({ registry, directory }) => {
      const save = {
        action: "save" as const,
        revision: 0,
        step: "board" as const,
        name: "蜡印",
        body: "分镜：{{画面}}",
      };
      const entry = registry.dramaPromptLibrary(save).entries[0]!;
      expect(() => registry.dramaPromptLibrary(save)).toThrow("SETTINGS_PROMPT_DUPLICATE");
      expect(() =>
        registry.dramaPromptLibrary({ ...save, name: "画面", body: "{{未知}}" }),
      ).toThrow("SETTINGS_PROMPT_INVALID");
      const library = () => registry.dramaPromptLibrary({ action: "list" }).entries;
      const request = { title: "信封", script: "第一集\n信封。", prompts: { board: entry.id } };
      const store = await ProjectStore.create(directory, "已建剧");
      const later = await ProjectStore.create(directory, "未建剧");
      try {
        await expect(
          createDrama(store, { ...request, prompts: { video: entry.id } }, [], [], library),
        ).rejects.toThrow("所选提示词已删除");
        await createDrama(store, request, [], [], library);
        registry.dramaPromptLibrary({ ...save, id: entry.id, revision: 1, body: "新版：{{画面}}" });
        expect(() =>
          registry.dramaPromptLibrary({ action: "delete", id: entry.id, revision: 1 }),
        ).toThrow("SETTINGS_PROMPT_CONFLICT");
        registry.dramaPromptLibrary({ action: "delete", id: entry.id, revision: 2 });
        expect(dramaDocument(store.snapshot)).toMatchObject({
          prompt_snapshots: { board: entry },
          board_settings: { template: save.body },
        });
        await expect(createDrama(later, request, [], [], library)).rejects.toThrow(
          "所选提示词已删除",
        );
        expect(dramaDocument(later.snapshot)).toBeNull();
        const settings = { sceneModel: "", boardModel: "" };
        const video = registry.dramaPromptLibrary({
          ...save,
          name: "镜头移动",
          step: "video",
          body: "保持慢摇",
        }).saved!;
        const patch = { settings, revision: 1, prompts: { video } };
        await expect(
          updateDramaBoardSettings(
            store,
            { ...patch, prompts: { video, assets: entry.id } },
            [],
            [],
            library,
          ),
        ).rejects.toThrow("所选提示词已删除");
        expect(dramaDocument(store.snapshot)?.prompt_snapshots?.video).toBeUndefined();
        const updated = await updateDramaBoardSettings(store, patch, [], [], library);
        expect(updated).toMatchObject({
          board_settings_revision: 2,
          prompt_snapshots: { board: entry, video: { id: video } },
          board_settings: { template: save.body },
        });
        await expect(updateDramaBoardSettings(store, patch, [], [], library)).rejects.toThrow(
          "短剧已更改",
        );
        const reset = await updateDramaBoardSettings(
          store,
          { settings, revision: 2, prompts: { board: null } },
          [],
          [],
          library,
        );
        expect(reset.prompt_snapshots?.video?.id).toBe(video);
        expect(reset.prompt_snapshots?.board).toBeUndefined();
        expect(reset.board_settings?.template).toBeUndefined();
      } finally {
        await store.close();
        await later.close();
      }
    });
  });
  it("离线模型保留加密原文，未修复不能运行，保存按修订原子提交", async () => {
    await withRegistry(async ({ registry, input, directory, failEncryption }) => {
      const channel = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "fixture-key",
        fields: {
          name: "草稿",
          endpoint: input.fields.endpoint,
          allowLocal: true,
          enabled: true,
          sort: 0,
          headers: [],
        },
      });
      const request = {
        channelId: channel.id,
        channelRevision: channel.revision,
        expectedRevision: 0,
        pluginHash: input.pluginHash,
        settings: {},
        enabled: false,
        upstreamModel: "typed",
        config: { kind: "text" as const, name: "typed", sort: 1, description: "" },
      };
      const body = {
        key: "draft-key",
        kind: "text",
        label: "草稿原名",
        sort: 1,
        channels: [
          { channel: channel.id, upstream_model: "from-body", protocol: { plugin: "openai" } },
        ],
      };
      const documentText = JSON.stringify(
        { extension: "private-extension-data", ...body, capabilities: { "~/note": true } },
        null,
        4,
      );
      const model = registry.modelSave({ ...request, documentText });
      expect(model).toMatchObject({
        modelKey: "draft-key",
        model: "from-body",
        config: { name: "草稿原名" },
        hasDocumentDraft: true,
        draftIssueCount: 2,
        issues: [{ field: "/extension" }, { field: "/capabilities/~0~1note" }],
      });
      const ref = { id: model.id, expectedRevision: model.revision };
      expect(registry.modelDraftRead(ref).text).toBe(documentText);
      expect(JSON.stringify([registry.list(), registry.agentModel(model.id)])).not.toContain(
        "private-extension-data",
      );
      expect(() => registry.modelDraftRead({ ...ref, expectedRevision: 0 })).toThrow(
        "SETTINGS_REVISION_CONFLICT",
      );
      expect(() =>
        registry.modelSave({ ...request, ...ref, expectedRevision: 0, documentText }),
      ).toThrow("SETTINGS_REVISION_CONFLICT");
      expect(() => registry.modelSave({ ...request, ...ref })).toThrow("MODEL_DOCUMENT_REQUIRED");
      expect(() => registry.modelToggle({ ...ref, enabled: true })).toThrow(
        "MODEL_DOCUMENT_INVALID",
      );
      expect(() => registry.trialBinding(model.id, model.revision)).toThrow();
      expect(() => registry.binding(model.id, model.revision)).toThrow();
      const db = new DatabaseSync(join(directory, "settings.sqlite"), { readOnly: true });
      try {
        const row = db.prepare("SELECT ciphertext FROM model_document_drafts WHERE id=?");
        expect(Buffer.from(row.get(model.id)!.ciphertext as Uint8Array).toString()).not.toContain(
          "private-extension-data",
        );
        const fixed = registry.modelSave({
          ...request,
          ...ref,
          documentText: JSON.stringify(body),
        });
        expect(fixed.hasDocumentDraft).toBeUndefined();
        expect(row.get(model.id)).toBeUndefined();
        expect(registry.trialBinding(model.id, fixed.revision).plugin.key).toBe("openai");
        const online = registry.modelToggle({
          ...ref,
          expectedRevision: fixed.revision,
          enabled: true,
        });
        expect(() =>
          registry.modelSave({
            ...request,
            ...ref,
            expectedRevision: online.revision,
            documentText,
          }),
        ).toThrow("MODEL_DOCUMENT_INVALID");
        const removed = registry.modelSave({
          ...request,
          documentText: documentText
            .replace("draft-key", "remove-key")
            .replace("from-body", "remove-me"),
        });
        registry.modelRemove({ id: removed.id, expectedRevision: removed.revision });
        expect(row.get(removed.id)).toBeUndefined();
        const previousText = documentText
          .replace("draft-key", "previous-key")
          .replace("from-body", "previous-model");
        const previous = registry.modelSave({ ...request, documentText: previousText });
        const previousRef = { id: previous.id, expectedRevision: previous.revision };
        failEncryption();
        expect(() =>
          registry.modelSave({
            ...request,
            documentText: documentText
              .replace("draft-key", "rollback-key")
              .replace("from-body", "rollback-me"),
          }),
        ).toThrow("PROVIDER_SECRET_STORE_UNAVAILABLE");
        expect(registry.list().providers.map((model) => model.modelKey)).not.toContain(
          "rollback-key",
        );
        expect(() =>
          registry.modelSave({
            ...request,
            ...previousRef,
            documentText: previousText.replace("草稿原名", "不能提交"),
          }),
        ).toThrow("PROVIDER_SECRET_STORE_UNAVAILABLE");
        expect(registry.modelDraftRead(previousRef).text).toBe(previousText);
        expect(registry.provider(previous.id).config?.name).toBe("草稿原名");
      } finally {
        db.close();
      }
    });
  });
  it("报价按规格、秒数和批量计算，保留配置并返回无效输入字段", async () => {
    await withRegistry(async ({ registry }) => {
      const before = registry.list().providers;
      const quote = (input?: object) => registry.agentQuote({ body: quoteVideoModel, input });
      expect(await quote()).toMatchObject({
        count: 1,
        per_task_credits: 8,
        quote_credits: 8,
        input: { prompt: "估" },
      });
      expect(await quote({ size: "large", duration: 6, count: 3 })).toMatchObject({
        count: 3,
        per_task_credits: 30,
        quote_credits: 90,
      });
      for (const input of [{ size: "unknown" }, { duration: 100 }, { count: 0 }]) {
        expect(await quote(input)).toMatchObject({
          error: "输入未通过校验",
          issues: [{ field: Object.keys(input)[0] }],
        });
      }
      expect(registry.list().providers).toEqual(before);
    });
  });
  it("短剧估价按集和模型上下文分批，锁定和原稿条件在定价前生效", async () => {
    await withRegistry(async ({ registry, directory }) => {
      let store = await ProjectStore.create(directory, "十二集之外");
      try {
        await createDrama(store, {
          title: "十二集之外",
          script: Array.from({ length: 13 }, (_, index) => `第${index + 1}集\n月光落在窗台。`).join(
            "\n",
          ),
        });
        const document = dramaDocument(store.snapshot)!;
        const before = structuredClone(store.snapshot);
        const quote = (step: string, episodes: number[]) =>
          estimateDramaJob(document, { step, episodes }, registry);
        await expect(quote("scripts", [1])).rejects.toThrow("剧本型输入不能生成分集剧本");
        await expect(quote("breakdown", [2, 2])).rejects.toThrow("集号须为1至100000且不能重复");
        await expect(quote("breakdown", [14])).rejects.toThrow("所选集不存在");
        await expect(quote("breakdown", [2, 1])).rejects.toThrow("DRAMA_NO_TEXT_MODEL");
        const script = "第一集\n" + "🌙".repeat(4500) + "\n第二集\n灯亮了。";
        await expect(estimateDramaSource({ script }, registry)).rejects.toMatchObject({
          code: "DRAMA_NO_TEXT_MODEL",
        });
        await expect(quote("compose", [])).rejects.toThrow("合成须且只能选择一集");
        await expect(quote("compose", [1])).rejects.toThrow("所选集须已拆解锁定");
        await expect(quote("storyboard", [1])).rejects.toThrow("所选集须已拆解资产且剧本已就绪");
        const channel = registry.channelSave({
          expectedRevision: 0,
          approve: true,
          secret: "fixture-key",
          fields: {
            name: "短剧",
            endpoint: "https://drama.invalid",
            allowLocal: false,
            enabled: true,
            sort: 0,
            headers: [],
            concurrent: 1,
          },
        });
        registry.modelSave({
          expectedRevision: 0,
          channelId: channel.id,
          channelRevision: channel.revision,
          upstreamModel: "fixture",
          config: {
            name: "短剧",
            kind: "agent",
            description: "",
            sort: 1,
            promptLimit: 24000,
            contextWindow: 32768,
            maxOutputTokens: 2048,
            pricing: { unit: "token", input: 1000, output: 1000 },
          },
          settings: { api: "chat_completions" },
          enabled: true,
        });
        const model = registry.list().providers[0]!;
        const modelQuote = await registry.agentQuote({ key: model.id, input: { prompt: "估" } });
        expect(modelQuote, JSON.stringify(modelQuote)).not.toHaveProperty("error");
        registry.modelSave({
          expectedRevision: 0,
          channelId: channel.id,
          channelRevision: channel.revision,
          upstreamModel: "legacy",
          config: { name: "旧模型", kind: "agent", description: "", sort: 0 },
          settings: { api: "chat_completions" },
          enabled: true,
        });
        const modelRef = { id: model.id, revision: model.revision };
        const sourceEstimate = await estimateDramaSource({ script, textModel: model.id }, registry);
        expect(sourceEstimate.exactEpisodes).toBe(2);
        const numbers = Array.from({ length: 201 }, (_, index) => index + 1);
        const series = {
          ...document,
          episodes: numbers.map((episode_no) => ({ ...document.episodes[0]!, episode_no })),
        };
        const batch = (episodes: number[]) =>
          estimateDramaJob(series, { step: "breakdown", episodes }, registry);
        await expect(batch([])).rejects.toThrow("单次最多选择200集");
        await expect(batch(numbers)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
        const last200 = numbers.slice(1);
        await expect(batch([...last200].reverse())).resolves.toMatchObject({ episodes: last200 });
        expect(sourceEstimate.credits).toBe(
          Math.ceil((Array.from(script).length + 2048 + 2048) / 1000),
        );
        const chapters = Array.from(
          { length: 13 },
          (_, index) => `第${index + 1}章\n${"月".repeat(350)}`,
        );
        const novel = {
          script: chapters.join("\n"),
          textModel: model.id,
          sourceKind: "novel" as const,
        };
        const all = await estimateDramaSource(novel, registry);
        const firstTwelve = await estimateDramaSource({ ...novel, rangeEnd: 12 }, registry);
        expect(all).toMatchObject({
          kind: "chapter",
          kindGuess: "novel",
          planning: { rangeEnd: 13, batches: 2, episodeMin: 2, episodeMax: 4 },
        });
        expect(firstTwelve).toMatchObject({ planning: { rangeEnd: 12, batches: 1 } });
        expect(all).toMatchObject({ planning: { minutes: 3 } });
        const remaining = {
          ...document,
          source: { kind: "chapter", text: novel.script, chars: novel.script.length, total: 13 },
          planning: {
            phase: "done" as const,
            model: modelRef,
            end: 12,
            cursor: 12,
            pause_reason: "",
            pause_code: "",
            summary: "月光",
          },
        };
        registry.recordDramaDuration("duration-1", modelRef, "plan", 95000);
        registry.recordDramaDuration("duration-2", modelRef, "plan", 151000);
        registry.recordDramaDuration("duration-1", modelRef, "plan", 1000);
        expect(registry.dramaStepSeconds(modelRef, "plan")).toBe(123);
        expect(
          registry.dramaStepSeconds({ ...modelRef, revision: modelRef.revision + 1 }, "plan"),
        ).toBe(60);
        const continuation = await quoteDramaContinuation(remaining, 0, registry);
        const last = Array.from(`## [1] 第13章\n${chapters[12]}\n`).length;
        expect(continuation).toMatchObject({
          end: 13,
          model: modelRef,
          estimate: {
            episodeMin: 1,
            episodeMax: 1,
            minutes: 3,
            credits: 2 * Math.ceil((4096 + last + 2048) / 1000),
          },
        });
        await expect(quoteDramaContinuation(remaining, 12, registry)).rejects.toThrow("尚未规划");
        await expect(quoteDramaContinuation(remaining, 14, registry)).rejects.toThrow("尚未规划");
        expect(all.credits - firstTwelve.credits).toBe(
          2 *
            Math.ceil(
              (4096 + Array.from(`## [13] 第13章\n${chapters[12]}\n`).length + 2048) / 1000,
            ),
        );
        await expect(estimateDramaSource({ ...novel, rangeEnd: 14 }, registry)).rejects.toThrow(
          "规划范围超出原文单元",
        );
        const longTail = { ...novel, script: `第一章\n风\n第二章\n${"雨".repeat(11800)}` };
        await expect(
          estimateDramaSource({ ...longTail, rangeEnd: 1 }, registry),
        ).resolves.toMatchObject({ planning: { rangeEnd: 1 } });
        await expect(estimateDramaSource(longTail, registry)).rejects.toThrow("第二章");
        await expect(quote("breakdown", [2, 1])).resolves.toEqual({
          estimate: 28,
          episodes: [1, 2],
          model: modelRef,
        });
        await expect(quote("breakdown", [])).resolves.toMatchObject({ estimate: 56 });
        await expect(registry.dramaJobQuote("storyboard", 0, [5000])).resolves.toMatchObject({
          estimate: 12 + 17,
        });
        const disabled = registry.modelSave({
          expectedRevision: 0,
          channelId: channel.id,
          channelRevision: channel.revision,
          upstreamModel: "disabled-drama",
          config: {
            name: "已停用",
            kind: "agent",
            description: "",
            sort: 2,
            contextWindow: 32768,
            maxOutputTokens: 2048,
          },
          settings: { api: "chat_completions" },
          enabled: false,
        });
        await expect(
          registry.dramaJobQuote("storyboard", 0, [5000], disabled.id),
        ).resolves.toMatchObject({ model: modelRef, estimate: 12 + 17 });
        await expect(registry.dramaJobQuote("breakdown", 0, [7000, 7000])).resolves.toMatchObject({
          estimate: 4 * (14 + 14),
        });
        expect(store.snapshot).toEqual(before);
        const args = { step: "breakdown" as const, episodes: [2, 1] };
        const payload = { args, estimate: 28 };
        const submit = (id: string) =>
          submitApprovedDramaJob(store, registry, "run-1", id, payload);
        const [first, replay] = await Promise.all([submit("approval-1"), submit("approval-1")]);
        expect(replay.id).toBe(first.id);
        await expect(submit("approval-2")).rejects.toMatchObject({ code: "DRAMA_JOB_CONFLICT" });
        const projectDir = store.directory;
        await store.close();
        store = await ProjectStore.open(projectDir);
        expect(dramaDocument(store.snapshot)?.jobs?.map((job) => job.id)).toEqual([first.id]);
        expect(dramaDocument(store.snapshot)?.jobs?.[0]?.model).toEqual(modelRef);
        await expect(
          new DramaTools().command(store, "drama-read", {
            runId: "read-jobs",
            input: { scope: "overview" },
          }),
        ).resolves.toMatchObject({
          active_jobs: [{ id: first.id, episodes: [1, 2], status: "queued", step: "breakdown" }],
        });
        await expect(submit("approval-1")).resolves.toEqual(first);
        await expect(
          submitApprovedDramaJob(store, registry, "run-2", "approval-1", payload),
        ).rejects.toMatchObject({ code: "AGENT_APPROVAL_STALE" });
        await store.updateGeneration((state) => {
          dramaDocument(state)!.jobs![0]!.status = "running";
          return { changed: true, result: null };
        });
        const asset = {
          type: "prop" as const,
          name: "信封",
          look: "",
          aliases: [],
          description: "未拆封的信",
          voice_prompt: "",
          episodes: [1],
        };
        await expect(commitBreakdownBatch(store, first.id, [2], [asset])).rejects.toMatchObject({
          code: "VALIDATION_FAILED",
        });
        const [created] = await commitBreakdownBatch(store, first.id, [1], [asset]);
        const revision = store.snapshot.revision;
        await expect(commitBreakdownBatch(store, first.id, [1], [asset])).resolves.toEqual([]);
        expect(store.snapshot.revision).toBe(revision);
        const committed = dramaDocument(store.snapshot)!;
        expect(committed.jobs?.[0]).toMatchObject({
          done_episodes: [1],
          new_nodes: [created!.node_id],
        });
        expect(committed.episodes[0]?.locked).toBe(true);
        expect(committed.episodes[1]?.locked).not.toBe(true);
      } finally {
        await store.close();
      }
    });
  });
  it("后台模型详情按主键返回配置，再读取时反映实际启停", async () => {
    await withRegistry(async ({ registry, input }) => {
      const profile = await registry.save(input);
      const snapshot = registry.agentModel(profile.id);
      expect(snapshot).toMatchObject({
        live: true,
        body: {
          key: profile.id,
          label: profile.model,
          kind: "agent",
          enabled: true,
          channels: [{ upstream_model: profile.model }],
        },
      });
      expect(JSON.stringify(snapshot)).not.toContain(input.secret);
      expect(registry.agentModel(profile.id)).toEqual(snapshot);
      registry.disable({ id: profile.id, expectedRevision: profile.revision });
      const disabled = registry.agentModel(profile.id);
      expect(disabled).toMatchObject({ live: false, body: { enabled: false } });
      expect(disabled.body_sha256).not.toBe(snapshot.body_sha256);
      registry.recordModelUse("project", "image1", profile.id);
      registry.recordModelUse("project", "image1", profile.id);
      registry.recordModelUse("agent", "call1", profile.id);
      registry.recordModelUse("project", "old", profile.id, Date.now() - 8 * 86_400_000);
      expect(
        registry.agentModelList({ enabled: false, kind: "agent", q: profile.model.toUpperCase() }),
      ).toMatchObject([{ key: profile.id, enabled: false, calls_7d: 2 }]);
      expect(registry.agentModelList({ enabled: true })).toEqual([]);
      expect(registry.agentModelList({ channel: "another" })).toEqual([]);
      expect(() => registry.agentModel("missing")).toThrowError(
        expect.objectContaining({ code: "PROVIDER_NOT_FOUND" }),
      );
    });
  });
  it("诊断按创建时间与快照筛选，试跑详情过期后仍可查脱敏摘要", async () => {
    await withRegistry(async ({ registry, input }) => {
      const profile = await registry.save(input);
      const clock = vi.spyOn(Date, "now");
      try {
        const start = Date.now();
        clock.mockReturnValue(start);
        registry.trialStart("failed-trial", profile.id, profile.revision);
        registry.trialSaveResult("failed-trial", {
          status: "failed",
          error: "PROVIDER_HTTP_ERROR",
          outputs: [],
          logs: [],
          trace: [
            {
              seq: 1,
              id: "http",
              kind: "http",
              phase: "submit",
              method: "POST",
              status: 403,
              endpoint: "https://user:private@example.org/api?sig=private#frag",
              requestBody: { text: "private-prompt", truncated: false },
              responseBody: { text: `denied ${input.secret}`, truncated: false },
            },
          ],
        });
        clock.mockReturnValue(start + 2 * 3600_000);
        registry.recordRequestError(
          "failed-image",
          profile.id,
          "other-channel",
          Date.now(),
          "JOB_PROVIDER_FAILED",
        );
        expect(registry.trialLatest(profile.id, profile.revision, "failed-trial")).toBeNull();
        const { items } = registry.agentRecentErrors({
          task_id: "failed-trial",
          model_key: profile.id,
        });
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          task_id: "failed-trial",
          is_test: true,
          trace_available: true,
          steps: [
            {
              url: "https://example.org/api",
              http_status: 403,
              response_excerpt: "denied [凭证已移除]",
            },
          ],
        });
        expect(JSON.stringify(items)).not.toContain("private");
        expect(
          registry.agentRecentErrors({ hours: 1, limit: 1, channel_key: "other-channel" }).items,
        ).toMatchObject([{ task_id: "failed-image", is_test: false }]);
        expect(
          registry.agentRecentErrors({ task_id: "failed-trial", channel_key: "other-channel" })
            .items,
        ).toHaveLength(0);
        clock.mockReturnValue(start + 169 * 3600_000);
        expect(
          registry.agentRecentErrors({ task_id: "failed-trial", hours: 168 }).items,
        ).toHaveLength(0);
        expect(() => registry.agentRecentErrors({ limit: 11 })).toThrow();
      } finally {
        clock.mockRestore();
      }
    });
  });
  it("渠道授权拒绝未确认的创建和范围变化，重存已登记的路径不再截短", async () => {
    await withRegistry(async ({ registry }) => {
      const fields = {
        name: "路径",
        endpoint: "https://fixture.invalid/api//",
        allowLocal: false,
        enabled: true,
        sort: 0,
        headers: [],
      };
      const input = { fields, expectedRevision: 0, approve: false };
      expect(() => registry.channelSave(input)).toThrow("PLUGIN_APPROVAL_REQUIRED");
      expect(registry.channelList()).toHaveLength(0);
      const first = registry.channelSave({
        ...input,
        approve: true,
        secret: "fixture-key",
        secretKey: "fixture-secondary",
      });
      expect(first.endpoint).toBe("https://fixture.invalid/api/");
      const update = {
        ...input,
        id: first.id,
        expectedRevision: first.revision,
        fields: { ...fields, endpoint: first.endpoint, name: "改名" },
      };
      for (const change of [{ endpoint: "https://fixture.invalid/api" }, { allowLocal: true }]) {
        expect(() =>
          registry.channelSave({ ...update, fields: { ...update.fields, ...change } }),
        ).toThrow("PLUGIN_APPROVAL_REQUIRED");
      }
      expect(registry.channelSave(update)).toMatchObject({
        revision: 2,
        endpoint: first.endpoint,
        hasSecret: true,
        hasSecretKey: true,
      });
    });
  });
  it("助手渠道概要包含启停状态与已配密钥标记", async () => {
    await withRegistry(async ({ registry }) => {
      const fields = {
        name: "测试渠道",
        endpoint: "https://example.org",
        allowLocal: false,
        enabled: true,
        sort: 0,
        headers: [{ name: "x-routing", value: "private-header-value" }],
      };
      const first = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        fields,
        secret: "sample-credential",
      });
      const second = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: { ...fields, name: "停用", enabled: false },
      });
      expect(registry.agentChannelList()).toEqual([
        {
          key: first.id,
          name: fields.name,
          base_url: fields.endpoint,
          enabled: true,
          has_key: true,
          secret_configured: true,
        },
        {
          key: second.id,
          name: "停用",
          base_url: fields.endpoint,
          enabled: false,
          has_key: false,
          secret_configured: false,
        },
      ]);
    });
  });
  it("设置助手读取最新和历史插件版本，并明确拒绝不存在的版本", async () => {
    await withRegistry(async ({ registry, input }) => {
      await registry.save(input);
      const original = await registry.draft(
        registry.agentPlugin("openai").code + "\nmodule.exports.meta.key='read-fixture';",
      );
      const newer = await registry.draft(
        original.source.replace('name: "OpenAI"', `name: "OpenAI ${input.secret}"`),
      );
      const list = registry.agentPluginList().filter((plugin) => plugin.key === original.key);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        latest_version: newer.version,
        kind: ["text"],
        name: "OpenAI [凭证已移除]",
      });
      expect(list[0]).not.toHaveProperty("code");
      expect(registry.agentPlugin(original.key, original.version)).toMatchObject({
        code: original.source,
      });
      const latest = registry.agentPlugin(original.key);
      expect(latest).toEqual(registry.agentPlugin(original.key, "latest"));
      expect(latest).toMatchObject({
        version: newer.version,
        meta: { key: original.key, name: "OpenAI [凭证已移除]" },
      });
      expect(latest.code).toContain("[凭证已移除]");
      expect(() => registry.agentPlugin(original.key, "missing")).toThrowError(
        expect.objectContaining({ code: "PLUGIN_VERSION_MISSING" }),
      );
    });
  });
  it("插件版本审批只读预估；批准时按实际最高版本重新登记，相同审批重放不再递增", async () => {
    await withRegistry(async ({ registry }) => {
      const builtin = registry.list().plugins.find((plugin) => plugin.key === "openai")!;
      const source = `${builtin.source}\nmodule.exports.meta.key='version-preview';module.exports.meta.version='v1.0';`;
      const runId = "draft-review";
      const request = { pluginSource: source };
      const unchecked = { code: "PLUGIN_DRAFT_CHECK_REQUIRED" };
      await expect(registry.preview({ pluginSource: builtin.source }, runId)).rejects.toMatchObject(
        { code: "PLUGIN_BUILTIN_KEY_RESERVED" },
      );
      await expect(registry.preview(request, runId)).rejects.toMatchObject(unchecked);
      await expect(registry.agentPluginCheck(runId, "initial", { source })).resolves.toMatchObject({
        ok: true,
      });
      await expect(
        registry.agentPluginCheck(runId, "initial", { source: source + "\n" }),
      ).resolves.toMatchObject({
        ok: false,
        attempt: 1,
        issues: ["该检查标识已使用，请重新发起检查"],
      });
      await expect(registry.preview(request, "different-run")).rejects.toMatchObject(unchecked);
      await expect(registry.preview({ pluginSource: source + "\n" }, runId)).rejects.toMatchObject(
        unchecked,
      );
      await expect(
        registry.agentPluginCheck(runId, "invalid-sample", { source, sample: "{" }),
      ).resolves.toMatchObject({ ok: false });
      await expect(registry.preview(request, runId)).rejects.toMatchObject(unchecked);
      await expect(registry.agentPluginCheck(runId, "recheck", { source })).resolves.toMatchObject({
        ok: true,
      });
      const preview = await registry.preview(request, runId);
      expect(preview).toMatchObject({
        kind: "plugin",
        plugin: { key: "version-preview", version: "1.0.0", source },
      });
      expect(preview).toMatchObject({
        review: {
          label: "OpenAI",
          key: "version-preview",
          versionBefore: null,
          versionAfter: "1.0.0",
          lines: source.split("\n").length,
          codeDiff: "",
          request: { method: "POST", url: "https://example.invalid/v1/responses" },
        },
      });
      expect(registry.list().plugins.some((plugin) => plugin.key === "version-preview")).toBe(
        false,
      );
      const inserted = await registry.pluginUpload(
        `${source}\nmodule.exports.meta.version='1.1.0-rc.1';`,
      );
      expect(inserted.plugin.version).toBe("1.1.0-rc.1");
      const receipt = await registry.applyProposal("version-preview", preview, [0], "owner");
      expect(receipt).toMatchObject({
        target: "plugin",
        navigable: true,
        reversible: false,
        items: [{ field: "插件草稿", before: null, after: "1.1.1", status: "applied" }],
      });
      expect(JSON.stringify(receipt)).not.toContain("module.exports");
      expect(
        await registry.applyProposal(
          "version-preview",
          JSON.parse(JSON.stringify(preview)),
          [0],
          "owner",
        ),
      ).toEqual(receipt);
      await expect(registry.reverseProposal(preview.orderNo, "other")).rejects.toMatchObject({
        code: "SETTINGS_PROPOSAL_INVALID",
      });
      await expect(registry.reverseProposal(preview.orderNo, "owner")).rejects.toMatchObject({
        code: "SETTINGS_CREATE_REVERT_MANUAL",
        issues: [
          { path: "version-preview", message: "新建的插件 / 渠道 / 模型请在对应页面手动删除" },
        ],
      });
      expect(
        registry
          .list()
          .plugins.filter((plugin) => plugin.key === "version-preview")
          .map((plugin) => plugin.version),
      ).toEqual(["1.1.0-rc.1", "1.1.1"]);
      await expect(registry.preview(request, runId)).rejects.toMatchObject({
        code: "PLUGIN_VERSION_DUPLICATE",
        issues: [{ path: "meta", message: "代码与 v1.1.1 完全相同，没有产生新版本" }],
      });
      const upgrade = source + "\n// 第二次审阅\n",
        nextRun = "upgrade-review";
      for (const domain of ["first.invalid", "second.invalid"]) {
        const sample = JSON.stringify({
          channel: { baseUrl: `https://${domain}/gateway` },
          input: { prompt: "不属于卡片的正文" },
        });
        expect(
          await registry.agentPluginCheck(nextRun, domain, { source: upgrade, sample }),
        ).toMatchObject({ ok: true });
      }
      const next = await registry.preview({ pluginSource: upgrade }, nextRun);
      if (next.kind !== "plugin") throw Error("未取得待审插件");
      const lines = source.split("\n");
      expect(next.review.request).toEqual({
        method: "POST",
        url: "https://second.invalid/gateway/v1/responses",
      });
      expect(next.review).toMatchObject({
        versionBefore: "1.1.1",
        versionAfter: "1.1.2",
        lines: lines.length + 2,
        codeDiff: `--- before\n+++ after\n@@ -1,${lines.length} +1,${lines.length + 1} @@\n-${lines.join("\n-")}\n+${lines.join("\n+")}\n+// 第二次审阅\n`,
      });
      expect(next.review.diff.map((entry) => entry.field)).toEqual([
        "meta.auth",
        "meta.endpoints",
        "meta.name",
        "meta.vendor",
        "plugin_key",
        "version",
      ]);
      expect(JSON.stringify(next.review)).not.toContain("不属于卡片的正文");
      await expect(
        registry.preview({ pluginSource: upgrade + "// sk-dontpersist123456" }, nextRun),
      ).rejects.toMatchObject({ code: "SETTINGS_PROPOSAL_INVALID" });
      registry.forgetPluginChecks(runId);
      await expect(registry.preview(request, runId)).rejects.toMatchObject(unchecked);
    });
  });
  it("内置发行号不可变；同哈希重放不改登记时间，不能接管上传的标识", async () => {
    await withRegistry(async ({ registry }) => {
      const original = registry.agentPlugin("openai").code;
      for (const origin of ["manual", "agent"] as const)
        for (const candidate of [original, original + "\n"])
          await expect(registry.draft(candidate, origin)).rejects.toMatchObject({
            code: "PLUGIN_BUILTIN_KEY_RESERVED",
          });
      const source = (key: string, version: string) =>
        `${original}\nObject.assign(module.exports.meta,${JSON.stringify({ key, version })});`;
      const higher = await registry.draft(source("release-fixture", "3.0.0"), "builtin");
      const lower = await registry.draft(source("release-fixture", "2.0.0"), "builtin");
      expect([higher.version, lower.version]).toEqual(["3.0.0", "2.0.0"]);
      expect(await registry.draft(lower.source, "builtin")).toEqual(lower);
      await expect(registry.draft(lower.source + "\n", "builtin")).rejects.toMatchObject({
        code: "PLUGIN_BUILTIN_VERSION_CONFLICT",
      });
      await expect(
        registry.draft(source("invalid-release", "v2"), "builtin"),
      ).rejects.toMatchObject({ code: "PLUGIN_BUILTIN_VERSION_INVALID" });
      const uploaded = await registry.pluginUpload(source("claimed-key", "1.0.0"));
      for (const candidate of [uploaded.plugin.source, source("claimed-key", "2.0.0")])
        await expect(registry.draft(candidate, "builtin")).rejects.toMatchObject({
          code: "PLUGIN_BUILTIN_KEY_OCCUPIED",
        });
      expect(registry.list().plugins.filter((plugin) => plugin.key === "claimed-key")).toEqual([
        uploaded.plugin,
      ]);
    });
  });
  it("兼容旧库的混合来源：保留手动行，按整个内置插件保护删除与报告来源", async () => {
    await withRegistry(async ({ registry, directory }) => {
      const legacy = await registry.inspect(
        registry.agentPlugin("openai").code + "\n// legacy draft",
      );
      legacy.meta.version = "1.2.2";
      const database = new DatabaseSync(join(directory, "settings.sqlite"));
      try {
        database
          .prepare("INSERT INTO plugin_versions VALUES (?, ?, ?)")
          .run(legacy.hash, JSON.stringify(legacy), "manual");
      } finally {
        database.close();
      }
      expect(registry.agentPluginList()).toContainEqual(
        expect.objectContaining({ key: "openai", builtin: true, latest_version: "1.2.2" }),
      );
      for (const allVersions of [false, true])
        expect(() => registry.pluginRemove({ hash: legacy.hash, allVersions })).toThrowError(
          expect.objectContaining({ code: "PLUGIN_BUILTIN_LOCKED" }),
        );
      expect(registry.agentPlugin("openai", "1.2.2").code).toBe(legacy.source);
      expect(
        registry.pluginDetail({ key: "openai" }).map((entry) => [entry.key, entry.version]),
      ).toEqual([
        ["openai", "1.2.1"],
        ["openai", "1.2.2"],
      ]);
      expect(() => registry.pluginDetail({ key: "removed-plugin" })).toThrowError(
        expect.objectContaining({ code: "PLUGIN_VERSION_MISSING" }),
      );
      expect(registry.list().plugins).toContainEqual(
        expect.objectContaining({ hash: legacy.hash, origin: "manual" }),
      );
    });
  });
  it("旧桌面取消分支与发行版同号不同源码：重启保留绑定与在途任务，其他内置更新照常登记", async () => {
    const root = await mkdtemp(join(tmpdir(), "link-release-upgrade-"));
    const bundle = join(root, "plugins");
    const open = async () =>
      SettingsRegistry.open(
        join(root, "data"),
        bundle,
        "out/provider-runtime/runner",
        { encrypt: Buffer.from, decrypt: (value) => Buffer.from(value).toString() },
        await testRelease(bundle),
      );
    try {
      await cp("resources/provider-plugins", bundle, { recursive: true });
      const path = join(bundle, "doubao-video.js");
      const upstream = await readFile(path, "utf8");
      const legacy = upstream.replace(
        'return failed(errorMessageOf(body) || "上游任务已被取消", errorCodeOf(body) || "cancelled");',
        'return { status: "cancelled" };',
      );
      const hash = createHash("sha256").update(legacy).digest("hex");
      expect(hash).toBe("2b962fbf3a042520a30c2725250bed621eb2727c6ec27f6e9ae8171bab82f8a4");
      await writeFile(path, legacy);
      const old = await open();
      let profile: ReturnType<SettingsRegistry["save"]>;
      try {
        profile = old.save({
          expectedRevision: 0,
          approve: true,
          pluginHash: hash,
          secret: "fixture",
          fields: {
            endpoint: "https://example.invalid",
            allowLocal: false,
            label: "旧版",
            model: "video",
            channel: {},
            agentEnabled: false,
          },
        });
        old.reconcileJobPins("legacy-project", [{ id: "remote-job", pluginHash: hash }]);
      } finally {
        old.close();
      }
      await writeFile(path, upstream);
      const laterPath = join(bundle, "xai.js");
      await writeFile(
        laterPath,
        (await readFile(laterPath, "utf8")) + "\nmodule.exports.meta.version='3.0.0';",
      );
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const current = await open();
        try {
          expect(warning).toHaveBeenCalledWith(expect.stringContaining("doubao-video@1.2.1"));
          expect(current.agentPlugin("xai").version).toBe("3.0.0");
          expect(
            current.list().plugins.filter((plugin) => plugin.key === "doubao-video"),
          ).toMatchObject([{ hash, source: legacy, version: "1.2.1", activeJobs: 1 }]);
          expect(current.binding(profile.id, profile.revision).plugin.hash).toBe(hash);
        } finally {
          current.close();
        }
      } finally {
        warning.mockRestore();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("随包撤下后分组清理：离线绑定、跨项目任务和混合来源均保护，清空后重启才清理", async () => {
    await withRegistry(async ({ registry, directory, input }) => {
      const code = registry.agentPlugin("openai").code;
      const release = { "openai.js": input.pluginHash };
      const open = () =>
        SettingsRegistry.open(
          directory,
          "resources/provider-plugins",
          "out/provider-runtime/runner",
          { encrypt: Buffer.from, decrypt: (value) => Buffer.from(value).toString() },
          release,
        );
      const retired = (key: string, version: string) =>
        registry.draft(
          `${code}\nObject.assign(module.exports.meta,{key:'${key}',version:'${version}'});`,
          "builtin",
        );
      const latest = await retired("previous", "2.0.0"),
        first = await retired("previous", "1.0.0");
      const pinned = await retired("running", "1.0.0"),
        unused = await retired("unused", "1.0.0");
      const rejected = await retired("audit-unavailable", "1.0.0");
      const mixed = await retired("mixed", "1.0.0");
      const manual = await registry.draft(`${code}\nmodule.exports.meta.key='mine';`);
      const database = new DatabaseSync(join(directory, "settings.sqlite"));
      try {
        const legacy = await registry.inspect(
          `${code}\nObject.assign(module.exports.meta,{key:'mixed',version:'0.1.0'});`,
        );
        database
          .prepare("INSERT INTO plugin_versions VALUES (?,?,?)")
          .run(legacy.hash, JSON.stringify(legacy), "manual");
        const channel = registry.channelSave({
          fields: {
            name: "旧发行",
            endpoint: "https://example.invalid",
            enabled: true,
            allowLocal: false,
            sort: 0,
            headers: [],
          },
          expectedRevision: 0,
          approve: true,
        });
        const model = registry.modelSave({
          channelId: channel.id,
          channelRevision: channel.revision,
          pluginHash: first.hash,
          upstreamModel: "old",
          enabled: false,
          expectedRevision: 0,
          settings: {},
          config: { kind: "text", name: "旧模型", description: "", sort: 0 },
        });
        registry.reconcileJobPins("closed-project", [{ id: "job", pluginHash: pinned.hash }]);
        registry.pluginToggle({ key: "unused", enabled: false });
        database.exec(
          "CREATE TRIGGER reject_prune BEFORE INSERT ON plugin_deletion_audit WHEN NEW.key='audit-unavailable' BEGIN SELECT RAISE(ABORT,'audit failed'); END",
        );
        const reopened = await open();
        try {
          expect(reopened.pluginDetail({ key: "previous" }).map((entry) => entry.hash)).toEqual([
            latest.hash,
            first.hash,
          ]);
          expect(reopened.pluginDeleteCheck({ key: "running" }).jobs).toBe(1);
          expect(reopened.pluginDetail({ key: "mixed" }).map((entry) => entry.hash)).toContain(
            mixed.hash,
          );
          expect(reopened.pluginDetail({ key: "mine" }).map((entry) => entry.hash)).toEqual([
            manual.hash,
          ]);
          expect(() => reopened.pluginDetail({ key: "unused" })).toThrow("PLUGIN_VERSION_MISSING");
          expect(
            reopened.pluginDetail({ key: "audit-unavailable" }).map((plugin) => plugin.hash),
          ).toEqual([rejected.hash]);
          expect(
            database
              .prepare("SELECT id FROM plugin_deletion_audit WHERE key=?")
              .get("audit-unavailable"),
          ).toBeUndefined();
          database.exec("DROP TRIGGER reject_prune");
          expect(
            database.prepare("SELECT * FROM disabled_plugin_keys WHERE key=?").get("unused"),
          ).toBeUndefined();
          const log = database
            .prepare("SELECT actor,target,reason,versions FROM plugin_deletion_audit WHERE key=?")
            .all("unused");
          expect(log).toEqual([
            {
              actor: "system",
              target: "plugin",
              reason: "内置插件已随发版下线",
              versions: JSON.stringify([{ version: "1.0.0", sha256: unused.hash }]),
            },
          ]);
          expect(
            database
              .prepare("SELECT hash FROM retired_builtin_sources WHERE hash=?")
              .get(unused.hash),
          ).toBeUndefined();
          reopened.modelRemove({ id: model.id, expectedRevision: model.revision });
          reopened.reconcileJobPins("closed-project", []);
          expect(reopened.pluginDetail({ key: "running" })).toHaveLength(1);
        } finally {
          reopened.close();
        }
        const next = await open();
        try {
          expect(() => next.pluginDetail({ key: "previous" })).toThrow("PLUGIN_VERSION_MISSING");
          expect(() => next.pluginDetail({ key: "running" })).toThrow("PLUGIN_VERSION_MISSING");
          expect(() => next.pluginDetail({ key: "audit-unavailable" })).toThrow(
            "PLUGIN_VERSION_MISSING",
          );
          expect(
            database.prepare("SELECT id FROM plugin_deletion_audit WHERE key=?").all("unused"),
          ).toHaveLength(1);
          expect(
            JSON.parse(
              String(
                database
                  .prepare("SELECT versions FROM plugin_deletion_audit WHERE key=?")
                  .get("previous")?.versions,
              ),
            ),
          ).toEqual([
            { version: "1.0.0", sha256: first.hash },
            { version: "2.0.0", sha256: latest.hash },
          ]);
        } finally {
          next.close();
        }
      } finally {
        database.close();
      }
    });
  });

  it("清单为空、缺文件、SHA 不符、预检或发行号冲突时保留旧组；同批其他插件可登记", async () => {
    await withRegistry(async ({ registry, directory, input }) => {
      const bundle = join(directory, "release");
      await cp("resources/provider-plugins", bundle, { recursive: true });
      const code = registry.agentPlugin("openai").code;
      const write = async (name: string, source: string) => {
        await writeFile(join(bundle, name), source);
        return createHash("sha256").update(source).digest("hex");
      };
      const good = await write("ok.js", code + "\nmodule.exports.meta.key='from-manifest';");
      const bad = await write("bad.js", "module.exports = {};");
      const changed = await write("conflict.js", code + "\n ");
      const open = (release: Record<string, string>) =>
        SettingsRegistry.open(
          directory,
          bundle,
          "out/provider-runtime/runner",
          { encrypt: Buffer.from, decrypt: (value) => Buffer.from(value).toString() },
          release,
        );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        for (const release of [
          {},
          { "absent.js": input.pluginHash },
          { "ok.js": good, "bad.js": bad },
          { "ok.js": good, "conflict.js": changed },
          { "openai.js": "0".repeat(64) },
        ] as Record<string, string>[]) {
          const next = await open(release);
          try {
            expect(next.pluginDeleteCheck({ key: "sora" }).builtin).toBe(true);
            expect(next.agentPlugin("openai").code).toBe(code);
          } finally {
            next.close();
          }
        }
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("PLUGIN_RELEASE_HASH_MISMATCH"));
        expect(registry.pluginDeleteCheck({ key: "from-manifest" }).builtin).toBe(true);
        const next = await open({ "ok.js": good });
        try {
          expect(next.agentPluginList().map((item) => item.key)).toEqual(["from-manifest"]);
        } finally {
          next.close();
        }
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("已登记版本也重做发行预检，runner 暂不可用时有限重试，耗尽后仍可打开原目录", async () => {
    await withRegistry(async ({ registry, directory, input }) => {
      const open = () =>
        SettingsRegistry.open(
          directory,
          "resources/provider-plugins",
          "out/provider-runtime/runner",
          { encrypt: Buffer.from, decrypt: (secret) => Buffer.from(secret).toString() },
          { "openai.js": input.pluginHash },
        );
      const call = vi
        .spyOn(PluginRunner.prototype, "call")
        .mockRejectedValue(new ProviderError("PLUGIN_RUNNER_CRASHED"));
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const retained = await open();
        try {
          expect(call).toHaveBeenCalledTimes(5);
          expect(warning).toHaveBeenCalledWith(expect.stringContaining("PLUGIN_RUNNER_CRASHED"));
          expect(retained.pluginDetail({ key: "sora" })).toHaveLength(1);
        } finally {
          retained.close();
        }
        call.mockRestore();
        const retry = vi
          .spyOn(PluginRunner.prototype, "call")
          .mockRejectedValueOnce(new ProviderError("PLUGIN_RUNNER_CRASHED"));
        try {
          const next = await open();
          try {
            expect(retry).toHaveBeenCalledTimes(2);
            expect(next.agentPluginList().map((plugin) => plugin.key)).toEqual(["openai"]);
          } finally {
            next.close();
          }
        } finally {
          retry.mockRestore();
        }
        expect(registry.agentPlugin("openai").key).toBe("openai");
      } finally {
        call.mockRestore();
        warning.mockRestore();
      }
    });
  });

  it("C6 原回执续查仍核对任务快照、端点、网络范围和当前凭证", async () => {
    await withRegistry(async ({ registry, input }) => {
      const fields = {
        name: "原渠道",
        endpoint: "https://fixture.invalid",
        allowLocal: false,
        enabled: true,
        sort: 0,
        headers: [],
      };
      let channel = registry.channelSave({
        fields,
        expectedRevision: 0,
        approve: true,
        secret: "fixture-key",
      });
      const model = registry.modelSave({
        channelId: channel.id,
        channelRevision: channel.revision,
        expectedRevision: 0,
        upstreamModel: "sample",
        pluginHash: input.pluginHash,
        enabled: true,
        settings: {},
        config: { kind: "text", name: "文本", sort: 0, description: "" },
      });
      const job = { project: "receipt-test", id: "submitted" };
      registry.rememberJobBinding(
        job.project,
        job.id,
        registry.binding(model.id, model.revision).profile,
      );
      const query = (target = job) =>
        registry.queryBinding(model.id, model.revision, input.pluginHash, target, "receipt-query");
      const disable = (endpoint: string, allowLocal: boolean) =>
        registry.channelSave({
          id: channel.id,
          expectedRevision: channel.revision,
          approve: true,
          fields: { ...fields, enabled: false, endpoint, allowLocal },
          secret: "fixture-current",
        });
      channel = disable(fields.endpoint, false);
      expect(query().secret).toBe("fixture-current");
      expect(() => query({ ...job, id: "other" })).toThrow();
      channel = registry.channelKeys({
        id: channel.id,
        expectedRevision: channel.revision,
        clearSecret: true,
      });
      expect(query).toThrow("PROVIDER_SECRET_MISSING");
      channel = disable(fields.endpoint, true);
      expect(query).toThrow("CHANNEL_TARGET_UNAVAILABLE");
      channel = disable("https://other.invalid", false);
      expect(query).toThrow("CHANNEL_TARGET_UNAVAILABLE");
    });
  });

  it.each([true, false])("撤包恢复数据仅凭原任务与渠道授权读取，旧库=%s", async (legacy) => {
    await withRegistry(async ({ registry, directory, input }) => {
      const key = "retired",
        old = await registry.draft(
          registry.agentPlugin("openai").code + `\nmodule.exports.meta.key='${key}';`,
          "builtin",
        );
      const channel = registry.channelSave({
        fields: {
          name: "原渠道",
          endpoint: input.fields.endpoint,
          allowLocal: true,
          sort: 0,
          enabled: true,
          headers: [],
        },
        expectedRevision: 0,
        secret: "old-secret",
        approve: true,
      });
      const fields = {
        expectedRevision: 0,
        channelId: channel.id,
        channelRevision: channel.revision,
        pluginHash: old.hash,
        upstreamModel: "old",
        enabled: true,
        config: { kind: "text" as const, name: "旧模型", description: "", sort: 0 },
        settings: {},
      };
      const model = registry.modelSave(fields);
      const job = { project: "closed-project", id: "unknown" };
      registry.rememberJobBinding(
        job.project,
        job.id,
        registry.binding(model.id, model.revision).profile,
      );
      registry.reconcileJobPins(job.project, [], [job.id]);
      const offline = registry.modelToggle({
        id: model.id,
        expectedRevision: model.revision,
        enabled: false,
      });
      registry.modelRemove({ id: model.id, expectedRevision: offline.revision });
      const database = new DatabaseSync(join(directory, "settings.sqlite"));
      try {
        if (legacy) database.exec("DROP TABLE legacy_builtin_hashes");
        const next = await SettingsRegistry.open(
          directory,
          "resources/provider-plugins",
          "out/provider-runtime/runner",
          {
            encrypt: (secret) => Buffer.from(secret).reverse(),
            decrypt: (secret) => Buffer.from(secret).reverse().toString(),
          },
        );
        try {
          expect(() => next.pluginDetail({ key })).toThrow("PLUGIN_VERSION_MISSING");
          expect(() => next.agentPlugin(key)).toThrow("PLUGIN_VERSION_MISSING");
          expect(next.list().plugins.some((plugin) => plugin.hash === old.hash)).toBe(false);
          expect(
            database.prepare("SELECT hash FROM retired_builtin_sources WHERE hash=?").get(old.hash),
          ).toMatchObject({ hash: old.hash });
          expect(() => next.modelSave(fields)).toThrow("PLUGIN_VERSION_MISSING");
          expect(() =>
            next.queryBinding(model.id, model.revision, old.hash, { ...job, id: "other" }),
          ).toThrow();
          expect(() => next.queryBinding(model.id, model.revision, input.pluginHash, job)).toThrow(
            "SETTINGS_REVISION_CONFLICT",
          );
          expect(next.queryBinding(model.id, model.revision, old.hash, job)).toMatchObject({
            plugin: { hash: old.hash },
            secret: "old-secret",
          });
          database
            .prepare(
              "UPDATE retired_builtin_sources SET manifest=json_set(manifest,'$.source','invalid') WHERE hash=?",
            )
            .run(old.hash);
          expect(() => next.queryBinding(model.id, model.revision, old.hash, job)).toThrow(
            "PLUGIN_VERSION_MISSING",
          );
          database
            .prepare(
              "UPDATE retired_builtin_sources SET manifest=json_set(manifest,'$.source',?) WHERE hash=?",
            )
            .run(old.source, old.hash);
          const newChannel = next.channelList().find((item) => item.id === channel.id)!;
          next.channelSave({
            id: channel.id,
            expectedRevision: newChannel.revision,
            fields: {
              name: "原渠道",
              endpoint: "https://other.invalid",
              allowLocal: false,
              enabled: true,
              sort: 0,
              headers: [],
            },
            approve: true,
          });
          expect(() => next.queryBinding(model.id, model.revision, old.hash, job)).toThrow(
            "CHANNEL_TARGET_UNAVAILABLE",
          );
          next.reconcileJobPins(job.project, []);
          expect(() => next.queryBinding(model.id, model.revision, old.hash, job)).toThrow();
          expect(
            Boolean(
              database
                .prepare("SELECT hash FROM retired_builtin_sources WHERE hash=?")
                .get(old.hash),
            ),
          ).toBe(legacy);
        } finally {
          next.close();
        }
      } finally {
        database.close();
      }
    });
  });

  it("同一运行每个插件分配三次检查，已用标识重放仍取原次数", async () => {
    await withRegistry(async ({ registry, directory }) => {
      const draft = { source: registry.agentPlugin("openai").code };
      const runId = "check-run";
      const checks = (tokens: string[]) =>
        Promise.all(tokens.map((token) => registry.agentPluginCheck(runId, token, draft)));
      const results = [...(await checks(["one", "two"])), ...(await checks(["three", "four"]))];
      expect(results.map((result) => result.attempts_left).sort()).toEqual([0, 0, 1, 2]);
      expect(results.filter((result) => result.issues.includes("已达自动修复上限"))).toHaveLength(
        1,
      );
      const first = results.findIndex((result) => result.attempt === 1);
      const reopened = await SettingsRegistry.open(
        directory,
        "resources/provider-plugins",
        "out/provider-runtime/runner",
        {
          encrypt: (value) => Buffer.from(value).reverse(),
          decrypt: (value) => Buffer.from(value).reverse().toString(),
        },
      );
      try {
        await expect(
          reopened.agentPluginCheck(runId, ["one", "two", "three", "four"][first]!, draft),
        ).resolves.toMatchObject({ attempt: 1, attempts_left: 2 });
        await expect(reopened.agentPluginCheck(runId, "five", draft)).resolves.toMatchObject({
          ok: false,
          issues: ["已达自动修复上限"],
        });
        const videoDraft = {
          source: reopened.agentPlugin("agnes-video").code,
          sample: JSON.stringify({
            input: { prompt: "走廊里的灯", op: "t2v" },
            responses: {
              submit: { status: 200, body: { video_id: "sample-video" } },
              query: {
                status: 200,
                body: { status: "completed", url: "https://example.invalid/sample.mp4" },
              },
            },
          }),
        };
        await expect(reopened.agentPluginCheck(runId, "one", videoDraft)).resolves.toMatchObject({
          ok: true,
          attempt: 1,
          attempts_left: 2,
          coverage: {
            checked_hooks: ["buildSubmitRequest", "parseSubmitResponse", "parseQueryResponse"],
          },
          parsed: {
            submit: { providerTaskId: "sample-video" },
            query: {
              status: "succeeded",
              outputs: [{ url: "https://example.invalid/sample.mp4" }],
            },
          },
        });
        await expect(reopened.agentPluginCheck("next-run", "one", draft)).resolves.toMatchObject({
          attempt: 1,
          attempts_left: 2,
        });
      } finally {
        reopened.close();
      }
    });
  });
  it("离线草稿表单保留媒体描述并遮盖查询鉴权、样例和已保存凭证的编码值", async () => {
    await withRegistry(async ({ registry, input }) => {
      const original = registry.agentPlugin("openai").code;
      const sampleKey = "test value+/1";
      const storedKey = "stored value+/2";
      await registry.save({ ...input, secret: storedKey });
      const sample = JSON.stringify({
        input: { images: [1], token: sampleKey, prompt: storedKey },
      });
      for (const kind of ["form", "multipart"]) {
        const fields = "{ count: 2, skip: null, image: { __fileRef: ctx.input.images[0] } }";
        const body =
          kind === "form"
            ? `form: ${fields}`
            : `multipart: { fields: ${fields}, parts: [{ name: 'file', fileRef: ctx.input.images[0] }] }`;
        const source = original.replace(
          "return buildResponsesRequest(ctx);",
          `return { method: 'POST', path: '/test', auth: {type: 'query', name: 'access'}, query: { label: ctx.input.token, copy: ctx.input.prompt }, ${body} };`,
        );
        const result = await registry.agentPluginCheck("draft-preview", kind, { source, sample });
        const description = { count: "2", image: { __fileRef: "input:images.0", as: "url" } };
        expect(result).toMatchObject({
          ok: true,
          request: {
            method: "POST",
            headers: {},
            body:
              kind === "form"
                ? description
                : {
                    fields: description,
                    parts: [{ name: "file", fileRef: "input:images.0", filename: "" }],
                  },
          },
        });
        if (!("request" in result) || !result.request) throw new Error("缺少草稿预览");
        expect(Object.fromEntries(new URL(result.request.url).searchParams)).toEqual({
          access: "••••",
          label: "••••",
          copy: "••••",
        });
      }
    });
  });
  it("OSS、COS、R2 与 S3 寻址预设对读取与写入使用相同的签名主机和对象键", async () => {
    const key = `link-studio/${"a".repeat(64)}.png`;
    const base = {
      endpoint: "https://objects.fixture.org",
      bucket: "fixture",
      region: "us-east-1",
      publicBase: "",
      accessKey: "bucket-access",
      secretKey: "bucket-secret",
    };
    const accountId = "a".repeat(32);
    const fixtures: [Partial<SettingsInput<"filingStorageSave">>, string, string][] = [
      [
        { provider: "aliyun_oss", region: "cn-hangzhou" },
        "fixture.oss-cn-hangzhou.aliyuncs.com",
        `/${key}`,
      ],
      [
        { provider: "tencent_cos", region: "ap-guangzhou", bucket: "fixture-1250000000" },
        "fixture-1250000000.cos.ap-guangzhou.myqcloud.com",
        `/${key}`,
      ],
      [{ provider: "r2", accountId }, `${accountId}.r2.cloudflarestorage.com`, `/fixture/${key}`],
      [
        { provider: "s3", addressing: "auto", endpoint: "" },
        "fixture.s3.us-east-1.amazonaws.com",
        `/${key}`,
      ],
      [{ provider: "s3", addressing: "virtual" }, "fixture.objects.fixture.org", `/${key}`],
      [{}, "objects.fixture.org", `/fixture/${key}`],
    ];
    for (const [overrides, hostname, pathname] of fixtures) {
      const config = { ...base, ...overrides };
      const get = new URL(await storageReadURL(config, key));
      expect([get.hostname, get.pathname]).toEqual([hostname, pathname]);
      expect(get.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
      await uploadFilingImage(
        config,
        key,
        Buffer.from("signed image"),
        "image/png",
        undefined,
        async (origin, local, request) => {
          expect([origin, local, request.url, request.headers.host]).toEqual([
            get.origin,
            false,
            get.origin + pathname,
            hostname,
          ]);
          expect(request.headers.authorization).toContain(
            `/${storageFields(config).region}/s3/aws4_request`,
          );
          const response = new IncomingMessage(new Socket());
          response.statusCode = 200;
          return response;
        },
      );
    }
    expect(() => storageFields({ ...base, provider: "tencent_cos" })).toThrow(
      "FILING_STORAGE_INVALID",
    );
    expect(() => storageFields({ ...base, provider: "r2", accountId: "not-an-account" })).toThrow(
      "FILING_STORAGE_INVALID",
    );
  });
  it("试跑按模型、修订和任务恢复，旧任务后完成不顶替新提交，过期清除媒体", async () => {
    await withRegistry(async ({ registry }) => {
      const clock = vi.spyOn(Date, "now");
      const start = Date.now();
      try {
        clock.mockReturnValue(start);
        registry.trialStart("first", "model", 2);
        expect(() => registry.trialStart("first", "model", 2)).toThrowError(
          expect.objectContaining({ code: "MODEL_TRIAL_BUSY" }),
        );
        clock.mockReturnValue(start + 1);
        registry.trialStart("second", "model", 2);
        expect(registry.trialTrace("model", 2, "second")).toEqual([]);
        const step = { id: "submit", kind: "http", phase: "submit", seq: 1 } as const;
        registry.trialSaveProgress("first", { phase: "submit", trace: [step] });
        expect(registry.trialTrace("model", 2, "first")).toEqual([step]);
        clock.mockReturnValue(start + 2);
        await registry.storeTrialOutput(
          "first",
          "preview",
          new Blob(["fixture"], { type: "video/mp4" }),
        );
        registry.trialSaveResult("first", {
          status: "succeeded",
          outputs: [],
          trace: [],
          logs: [],
        });
        expect(registry.trialLatest("model", 2)?.runId).toBe("second");
        expect(registry.trialTrace("model", 2, "first")).toEqual([]);
        expect(registry.trialTrace("other", 2, "first")).toBeNull();
        expect(registry.trialTrace("model", 1, "first")).toBeNull();
        expect(registry.trialLatest("model", 2, "first")?.result?.status).toBe("succeeded");
        expect(registry.trialLatest("model", 1, "first")).toBeNull();
        expect(registry.trialLatest("other", 2, "first")).toBeNull();
        expect(registry.trialOutput("second", "preview")).toBeUndefined();
        clock.mockReturnValue(start + 15 * 60_000 + 3);
        expect(registry.trialTrace("model", 2, "first")).toBeNull();
        expect(registry.trialOutput("first", "preview")).toBeDefined();
        expect(registry.trialLatest("model", 2)).toBeNull();
        expect(registry.trialOutput("first", "preview")).toBeUndefined();
      } finally {
        clock.mockRestore();
      }
    });
  });
  it("转存中按宽限期保留检查点，完成后从完成时间计算预览期限", async () => {
    await withRegistry(async ({ registry }) => {
      const start = Date.now();
      const minute = 60_000;
      const deadline = start + 120 * minute;
      const clock = vi.spyOn(Date, "now").mockReturnValue(start);
      try {
        for (const id of ["completed", "unfinished"]) {
          registry.trialStart(id, "model", 1);
          registry.saveTrialCheckpoint(id, {
            deadline,
            endpoint: "https://fixture.invalid",
            pluginHash: "fixture",
            input: {},
            downloads: { items: [], completed: [] },
          });
          await registry.storeTrialOutput(id, id, new Blob(["fixture"]));
        }
        clock.mockReturnValue(start + 60 * minute);
        expect(registry.trialLatest("model", 1, "completed")?.expiresAt).toBe(deadline);
        expect(registry.trialProgress("completed")).not.toBeNull();
        registry.trialSaveResult("completed", {
          status: "succeeded",
          outputs: [],
          trace: [],
          logs: [],
        });
        expect(registry.trialLatest("model", 1, "completed")?.expiresAt).toBe(start + 75 * minute);
        clock.mockReturnValue(start + 75 * minute);
        expect(registry.trialLatest("model", 1, "completed")).toBeNull();
        expect(registry.trialOutput("completed", "completed")).toBeUndefined();
        expect(registry.trialOutput("unfinished", "unfinished")).toBeDefined();
        clock.mockReturnValue(deadline);
        expect(registry.trialLatest("model", 1, "unfinished")).toBeNull();
        expect(registry.trialCheckpoint("unfinished")).toBeUndefined();
      } finally {
        clock.mockRestore();
      }
    });
  });

  it("同一人物最多五张，重复图片和并发的第六张不提交方舟", async () => {
    await withRegistry(async ({ registry }) => {
      const channel = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "方舟",
          endpoint: "https://ark.cn-beijing.volces.com",
          allowLocal: false,
          enabled: true,
          sort: 0,
          headers: [],
          filing: { enabled: true, groupId: "group", projectName: "" },
        },
        filingKeys: { accessKey: "fixture-access", secretKey: "fixture-secret" },
      });
      let calls = 0;
      const create = (index: number, humanId?: string) =>
        registry.filingAssets(
          {
            id: channel.id,
            expectedRevision: channel.revision,
            action: "create",
            name: "角色",
            url: `https://cdn.example.com/${index}.png`,
            humanId,
          },
          async () => ({ Id: `image-${++calls}` }),
        );
      const [first] = await create(1);
      expect(first?.humanId).toBeTruthy();
      await expect(create(1)).rejects.toThrow("CHANNEL_FILING_DUPLICATE");
      const results = await Promise.allSettled(
        [2, 3, 4, 5, 6].map((index) => create(index, first!.humanId)),
      );
      expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(4);
      expect(results[4]).toMatchObject({
        status: "rejected",
        reason: { code: "CHANNEL_FILING_HUMAN_FULL" },
      });
      expect(calls).toBe(5);
      const assets = await registry.filingAssets({
        id: channel.id,
        expectedRevision: channel.revision,
        action: "list",
      });
      expect(assets).toHaveLength(5);
      expect(new Set(assets.map((asset) => asset.humanId))).toEqual(new Set([first!.humanId]));
      const identity = { id: channel.id, expectedRevision: channel.revision };
      const url = "https://cdn.example.com/retry.png";
      const [failed] = await registry.filingAssets(
        { ...identity, action: "create", name: "候补", url },
        async () => {
          throw new Error("HTTP 503");
        },
      );
      expect(failed).toMatchObject({
        status: "failed",
        canRetry: true,
        error: "提交方舟失败，请稍后重新提交",
      });
      await expect(
        registry.filingAssets({
          ...identity,
          action: "cover",
          humanId: first!.humanId,
          assetId: failed!.id,
        }),
      ).rejects.toThrow("CHANNEL_FILING_INVALID_MEDIA");
      const retry = { ...identity, action: "retry" as const, assetId: failed!.id };
      const [pending] = await registry.filingAssets(
        retry,
        async (_endpoint, _keys, action, payload) => {
          expect(action).toBe("CreateAsset");
          expect(payload.URL).toBe(url);
          return { Id: "new-receipt" };
        },
      );
      expect(pending).toMatchObject({
        id: failed!.id,
        humanId: failed!.humanId,
        status: "processing",
        canRetry: false,
      });
      expect(pending).not.toHaveProperty("error");
      await expect(registry.filingAssets(retry)).rejects.toThrow("CHANNEL_FILING_RETRY_INVALID");
      const expired = AbortSignal.timeout(0);
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(expired);
      try {
        expect(
          await registry.resolveFiledReference(
            channel.id,
            url,
            undefined,
            async () => new Promise(() => {}),
          ),
        ).toBeUndefined();
        expect(timeout).toHaveBeenCalledWith(5000);
      } finally {
        timeout.mockRestore();
      }
      expect(
        await registry.resolveFiledReference(channel.id, url, undefined, async () => {
          throw new Error("unavailable");
        }),
      ).toBeUndefined();
      expect(
        await registry.resolveFiledReference(
          channel.id,
          url,
          undefined,
          async (_endpoint, _keys, action, payload) => {
            expect(action).toBe("GetAsset");
            expect(payload.Id).toBe("new-receipt");
            return { Status: "Active" };
          },
        ),
      ).toBe("new-receipt");
      const unusedQuery = vi.fn(async () => ({}));
      expect(await registry.resolveFiledReference(channel.id, url, undefined, unusedQuery)).toBe(
        "new-receipt",
      );
      expect(unusedQuery).not.toHaveBeenCalled();
      expect(registry.filedReference(channel.id, url)).toBe("new-receipt");
      const [rejected] = await registry.filingAssets({ ...retry, action: "refresh" }, async () => ({
        Status: "Failed",
        Message: "internal diagnostic",
      }));
      expect(rejected).toMatchObject({
        status: "failed",
        error: "方舟审核未通过，请换一张清晰的正面照",
      });
    });
  });

  it("本机原图备案上传签名，重试刷新过期读链，已绑定原图的角色仍受保护", async () => {
    await withRegistry(async ({ registry, directory }) => {
      const channel = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "方舟",
          endpoint: "https://ark.cn-beijing.volces.com",
          enabled: true,
          sort: 0,
          allowLocal: false,
          headers: [],
          filing: { enabled: true, groupId: "sample", projectName: "" },
        },
        filingKeys: { accessKey: "ark-access", secretKey: "ark-secret" },
      });
      const libraryOrigin = { project: randomUUID(), asset: randomUUID() };
      const input = {
        id: channel.id,
        expectedRevision: channel.revision,
        name: "小林",
        libraryOrigin,
      };
      const project = await ProjectStore.create(directory, "样片");
      const scene = project.snapshot;
      await project.close();
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      );
      const assetId = randomUUID();
      scene.assets[assetId] = {
        assetId,
        createdAt: scene.createdAt,
        origin: "imported",
        displayName: "小林_侧面.png",
        mediaType: "image",
        mimeType: "image/png",
        sha256: createHash("sha256").update(png).digest("hex"),
        sizeBytes: png.length,
        importMode: "copy",
        storage: { kind: "blob", hash: "0".repeat(64) },
        metadata: {},
        availability: "ready",
      };
      const asset = scene.assets[assetId];
      scene.canvas.nodes = [
        {
          id: "actor",
          type: "creative",
          position: { x: 0, y: 0 },
          data: {
            kind: "image",
            label: "甲",
            text: "",
            assetId,
            character: { name: "甲", look: "造型", description: "", extraAssetIds: [] },
          },
        },
      ];
      registry.indexFilingReferences(scene);
      const config = {
        endpoint: "https://objects.fixture.org",
        bucket: "fixture",
        region: "auto",
        publicBase: "",
        accessKey: "bucket-access",
        secretKey: "bucket-secret",
      };
      await expect(registry.enrollProjectImage(input, scene.projectId, asset, png)).rejects.toThrow(
        "FILING_STORAGE_REQUIRED",
      );
      const saved = registry.saveFilingStorage(config);
      expect(saved).not.toHaveProperty("secretKey");
      expect(registry.redact(config.secretKey)).not.toContain(config.secretKey);
      const requests: string[] = [];
      const put: typeof uploadFilingImage = (store, key, bytes, mime, signal) =>
        uploadFilingImage(store, key, bytes, mime, signal, async (base, local, request) => {
          expect([base, local, request.method]).toEqual([config.endpoint, false, "PUT"]);
          expect(request.headers.authorization).toContain(
            "AWS4-HMAC-SHA256 Credential=bucket-access/",
          );
          expect(request.headers["x-amz-content-sha256"]).toBe(asset.sha256);
          expect(request.body).toEqual(png);
          requests.push(request.url);
          const response = new IncomingMessage(new Socket());
          response.statusCode = 200;
          return response;
        });
      const create: typeof arkFiling = async (_endpoint, keys, action, payload) => {
        expect(keys.accessKey).toBe("ark-access");
        expect(action).toBe("CreateAsset");
        expect(payload.Name).toBe(asset.displayName);
        const url = new URL(payload.URL!);
        expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
        expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
        expect(url.origin + url.pathname).toBe(requests[0]);
        requests.push(url.href);
        if (requests.length === 2) throw new Error("暂不可用");
        return { Id: "remote-image" };
      };
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-11-22T10:00:00Z"));
        const [failed] = await registry.enrollProjectImage(
          input,
          scene.projectId,
          asset,
          png,
          undefined,
          create,
          put,
        );
        expect(failed).toMatchObject({
          humanName: "小林",
          name: asset.displayName,
          status: "failed",
          refs: [{ name: "甲", title: "样片" }],
        });
        expect(registry.projectFilings(scene.projectId, [asset]).get(assetId)).toEqual({
          filingEnabled: true,
          filingHumanName: "小林",
        });
        expect(registry.projectFilings(scene.projectId, [asset], channel.id).get(assetId)).toEqual({
          filingEnabled: true,
          filingHumanName: "小林",
        });
        expect(registry.projectFilings(scene.projectId, [asset], randomUUID()).size).toBe(0);
        const source = { ...asset, assetId: libraryOrigin.asset };
        const derived = { ...asset, assetId: randomUUID() };
        const origins = new Map([[derived.assetId, libraryOrigin]]);
        const owner = { filingEnabled: true, filingHumanName: "小林" };
        expect(
          registry.projectFilings(libraryOrigin.project, [source], channel.id).get(source.assetId),
        ).toEqual(owner);
        expect(
          registry.projectFilings("副本", [derived], channel.id, origins).get(derived.assetId),
        ).toEqual(owner);
        expect(registry.projectFilings("副本", [derived], randomUUID(), origins).size).toBe(0);
        expect(
          registry
            .projectFilings(
              "副本",
              [derived],
              channel.id,
              new Map([[derived.assetId, { ...libraryOrigin, asset: randomUUID() }]]),
            )
            .get(derived.assetId),
        ).toEqual({ filingEnabled: true });
        await expect(
          registry.enrollProjectImage(
            { ...input, libraryOrigin: undefined },
            libraryOrigin.project,
            source,
            png,
            undefined,
            create,
            put,
          ),
        ).rejects.toThrow("CHANNEL_FILING_DUPLICATE");
        await expect(
          registry.enrollProjectImage(input, "副本", derived, png, undefined, create, put),
        ).rejects.toThrow("CHANNEL_FILING_DUPLICATE");
        expect(requests).toHaveLength(2);
        await expect(
          registry.enrollProjectImage(input, scene.projectId, asset, png, undefined, create, put),
        ).rejects.toThrow("CHANNEL_FILING_DUPLICATE");
        vi.setSystemTime(new Date("2026-11-22T12:00:00Z"));
        await registry.filingAssets({ ...input, action: "retry", assetId: failed!.id }, create);
        expect(requests).toHaveLength(3);
        expect(new URL(requests[2]!).searchParams.get("X-Amz-Date")).toBe("20261122T120000Z");
        expect(requests[1]).not.toBe(requests[2]);
        expect(registry.hasLinkedFilingReference(channel.id, asset, scene.projectId)).toBe(true);
        expect(registry.projectFilings(scene.projectId, [asset]).get(assetId)).toEqual({
          filingEnabled: true,
          filingHumanName: "小林",
          filingSourceChannel: channel.id,
        });
        expect(
          registry.projectFilings(scene.projectId, [{ ...asset, sha256: "wrong" }]).get(assetId),
        ).toEqual({ filingEnabled: true });
        expect(registry.hasLinkedFilingReference(channel.id, asset, "另一个项目")).toBe(false);
        expect(
          registry.hasLinkedFilingReference(
            channel.id,
            { ...asset, sha256: "wrong" },
            scene.projectId,
          ),
        ).toBe(false);
        vi.setSystemTime(new Date("2026-11-22T14:00:00Z"));
        const fallback = await registry.projectFilingReference(
          channel.id,
          asset,
          scene.projectId,
          undefined,
          undefined,
          async () => ({ Status: "Processing" }),
        );
        expect(fallback.filedAssetId).toBeUndefined();
        expect(new URL(fallback.url!).searchParams.get("X-Amz-Date")).toBe("20261122T140000Z");
        const abort = AbortSignal.abort();
        await expect(
          registry.projectFilingReference(channel.id, asset, scene.projectId, undefined, abort),
        ).rejects.toMatchObject({ name: "AbortError" });
        const approved = await registry.projectFilingReference(
          channel.id,
          asset,
          scene.projectId,
          undefined,
          undefined,
          async (_endpoint, _keys, action, payload) => {
            expect([action, payload.Id]).toEqual(["GetAsset", "remote-image"]);
            return { Status: "Active" };
          },
        );
        expect(approved.filedAssetId).toBe("remote-image");
        expect(
          registry.projectFilings("副本", [derived], channel.id, origins).get(derived.assetId),
        ).toEqual(owner);
        expect(registry.hasLinkedFilingReference(channel.id, derived, "副本")).toBe(false);
        expect(registry.linkedFilingReceipt(channel.id, asset, scene.projectId)).toBe(
          "remote-image",
        );
        const membership = registry.projectFilings(scene.projectId, [asset]).get(assetId)!;
        expect(membership).toMatchObject({
          filingHumanName: "小林",
          filingImage: failed!.id,
          filingChannel: channel.id,
        });
        const copy = {
          ...asset,
          assetId: randomUUID(),
          metadata: { filingScope: membership.filingScope!, filingImage: failed!.id },
        };
        expect(registry.projectFilings("另一个项目", [copy]).get(copy.assetId)).toEqual(membership);
        await expect(
          registry.enrollProjectImage(input, "另一个项目", copy, png, undefined, create, put),
        ).rejects.toThrow("CHANNEL_FILING_DUPLICATE");
        expect(registry.projectFilings("另一个项目", [asset]).get(assetId)).toEqual({
          filingEnabled: true,
        });
        expect(requests).toHaveLength(3);
        await expect(
          registry.filingAssets({ ...input, action: "removeHuman", humanId: failed!.humanId }),
        ).rejects.toThrow("CHANNEL_FILING_IMAGE_IN_USE");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("切换备案渠道后可清理旧渠道的人物，不使用新旧渠道凭证删除远程素材", async () => {
    await withRegistry(async ({ registry }) => {
      const fields = {
        name: "原渠道",
        endpoint: "https://ark.cn-beijing.volces.com",
        enabled: true,
        sort: 0,
        allowLocal: false,
        headers: [],
        filing: { enabled: true, groupId: "sample", projectName: "" },
      };
      const filingKeys = { accessKey: "test-access", secretKey: "test-secret" };
      const channel = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        fields,
        filingKeys,
      });
      const [person] = await registry.filingAssets(
        {
          id: channel.id,
          expectedRevision: channel.revision,
          action: "create",
          name: "保留原图",
          url: "https://example.org/one.png",
        },
        async () => ({ Id: "one" }),
      );
      const old = registry.channelSave({
        id: channel.id,
        expectedRevision: channel.revision,
        approve: true,
        fields: { ...fields, filing: { ...fields.filing, enabled: false } },
      });
      expect(old.hasFilingRecords).toBe(true);
      registry.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: { ...fields, name: "新渠道" },
        filingKeys,
      });
      const request = vi.fn(async () => ({}));
      expect(
        await registry.filingAssets(
          {
            id: old.id,
            expectedRevision: old.revision,
            action: "removeHuman",
            humanId: person!.humanId,
          },
          request,
        ),
      ).toEqual([]);
      expect(request).not.toHaveBeenCalled();
      expect(registry.channelList().find((item) => item.id === old.id)?.hasFilingRecords).toBe(
        false,
      );
    });
  });

  it("方舟移除真人中断后保留全部图片，重开只删除剩余远程素材", async () => {
    await withRegistry(async ({ registry, directory }) => {
      const channel = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "方舟",
          endpoint: "https://ark.cn-beijing.volces.com",
          allowLocal: false,
          enabled: true,
          sort: 0,
          headers: [],
          filing: { enabled: true, groupId: "sample", projectName: "" },
        },
        filingKeys: { accessKey: "sample-access", secretKey: "sample-secret" },
      });
      const filing = { id: channel.id, expectedRevision: channel.revision };
      const [first] = await registry.filingAssets(
        { ...filing, action: "create", name: "人物", url: "https://example.org/a.png" },
        async () => ({ Id: "first" }),
      );
      const humanId = first!.humanId;
      const preview = { ...filing, assetId: first!.id };
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      );
      const imageResponse = (length: number) => {
        const response = new IncomingMessage(new Socket());
        response.statusCode = 200;
        response.headers = { "content-length": String(length) };
        response.push(png);
        response.push(null);
        return response;
      };
      const blob = await registry.filingPreview(preview, async (origin, allowLocal, request) => {
        expect([origin, allowLocal]).toEqual(["https://example.org", false]);
        expect(request).toMatchObject({
          url: "https://example.org/a.png",
          headers: {},
          method: "GET",
        });
        return imageResponse(png.length);
      });
      expect(blob?.type).toBe("image/png");
      expect(Buffer.from(await blob!.arrayBuffer())).toEqual(png);
      expect(
        await registry.filingPreview(preview, async () => imageResponse(11 * 1024 * 1024)),
      ).toBeNull();
      expect(await registry.filingPreview({ ...preview, assetId: "absent" })).toBeNull();
      await registry.filingAssets(
        { ...filing, action: "create", humanId, name: "第二张", url: "https://example.org/b.png" },
        async () => ({ Id: "second" }),
      );
      const deletion = { ...filing, action: "removeHuman" as const, humanId };
      await registry.filingAssets(
        { ...filing, action: "refresh", assetId: first!.id },
        async () => ({ Status: "Active" }),
      );
      const identity = registry.filingImageIdentity(preview);
      const mainId = randomUUID();
      const extraId = randomUUID();
      const store = await ProjectStore.create(directory, "例片");
      const scene = store.snapshot;
      await store.close();
      for (const assetId of [mainId, extraId])
        scene.assets[assetId] = {
          assetId,
          createdAt: scene.createdAt,
          origin: "imported",
          displayName: "角色图",
          mediaType: "image",
          mimeType: "image/png",
          sha256: "0".repeat(64),
          sizeBytes: png.length,
          importMode: "copy",
          storage: { kind: "blob", hash: "0".repeat(64) },
          metadata: { filingScope: identity.scope, filingImage: identity.image },
          availability: "ready",
        };
      const character = { name: "角色甲", look: "默认", description: "", extraAssetIds: [extraId] };
      const imported = scene.assets[mainId]!;
      expect(registry.linkedFilingReceipt(channel.id, imported)).toBeUndefined();
      imported.sha256 = createHash("sha256").update(png).digest("hex");
      expect(registry.linkedFilingReceipt(channel.id, imported)).toBe(first!.id);
      expect(registry.linkedFilingReceipt(undefined, imported)).toBeUndefined();
      scene.canvas.nodes = [
        {
          id: "role",
          type: "creative",
          position: { x: 0, y: 0 },
          data: { kind: "image", label: "角色", text: "", assetId: mainId, character },
        },
      ];
      registry.indexFilingReferences(scene);
      const other = { ...scene, projectId: randomUUID(), name: "第二项目" };
      registry.indexFilingReferences(other);
      const check = () =>
        registry
          .filingAssets({ ...filing, action: "list" })
          .then((rows) => rows.find((image) => image.id === identity.image)?.refs);
      expect(await check()).toHaveLength(2);
      const unexpectedDelete = vi.fn(async () => ({}));
      await expect(registry.filingAssets(deletion, unexpectedDelete)).rejects.toThrow(
        "CHANNEL_FILING_IMAGE_IN_USE",
      );
      scene.canvas.nodes = [];
      registry.indexFilingReferences(scene);
      expect(await check()).toMatchObject([{ title: "第二项目", name: "角色甲" }]);
      await expect(
        registry.filingAssets(
          { ...filing, action: "remove", assetId: first!.id },
          unexpectedDelete,
        ),
      ).rejects.toThrow("CHANNEL_FILING_IMAGE_IN_USE");
      expect(unexpectedDelete).not.toHaveBeenCalled();
      registry.indexFilingReferences({ ...other, canvas: scene.canvas });
      const deleted: string[] = [];
      await expect(
        registry.filingAssets(deletion, async (_endpoint, _keys, action, payload) => {
          expect(action).toBe("DeleteAsset");
          if (deleted.length) throw new Error("unavailable");
          deleted.push(String(payload.Id));
          return {};
        }),
      ).rejects.toThrow("unavailable");
      const reopened = await SettingsRegistry.open(
        directory,
        "resources/provider-plugins",
        "out/provider-runtime/runner",
        {
          encrypt: (value) => Buffer.from(value).reverse(),
          decrypt: (value) => Buffer.from(value).reverse().toString(),
        },
      );
      try {
        const remaining = await reopened.filingAssets({ ...filing, action: "list" });
        expect(remaining).toHaveLength(2);
        expect(remaining.find((image) => image.id === deleted[0])).toMatchObject({
          status: "failed",
          canRetry: false,
        });
        expect(remaining.find((image) => image.id === deleted[0])).not.toHaveProperty("error");
        expect(
          await reopened.filingAssets(deletion, async (_endpoint, _keys, action, payload) => {
            expect(action).toBe("DeleteAsset");
            deleted.push(String(payload.Id));
            return {};
          }),
        ).toEqual([]);
        expect(deleted.sort()).toEqual(["first", "second"]);
      } finally {
        reopened.close();
      }
    });
  });

  it("方舟备案限官方单渠道，独立 AK/SK 只写并在更换端点时清除", async () => {
    await withRegistry(async ({ registry }) => {
      const fields = {
        name: "方舟",
        endpoint: "https://ark.cn-beijing.volces.com",
        allowLocal: false,
        enabled: true,
        sort: 0,
        headers: [],
        filing: { enabled: true, groupId: "group-test", projectName: "" },
      };
      const input = { fields, expectedRevision: 0, approve: true };
      const saved = registry.channelSave({
        ...input,
        filingKeys: { accessKey: "fixture-filing-access", secretKey: "fixture-filing-secret" },
      });
      expect(saved).toMatchObject({ hasFilingKeys: true, hasSecret: false, hasSecretKey: false });
      expect(JSON.stringify(registry.channelList())).not.toContain("fixture-filing-");
      expect(registry.redact("fixture-filing-access fixture-filing-secret")).toBe(
        "[凭证已移除] [凭证已移除]",
      );
      expect(() => registry.channelSave(input)).toThrowError(
        expect.objectContaining({ code: "CHANNEL_FILING_IN_USE" }),
      );
      const edit = { ...input, id: saved.id, expectedRevision: saved.revision };
      const image = "https://cdn.example.com/a.png";
      const signed: typeof arkFiling = async (endpoint, keys, action, payload) =>
        arkFiling(endpoint, keys, action, payload, {
          now: new Date("2026-11-18T08:30:00Z"),
          transport: async (request) => {
            expect(request.headers["x-date"]).toBe("20261118T083000Z");
            expect(request.url).toBe(
              `https://ark.cn-beijing.volcengineapi.com/?Action=${action}&Version=2024-01-01`,
            );
            expect(request.headers.authorization).toMatch(
              /^HMAC-SHA256 Credential=fixture-filing-access\/20261118\/cn-beijing\/ark\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[a-f0-9]{64}$/,
            );
            if (action === "CreateAsset")
              expect(JSON.parse(Buffer.from(request.body ?? []).toString())).toEqual({
                URL: image,
                GroupId: "group-test",
                AssetType: "Image",
                Name: "参考图",
                ProjectName: "default",
              });
            return {
              status: 200,
              body: { Result: action === "GetAsset" ? { Status: "Active" } : { Id: "asset-123" } },
              headers: {},
              text: "",
            };
          },
        });
      const filing = { id: saved.id, expectedRevision: saved.revision };
      expect(
        await registry.filingAssets(
          { ...filing, action: "create", name: "参考图", url: image },
          signed,
        ),
      ).toMatchObject([{ id: "asset-123", status: "processing" }]);
      expect(registry.filedReference(saved.id, image)).toBeUndefined();
      await registry.filingAssets({ ...filing, action: "refresh", assetId: "asset-123" }, signed);
      expect(registry.filedReference(saved.id, image)).toBe("asset-123");
      expect(
        registry.filedReference(
          saved.id,
          `${image}?x-amz-date=20261118T083000Z&x-amz-signature=renewed`,
        ),
      ).toBe("asset-123");
      expect(
        registry.filedReference(
          saved.id,
          `${image}?variant=front&x-amz-date=20261118T083000Z&x-amz-signature=renewed`,
        ),
      ).toBeUndefined();
      const unexpectedDelete = vi.fn(signed);
      await expect(
        registry.filingAssets(
          { ...filing, action: "remove", assetId: "asset-123" },
          unexpectedDelete,
        ),
      ).rejects.toThrow("CHANNEL_FILING_LAST_IMAGE");
      expect(unexpectedDelete).not.toHaveBeenCalled();
      const [person] = await registry.filingAssets({ ...filing, action: "list" });
      await registry.filingAssets(
        { ...filing, action: "removeHuman", humanId: person!.humanId },
        signed,
      );
      expect(registry.filedReference(saved.id, image)).toBeUndefined();
      expect(() =>
        registry.channelSave({ ...edit, fields: { ...fields, endpoint: "https://example.org" } }),
      ).toThrowError(expect.objectContaining({ code: "CHANNEL_FILING_INVALID" }));
      expect(() =>
        registry.channelSave({ ...edit, filingKeys: { accessKey: "new", secretKey: "" } }),
      ).toThrowError(expect.objectContaining({ code: "CHANNEL_FILING_KEYS_INVALID" }));
      const retained = registry.channelSave(edit);
      expect(retained.hasFilingKeys).toBe(true);
      const moved = registry.channelSave({
        ...edit,
        expectedRevision: retained.revision,
        fields: { ...fields, endpoint: "https://ark.ap-southeast.bytepluses.com" },
      });
      expect(moved.hasFilingKeys).toBe(false);
    });
  });
  it("按插件标识预检全部版本，提交时重新统计离线模型与进行中的任务", async () => {
    await withRegistry(async ({ registry, input, directory }) => {
      const key = "delete-fixture";
      const source = registry.agentPlugin("openai").code + `\nmodule.exports.meta.key='${key}';`;
      const first = await registry.draft(source);
      const second = await registry.draft(source + "\nmodule.exports.meta.version='2.0.0';");
      const remove = () => registry.pluginRemove({ key, allVersions: true });
      expect(registry.pluginDeleteCheck({ key })).toEqual({ builtin: false, models: [], jobs: 0 });
      const channel = registry.channelSave({
        fields: {
          name: "删除测试",
          endpoint: input.fields.endpoint,
          allowLocal: true,
          sort: 0,
          enabled: true,
          headers: [],
        },
        approve: true,
        expectedRevision: 0,
      });
      const draft = {
        expectedRevision: 0,
        channelId: channel.id,
        channelRevision: channel.revision,
        settings: {},
        enabled: false,
      };
      const bind = (upstreamModel: string, name: string, pluginHash: string) =>
        registry.modelSave({
          ...draft,
          upstreamModel,
          pluginHash,
          config: { name, kind: "text", description: "", sort: 0 },
        });
      const zeta = bind("zeta", "模型乙", second.hash),
        alpha = bind("alpha", "模型甲", first.hash);
      expect(registry.pluginDetail({ key }).map((entry) => [entry.hash, entry.modelCount])).toEqual(
        [
          [first.hash, 1],
          [second.hash, 1],
        ],
      );
      expect(registry.pluginPinnedModels({ key })).toEqual([
        { id: alpha.id, name: "模型甲", channelId: channel.id, hash: first.hash },
        { id: zeta.id, name: "模型乙", channelId: channel.id, hash: second.hash },
      ]);
      registry.reconcileJobPins("project", [
        { id: "one", pluginHash: first.hash },
        { id: "two", pluginHash: second.hash },
      ]);
      expect(registry.pluginDeleteCheck({ key })).toEqual({
        builtin: false,
        models: [
          { id: alpha.id, name: "模型甲" },
          { id: zeta.id, name: "模型乙" },
        ],
        jobs: 2,
      });
      expect(remove).toThrowError(
        expect.objectContaining({
          code: "PLUGIN_REFERENCED",
          issues: [
            { path: "key", message: `插件 ${key} 被 2 个模型、2 个进行中的任务使用，无法删除` },
          ],
        }),
      );
      for (const model of [zeta, alpha])
        registry.modelRemove({ id: model.id, expectedRevision: model.revision });
      expect(registry.pluginDetail({ key }).map((entry) => entry.modelCount)).toEqual([0, 0]);
      expect(registry.pluginPinnedModels({ key })).toEqual([]);
      expect(remove).toThrowError(
        expect.objectContaining({
          code: "PLUGIN_JOB_REFERENCED",
          issues: [
            { path: "key", message: `插件 ${key} 被 0 个模型、2 个进行中的任务使用，无法删除` },
          ],
        }),
      );
      expect(registry.pluginDetail({ key })).toHaveLength(2);
      const audit = () => {
        const database = new DatabaseSync(join(directory, "settings.sqlite"), { readOnly: true });
        try {
          return database
            .prepare(
              "SELECT actor,target,versions FROM plugin_deletion_audit WHERE key=? ORDER BY id",
            )
            .all(key);
        } finally {
          database.close();
        }
      };
      expect(audit()).toEqual([]);
      registry.reconcileJobPins("project", []);
      expect(registry.pluginRemove({ key, version: second.version, allVersions: false })).toEqual({
        removed: true,
      });
      expect(() =>
        registry.pluginRemove({ key, version: second.version, allVersions: false }),
      ).toThrowError(
        expect.objectContaining({
          issues: [{ path: "version", message: `插件 ${key} 没有版本 ${second.version}` }],
        }),
      );
      expect(remove()).toEqual({ removed: true });
      expect(() =>
        registry.pluginRemove({ key, version: first.version, allVersions: false }),
      ).toThrowError(
        expect.objectContaining({ issues: [{ path: "version", message: "插件不存在" }] }),
      );
      expect(() => registry.pluginDeleteCheck({ key })).toThrow("PLUGIN_VERSION_MISSING");
      expect(() => registry.pluginRemove({ key: "openai", allVersions: true })).toThrow(
        "PLUGIN_BUILTIN_LOCKED",
      );
      expect(audit()).toEqual(
        (
          [
            ["version", second],
            ["plugin", first],
          ] as const
        ).map(([target, plugin]) => ({
          actor: "local",
          target,
          versions: JSON.stringify([{ version: plugin.version, sha256: plugin.hash }]),
        })),
      );
    });
  });
  it("在途任务保护已解绑的上传版本，重开设置库后仍然保护整组", async () => {
    await withRegistry(async ({ registry, directory }) => {
      const builtin = registry.list().plugins.find((plugin) => plugin.key === "openai");
      if (!builtin) throw new Error("Missing fixture");
      const source = builtin.source.replace('key: "openai"', 'key: "pin-fixture"');
      const first = await registry.draft(source);
      const second = await registry.draft(`${source}\n//v2`);
      const channel = registry.channelSave({
        fields: {
          name: "占用中的渠道",
          endpoint: "https://example.invalid",
          allowLocal: false,
          enabled: true,
          sort: 0,
          headers: [],
        },
        approve: true,
        expectedRevision: 0,
      });
      registry.reconcileJobPins("project", [
        { id: "remote-job", pluginHash: second.hash, channelId: channel.id },
      ]);
      const reopened = await SettingsRegistry.open(
        directory,
        "resources/provider-plugins",
        "out/provider-runtime/runner",
        { encrypt: Buffer.from, decrypt: (value) => Buffer.from(value).toString() },
      );
      try {
        expect(reopened.channelList().find((item) => item.id === channel.id)?.activeJobs).toBe(1);
        expect(
          reopened.list().plugins.find((entry) => entry.hash === second.hash)?.activeJobs,
        ).toBe(1);
        expect(() =>
          reopened.channelRemove({ id: channel.id, expectedRevision: channel.revision }),
        ).toThrowError(expect.objectContaining({ code: "CHANNEL_ACTIVE_JOBS" }));
        expect(() => reopened.pluginRemove({ hash: first.hash, allVersions: true })).toThrowError(
          expect.objectContaining({ code: "PLUGIN_JOB_REFERENCED" }),
        );
        expect(reopened.list().plugins.filter((plugin) => plugin.key === first.key)).toHaveLength(
          2,
        );
        reopened.reconcileJobPins("project", []);
        expect(
          reopened.list().plugins.find((entry) => entry.hash === second.hash)?.activeJobs,
        ).toBe(0);
        expect(
          reopened.channelRemove({ id: channel.id, expectedRevision: channel.revision }),
        ).toEqual({ removed: true });
        expect(reopened.pluginRemove({ hash: second.hash, allVersions: true })).toEqual({
          removed: true,
        });
        expect(registry.list().plugins.filter((plugin) => plugin.key === first.key)).toHaveLength(
          0,
        );
      } finally {
        reopened.close();
      }
    });
  });
  it("停用整组协议拦截新绑定，已提交任务仍可查询原版本", async () => {
    await withRegistry(async ({ registry, input }) => {
      const profile = registry.save(input);
      const plugin = registry.binding(profile.id, profile.revision).plugin;
      const legacyJob = {
        id: "legacy-job",
        input: { providerId: profile.id, expectedProviderRevision: profile.revision },
        pluginHash: plugin.hash,
      };
      expect(registry.hasOriginalJobBinding("legacy-project", legacyJob)).toBe(true);
      const next = await registry.draft(
        `${plugin.source}\nmodule.exports.meta.version='2.0.0';`,
        "builtin",
      );
      registry.pluginToggle({ hash: next.hash, enabled: false });
      expect(() => registry.binding(profile.id, profile.revision)).toThrowError(
        expect.objectContaining({ code: "PLUGIN_DISABLED" }),
      );
      expect(registry.queryBinding(profile.id, profile.revision, plugin.hash).plugin.hash).toBe(
        plugin.hash,
      );
      expect(
        (await registry.draft(`${plugin.source}\nmodule.exports.meta.version='3.0.0';`, "builtin"))
          .disabled,
      ).toBe(true);
      registry.pluginToggle({ hash: plugin.hash, enabled: true });
      expect(
        registry.pluginUpgrade({ fromHash: plugin.hash, toHash: next.hash, approve: true })
          .upgraded,
      ).toBe(1);
      expect(registry.queryBinding(profile.id, profile.revision, plugin.hash).plugin.hash).toBe(
        plugin.hash,
      );
      const current = registry.provider(profile.id);
      expect(registry.hasOriginalJobBinding("legacy-project", legacyJob)).toBe(true);
      registry.disable({ id: current.id, expectedRevision: current.revision });
      expect(() => registry.queryBinding(profile.id, profile.revision, plugin.hash)).toThrowError(
        expect.objectContaining({ code: "SETTINGS_REVISION_CONFLICT" }),
      );
      expect(
        registry
          .list()
          .plugins.filter(({ key }) => key === plugin.key)
          .every(({ disabled }) => !disabled),
      ).toBe(true);
    });
  });
  it("渠道负载按持有的有效名额和未获得名额的任务计数；转存不计负载但保留引用", async () => {
    await withRegistry(async ({ registry, input }) => {
      const channel = registry.channelSave({
        fields: {
          name: "负载",
          endpoint: input.fields.endpoint,
          allowLocal: true,
          enabled: true,
          sort: 10,
          headers: [],
        },
        expectedRevision: 0,
        approve: true,
      });
      const pin = (id: string) => ({ id, pluginHash: input.pluginHash, channelId: channel.id });
      expect(registry.channelLoads()).toEqual([]);
      registry.reconcileJobPins("A", [pin("同名"), pin("队列")]);
      registry.reconcileJobPins("B", [pin("同名")]);
      const release = registry.acquireGeneration(channel.id, "A", "同名");
      const releaseTrial = registry.acquireGeneration(channel.id, "model-trial", "试跑");
      expect(registry.channelLoads()).toEqual([{ channel: channel.id, running: 2, waiting: 2 }]);
      registry.markFinalizing("A", "同名");
      expect(registry.channelLoads()).toEqual([{ channel: channel.id, running: 1, waiting: 2 }]);
      expect(registry.channelList()[0]?.activeJobs).toBe(3);
      release?.();
      releaseTrial?.();
      expect(registry.channelLoads()).toEqual([{ channel: channel.id, running: 0, waiting: 2 }]);
      registry.reconcileJobPins("A", [{ ...pin("同名"), status: "downloading" }]);
      registry.reconcileJobPins("B", []);
      expect(registry.channelLoads()).toEqual([]);
    });
  });
  it("升级在线模型重新检查渠道和 Key；失败保留原绑定，不阻止离线兄弟升级", async () => {
    await withRegistry(async ({ registry, input }) => {
      const current = registry.agentPlugin("openai");
      const release = await registry.draft(
        current.code + "\nmodule.exports.meta.version='2.0.0';",
        "builtin",
      );
      const fields = {
        name: "升级检查",
        endpoint: input.fields.endpoint,
        allowLocal: true,
        sort: 1,
        enabled: true,
        headers: [],
      };
      let channel = registry.channelSave({
        fields,
        secret: "original-key",
        approve: true,
        expectedRevision: 0,
      });
      const model = {
        expectedRevision: 0,
        channelId: channel.id,
        channelRevision: channel.revision,
        pluginHash: input.pluginHash,
        config: { name: "文本", kind: "text" as const, description: "", sort: 0 },
        settings: {},
      };
      const online = registry.modelSave({ ...model, upstreamModel: "online", enabled: true });
      const offline = registry.modelSave({ ...model, upstreamModel: "offline", enabled: false });
      channel = registry.channelKeys({
        id: channel.id,
        expectedRevision: channel.revision,
        clearSecret: true,
      });
      const run = () =>
        registry.pluginUpgrade({ fromHash: input.pluginHash, toHash: release.hash, approve: true });
      const failed = (code: string) => [{ id: online.id, model: "online", code }];
      const before = registry.provider(online.id);
      expect(run()).toEqual({ upgraded: 1, failed: failed("PROVIDER_SECRET_MISSING") });
      expect(registry.provider(online.id)).toEqual(before);
      expect(registry.provider(offline.id).pluginHash).toBe(release.hash);
      channel = registry.channelSave({
        id: channel.id,
        expectedRevision: channel.revision,
        fields: { ...fields, enabled: false },
        secret: "replaced-key",
        approve: true,
      });
      expect(run()).toEqual({ upgraded: 0, failed: failed("PROVIDER_DISABLED") });
      registry.channelSave({
        id: channel.id,
        expectedRevision: channel.revision,
        fields,
        approve: true,
      });
      expect(run()).toEqual({ upgraded: 1, failed: [] });
      expect(registry.provider(online.id).pluginHash).toBe(release.hash);
    });
  });
  it("服务端按整数核心选择实际版本，同核心不同后缀照常迁移，重放不重写模型", async () => {
    await withRegistry(async ({ registry, input }) => {
      const source = registry.agentPlugin("openai").code;
      const release = (version: string) =>
        registry.draft(`${source}\nmodule.exports.meta.version='${version}';`, "builtin");
      const run = () => registry.pluginUpgradeAll({ key: "openai", approve: true });
      const highest = await release("9007199254740993.0.0-rc");
      const lower = await release("9007199254740992.0.0");
      const model = registry.save({ ...input, pluginHash: lower.hash });
      expect(run()).toEqual({ toVersion: highest.version, upgraded: 1, failed: [] });
      const stable = await release("9007199254740993.0.0");
      expect(run()).toEqual({ toVersion: stable.version, upgraded: 1, failed: [] });
      const latest = registry.provider(model.id);
      expect(latest.pluginHash).toBe(stable.hash);
      expect(run()).toEqual({ toVersion: stable.version, upgraded: 0, failed: [] });
      expect(registry.provider(model.id)).toEqual(latest);
      expect(registry.queryBinding(model.id, model.revision, lower.hash).plugin.hash).toBe(
        lower.hash,
      );
    });
  });
  it("停用按标识提交：预览版本已删除仍能停用剩余版本，整组消失则不创建幽灵状态", async () => {
    await withRegistry(async ({ registry }) => {
      const source =
        registry.agentPlugin("openai").code + "\nmodule.exports.meta.key='toggle-live';";
      const first = await registry.draft(source);
      const second = await registry.draft(source + "\n");
      registry.pluginRemove({ hash: second.hash, allVersions: false });
      expect(registry.pluginToggle({ key: first.key, enabled: false })).toMatchObject({
        hash: first.hash,
        disabled: true,
      });
      expect((await registry.draft(source + "\n\n")).disabled).toBe(true);
      registry.pluginRemove({ hash: first.hash, allVersions: true });
      expect(() => registry.pluginToggle({ key: first.key, enabled: false })).toThrow(
        "PLUGIN_VERSION_MISSING",
      );
      expect((await registry.draft(source)).disabled).toBe(false);
    });
  });
  it("升级失败说明目标能力或凭证授权变化，保留模型、修订和原有绑定", async () => {
    await withRegistry(async ({ registry, input }) => {
      const source = registry.agentPlugin("openai").code;
      const saved = registry.save(input);
      const check = (version: string, reason: string) => {
        const result = registry.pluginUpgradeAll({ key: "openai", approve: true });
        expect(result).toEqual({
          toVersion: version,
          upgraded: 0,
          failed: [
            { id: saved.id, model: saved.model, code: "PLUGIN_UPGRADE_INCOMPATIBLE", reason },
          ],
        });
        expect(registry.provider(saved.id)).toEqual(saved);
        expect(registry.binding(saved.id, saved.revision).plugin.hash).toBe(input.pluginHash);
      };
      await registry.draft(
        `${source}\nmodule.exports.meta.version='2.0.0';module.exports.meta.endpoints={image:module.exports.meta.endpoints.text};`,
        "builtin",
      );
      check("2.0.0", "协议 openai@2.0.0 不支持 text 类型的模型");
      await registry.draft(
        `${source}\nmodule.exports.meta.version='3.0.0';module.exports.meta.auth={type:'header',name:'X-Sample'};`,
        "builtin",
      );
      check("3.0.0", "目标版本的鉴权方式或凭证位置已改变，不能沿用旧版本的凭证授权。");
    });
  });
  it("手动改绑与批量升级共用凭证继承边界，批准只对实际目标哈希有效", async () => {
    await withRegistry(async ({ registry, input }) => {
      const channel = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "fixture-credential",
        fields: {
          name: "授权对照",
          endpoint: input.fields.endpoint,
          allowLocal: true,
          enabled: true,
          sort: 1,
          headers: [],
        },
      });
      const source = registry.agentPlugin("openai").code;
      const release = (version: string, auth: object) =>
        registry.draft(
          source +
            `\nObject.assign(module.exports.meta,{key:'auth-parity',version:'${version}',auth:${JSON.stringify(auth)}});`,
        );
      const first = await release("1.0.0", { type: "bearer" });
      const fields = {
        channelId: channel.id,
        channelRevision: channel.revision,
        enabled: true,
        upstreamModel: "sample",
        config: { kind: "text" as const, name: "授权模型", description: "", sort: 0 },
        settings: {},
      };
      const saved = registry.modelSave({ ...fields, expectedRevision: 0, pluginHash: first.hash });
      const compatible = await release("2.0.0", { type: "bearer" });
      const upgrade = () => registry.pluginUpgradeAll({ key: first.key, approve: true });
      expect(upgrade()).toEqual({ toVersion: "2.0.0", upgraded: 1, failed: [] });
      let current = registry.provider(saved.id);
      expect(current).toMatchObject({
        pluginHash: compatible.hash,
        revision: saved.revision + 1,
        hasSecret: true,
      });
      for (const [version, auth] of [
        ["3.0.0", { type: "header", name: "X-First" }],
        ["4.0.0", { type: "header", name: "X-Second" }],
        ["5.0.0", { type: "custom" }],
        ["6.0.0", { type: "custom" }],
      ] as const) {
        const target = await release(version, auth);
        for (let attempt = 0; attempt < 2; attempt++)
          expect(upgrade()).toMatchObject({
            upgraded: 0,
            failed: [{ id: saved.id, code: "PLUGIN_UPGRADE_INCOMPATIBLE" }],
          });
        const body = registry.agentModel(saved.id).body;
        const documentText = JSON.stringify({
          ...body,
          channels: [{ ...body.channels[0], protocol: { ...body.channels[0]!.protocol, version } }],
        });
        const change = {
          ...fields,
          id: saved.id,
          expectedRevision: current.revision,
          pluginHash: current.pluginHash,
          documentText,
        };
        expect(() => registry.modelSave({ ...change, approve: true })).toThrow(
          "MODEL_AUTH_APPROVAL_REQUIRED",
        );
        expect(() =>
          registry.modelSave({ ...change, approvedAuthHash: current.pluginHash }),
        ).toThrow("MODEL_AUTH_APPROVAL_REQUIRED");
        expect(registry.provider(saved.id)).toEqual(current);
        current = registry.modelSave({ ...change, approvedAuthHash: target.hash });
        expect(current).toMatchObject({
          revision: change.expectedRevision + 1,
          pluginHash: target.hash,
          hasSecret: true,
        });
        expect(registry.binding(saved.id, current.revision).secret).toBe("fixture-credential");
      }
    });
  });
  it("离线渠道模型可保留跨类型升级草稿；同批在线模型不变，修复前不能上线或试跑", async () => {
    await withRegistry(async ({ registry, input }) => {
      const source = registry.agentPlugin("openai").code;
      const channel = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "fixture-key",
        fields: {
          name: "升级",
          endpoint: input.fields.endpoint,
          allowLocal: true,
          enabled: true,
          sort: 1,
          headers: [],
        },
      });
      const draft = {
        channelId: channel.id,
        channelRevision: channel.revision,
        expectedRevision: 0,
        pluginHash: input.pluginHash,
        config: { kind: "text" as const, name: "文本", description: "", sort: 0 },
        settings: {},
      };
      const offline = registry.modelSave({ ...draft, upstreamModel: "offline", enabled: false });
      const online = registry.modelSave({ ...draft, upstreamModel: "online", enabled: true });
      const release = await registry.draft(
        source +
          "\nmodule.exports.meta.version='2.0.0';module.exports.meta.endpoints={image:module.exports.meta.endpoints.text};",
        "builtin",
      );
      const run = () => registry.pluginUpgradeAll({ key: "openai", approve: true });
      const failed = [
        {
          id: online.id,
          model: "online",
          code: "PLUGIN_UPGRADE_INCOMPATIBLE",
          reason: "协议 openai@2.0.0 不支持 text 类型的模型",
        },
      ];
      expect(run()).toEqual({ toVersion: "2.0.0", upgraded: 1, failed });
      expect(run()).toEqual({ toVersion: "2.0.0", upgraded: 0, failed });
      expect(registry.provider(online.id)).toEqual(online);
      const saved = registry.provider(offline.id);
      expect(saved).toMatchObject({
        pluginHash: release.hash,
        config: offline.config,
        enabled: false,
        revision: offline.revision + 1,
      });
      expect(channelModelHealth(saved, channel, release)).toMatchObject({
        status: "offline",
        reason: expect.stringContaining("不支持text"),
      });
      expect(() =>
        registry.modelToggle({ id: saved.id, expectedRevision: saved.revision, enabled: true }),
      ).toThrow("PLUGIN_UPGRADE_INCOMPATIBLE");
      expect(() => registry.trialBinding(saved.id, saved.revision)).toThrow(
        "PLUGIN_UPGRADE_INCOMPATIBLE",
      );
      expect(registry.provider(saved.id)).toEqual(saved);
      const fixed = registry.modelSave({
        ...draft,
        id: saved.id,
        expectedRevision: saved.revision,
        upstreamModel: "offline",
        enabled: true,
      });
      expect(registry.trialBinding(fixed.id, fixed.revision).plugin.hash).toBe(input.pluginHash);
    });
  });
  it("协议升级逐字段报告配置错误，不泄漏输入，不改动失败模型", async () => {
    await withRegistry(async ({ registry, input }) => {
      const source = registry.agentPlugin("openai").code;
      const initial = registry.save(input);
      await registry.draft(
        `${source}\nmodule.exports.meta.version='2.0.0';module.exports.meta.channelSettings={pathPrefix:{type:'number',label:'数值'},api:{type:'enum',label:'选项',options:['first','second']},extra:{type:'string',label:'新增',required:true}};`,
        "builtin",
      );
      const result = registry.pluginUpgradeAll({ key: "openai", approve: true });
      expect(result.failed).toEqual([
        {
          id: initial.id,
          model: initial.model,
          code: "PROVIDER_CONFIG_INVALID",
          reason:
            "新版本的协议设置不合法：pathPrefix：应为数字；api：必须是 first / second 之一；extra：必填",
        },
      ]);
      expect(registry.provider(initial.id)).toEqual(initial);
    });
  });
  it("列表故障原因和主进程上线检查按渠道、协议和 Key 判定；拒绝写入不修改模型版本", async () => {
    await withRegistry(async ({ registry, input }) => {
      const fields = {
        name: "校验渠道",
        endpoint: input.fields.endpoint,
        allowLocal: true,
        sort: 10,
        enabled: true,
        headers: [],
      };
      let channel = registry.channelSave({ fields, approve: true, expectedRevision: 0 });
      const draft = {
        expectedRevision: 0,
        channelId: channel.id,
        channelRevision: channel.revision,
        upstreamModel: "model",
        pluginHash: input.pluginHash,
        config: { kind: "text" as const, name: "文本模型", description: "", sort: 100 },
        enabled: false,
        settings: {},
      };
      const model = registry.modelSave(draft);
      const plugin = () => registry.list().plugins.find((entry) => entry.hash === input.pluginHash);
      const rejectEnable = (code: string, reason: string) => {
        const offline = registry.provider(model.id);
        expect(channelModelHealth(offline, channel, plugin())).toMatchObject({
          status: "offline",
          reason,
        });
        expect(channelModelHealth({ ...offline, enabled: true }, channel, plugin())).toMatchObject({
          status: "broken",
          reason,
        });
        const error = expect.objectContaining({ code });
        expect(() =>
          registry.modelToggle({ id: model.id, expectedRevision: offline.revision, enabled: true }),
        ).toThrowError(error);
        expect(() =>
          registry.modelSave({
            ...draft,
            id: model.id,
            expectedRevision: offline.revision,
            channelRevision: channel.revision,
            enabled: true,
          }),
        ).toThrowError(error);
        expect(registry.provider(model.id)).toEqual(offline);
      };
      rejectEnable("PROVIDER_SECRET_MISSING", "渠道「校验渠道」还没有设置 Key");
      registry.pluginToggle({ hash: input.pluginHash, enabled: false });
      rejectEnable("PLUGIN_DISABLED", `协议插件「${plugin()?.name}」已停用`);
      channel = registry.channelSave({
        id: channel.id,
        approve: false,
        fields: { ...fields, enabled: false },
        expectedRevision: channel.revision,
      });
      rejectEnable("PROVIDER_DISABLED", "渠道「校验渠道」已停用");
      channel = registry.channelSave({
        id: channel.id,
        approve: false,
        fields,
        secret: "fixture-key",
        expectedRevision: channel.revision,
      });
      registry.pluginToggle({ hash: input.pluginHash, enabled: true });
      const online = registry.modelToggle({
        id: model.id,
        expectedRevision: registry.provider(model.id).revision,
        enabled: true,
      });
      expect(channelModelHealth(online, channel, plugin())).toMatchObject({
        status: "online",
        reason: "",
      });
      registry.pluginToggle({ hash: input.pluginHash, enabled: false });
      expect(
        registry.modelToggle({ id: model.id, expectedRevision: online.revision, enabled: false })
          .enabled,
      ).toBe(false);
    });
  });
  it("待定价模型可试跑，不能用上线或在线保存绕过确认售价", async () => {
    await withRegistry(async ({ registry, input }) => {
      const channel = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "test-key",
        fields: {
          name: "草稿渠道",
          endpoint: input.fields.endpoint,
          allowLocal: true,
          sort: 10,
          enabled: true,
          headers: [],
        },
      });
      const config = {
        kind: "text" as const,
        name: "待定价文本",
        description: "",
        sort: 100,
        promptLimit: 2000,
        contextWindow: 32768,
        maxOutputTokens: 2048,
        pricing: { pending: true, unit: "token" as const, input: 0 },
      };
      const fields = {
        config,
        channelId: channel.id,
        channelRevision: channel.revision,
        expectedRevision: 0,
        upstreamModel: "pending-price",
        pluginHash: input.pluginHash,
        settings: {},
        enabled: false,
      };
      const draft = registry.modelSave(fields);
      const persisted = { ...fields, id: draft.id, expectedRevision: draft.revision };
      expect(registry.trialBinding(draft.id, draft.revision).profile.config?.pricing).toEqual(
        config.pricing,
      );
      expect(() =>
        registry.modelToggle({ id: draft.id, expectedRevision: draft.revision, enabled: true }),
      ).toThrow("MODEL_PRICING_PENDING");
      expect(() => registry.modelSave({ ...persisted, enabled: true })).toThrow(
        "MODEL_PRICING_PENDING",
      );
      expect(() =>
        registry.modelSave({
          ...persisted,
          config: { ...config, pricing: { ...config.pricing, input: 1 } },
        }),
      ).toThrow("MODEL_PRICING_INVALID");
      const live = registry.modelSave({
        ...persisted,
        enabled: true,
        config: { ...config, pricing: { unit: "token", input: 3, output: 15 } },
      });
      expect(live.enabled).toBe(true);
      expect(await registry.agentQuote({ key: live.id, input: { prompt: "报价" } })).toMatchObject({
        billing: "token",
        quote_credits: 1,
        count: 1,
        input: { prompt: "报价" },
      });
    });
  });
  it("批量换能力保留离线旧价格并返回问题，在线保存原子拒绝，修价后可上线", async () => {
    await withRegistry(async ({ registry, input }) => {
      const channel = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "fixture-key",
        fields: {
          name: "批改",
          endpoint: input.fields.endpoint,
          allowLocal: true,
          enabled: true,
          sort: 1,
          headers: [],
        },
      });
      const config = {
        kind: "text" as const,
        name: "原模型",
        description: "",
        sort: 1,
        pricing: { unit: "token" as const, input: 2, output: 8 },
      };
      const original = {
        channelId: channel.id,
        channelRevision: channel.revision,
        expectedRevision: 0,
        upstreamModel: "fixture",
        pluginHash: input.pluginHash,
        config,
        enabled: true,
        settings: {},
      };
      const live = registry.modelSave(original);
      const plugin = registry.list().plugins.find((entry) => entry.key === "openai-image")!;
      const change = {
        ...original,
        id: live.id,
        expectedRevision: live.revision,
        pluginHash: plugin.hash,
        config: { ...config, kind: "image" as const },
      };
      expect(() => registry.modelSave(change)).toThrow("MODEL_PRICING_INVALID");
      expect(registry.provider(live.id)).toEqual(live);
      const offline = registry.modelToggle({
        id: live.id,
        expectedRevision: live.revision,
        enabled: false,
      });
      const saved = registry.modelSave({
        ...change,
        expectedRevision: offline.revision,
        enabled: false,
      });
      expect(saved).toMatchObject({
        enabled: false,
        config: change.config,
        issues: [{ field: "pricing", text: "只有文本、Agent 模型按 Token 计费" }],
      });
      const stored = registry.provider(live.id);
      expect(stored).not.toHaveProperty("issues");
      expect(channelModelHealth(stored, channel, plugin)).toMatchObject({
        status: "offline",
        reason: "只有文本、Agent 模型按 Token 计费",
      });
      expect(() =>
        registry.modelToggle({ id: live.id, expectedRevision: stored.revision, enabled: true }),
      ).toThrow("MODEL_PRICING_INVALID");
      expect(() => registry.trialBinding(stored.id, stored.revision)).toThrow(
        "MODEL_PRICING_INVALID",
      );
      const fixed = registry.modelSave({
        ...change,
        expectedRevision: stored.revision,
        config: { ...change.config, pricing: { unit: "request", input: 4 } },
      });
      expect(fixed.enabled).toBe(true);
      expect(fixed).not.toHaveProperty("issues");
    });
  });
  it("Agent 插件可登记并持久化，但不能给普通模型或旧式连接发送请求", async () => {
    await withRegistry(async ({ registry, input, directory }) => {
      const source = `module.exports={meta:{apiVersion:1,key:'agent-fixture',name:'Agent fixture',auth:{type:'none'},endpoints:{agent:{mode:'sync'}}},buildSubmitRequest(){},parseSubmitResponse(){}}`;
      const { plugin } = await registry.pluginUpload(source);
      expect(plugin).toMatchObject({ key: "agent-fixture", kind: "agent", origin: "manual" });
      const reopened = await SettingsRegistry.open(
        directory,
        "resources/provider-plugins",
        "out/provider-runtime/runner",
        {
          encrypt: (value) => Buffer.from(value).reverse(),
          decrypt: (value) => Buffer.from(value).reverse().toString(),
        },
      );
      try {
        expect(reopened.list().plugins.find((entry) => entry.hash === plugin.hash)).toMatchObject({
          kind: "agent",
          mode: "sync",
        });
        expect(() => reopened.save({ ...input, pluginHash: plugin.hash })).toThrow(
          "AGENT_MODEL_INCOMPATIBLE",
        );
        expect(() =>
          reopened.catalogDraft({
            pluginHash: plugin.hash,
            endpoint: input.fields.endpoint,
            allowLocal: true,
            channel: {},
            approve: true,
          }),
        ).toThrow("AGENT_MODEL_INCOMPATIBLE");
        const channel = reopened.channelSave({
          expectedRevision: 0,
          approve: true,
          secret: "test-key",
          fields: {
            name: "网关",
            endpoint: input.fields.endpoint,
            allowLocal: true,
            enabled: true,
            headers: [],
            sort: 0,
          },
        });
        const draft = {
          channelId: channel.id,
          channelRevision: channel.revision,
          expectedRevision: 0,
          upstreamModel: "fixture",
          settings: {},
          config: { kind: "text" as const, name: "测试", sort: 0, description: "" },
          enabled: true,
        };
        expect(() => reopened.modelSave({ ...draft, pluginHash: plugin.hash })).toThrow(
          "PROVIDER_CONFIG_INVALID",
        );
        const model = reopened.modelSave({ ...draft, config: { ...draft.config, kind: "agent" } });
        expect(model.pluginHash).toBe("");
        expect(reopened.agentBinding(model.id, model.revision)).toMatchObject({
          origin: "gateway",
          plugin: undefined,
        });
      } finally {
        reopened.close();
      }
    });
  });
  it("目录限定字节和条数，普通插件请求仍限 1 MiB", async () => {
    const document = JSON.stringify({
      data: [{ id: " sample " }, { id: "\nnot-an-id" }, { id: "sample" }],
    });
    let body = document.padEnd(4 * 1024 * 1024);
    const server = createServer((_request, response) => response.end(body));
    server.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw Error("未监听");
      const endpoint = `http://127.0.0.1:${address.port}`;
      const fields = {
        endpoint,
        allowLocal: true,
        label: "目录",
        model: "sample",
        agentEnabled: false,
        channel: {},
      };
      const catalog = () => fetchModelCatalog(fields, { auth: { type: "bearer" } });
      await expect(catalog()).resolves.toEqual({ models: ["sample"] });
      await expect(
        providerTransport(
          endpoint,
          true,
        )({ method: "GET", url: endpoint, headers: {}, timeoutMs: 3000, responseType: "json" }),
      ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_LIMIT" });
      body += " ";
      await expect(catalog()).rejects.toMatchObject({ code: "PROVIDER_CATALOG_TOO_LARGE" });
      const data = Array.from({ length: 2000 }, (_, index) => ({ id: `model-${index}` }));
      body = JSON.stringify({ data });
      expect((await catalog()).models).toHaveLength(2000);
      body = JSON.stringify({ data: [...data, data[0]] });
      await expect(catalog()).rejects.toMatchObject({ code: "PROVIDER_CATALOG_TOO_LARGE" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("上下文只读识别：重复保留首条、无效或无权限用快照、迟到结果不跨渠道修订", async () => {
    await withRegistry(async ({ registry }) => {
      let status = 200,
        hits = 0,
        hold = false;
      let data = [
        { id: "z-first", context_length: 1000, max_output_tokens: 512 },
        { id: " gpt-4o ", context_length: 300000, max_output_tokens: 50000 },
        { id: "gpt-4o", context_length: 400000, max_output_tokens: 60000 },
      ];
      const server = createServer((request, response) => {
        hits++;
        if (
          request.url !== "/v4/models" ||
          request.headers.authorization !== "Bearer fixture-secret" ||
          request.headers["x-fixture"] !== "private-header"
        )
          return response.writeHead(401).end();
        if (!hold)
          response.writeHead(status).end(JSON.stringify({ data, private: "private-header" }));
      });
      server.listen(0, "127.0.0.1");
      try {
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw Error("未监听");
        const fields = {
          name: "模型目录",
          endpoint: `http://127.0.0.1:${address.port}/v4`,
          allowLocal: true,
          enabled: true,
          sort: 0,
          headers: [{ name: "x-fixture", value: "private-header" }],
        };
        let channel = registry.channelSave({
          fields,
          expectedRevision: 0,
          approve: true,
          secret: "fixture-secret",
        });
        const ref = () => ({ id: channel.id, expectedRevision: channel.revision });
        const lookup = () => registry.modelLimits({ ...ref(), name: "gpt-4o" });
        const local = {
          found: true,
          source: "builtin",
          window: 128000,
          output: 16384,
          vision: true,
          video: false,
        };
        await expect(registry.channelCatalog(ref())).resolves.toEqual({
          models: [
            { id: "z-first", exists: false },
            { id: "gpt-4o", exists: false },
          ],
        });
        await expect(lookup()).resolves.toEqual({
          ...local,
          source: "upstream",
          window: 300000,
          output: 50000,
        });
        data = [{ id: "gpt-4o", context_length: 1000, max_output_tokens: 1000 }];
        await expect(lookup()).resolves.toEqual(local);
        status = 404;
        await expect(lookup()).resolves.toEqual(local);
        hold = true;
        const incoming = once(server, "request");
        const waiting = lookup();
        const [, response] = await incoming;
        channel = registry.channelKeys({ ...ref(), clearSecret: true });
        response.end(JSON.stringify({ data }));
        await expect(waiting).rejects.toMatchObject({ code: "SETTINGS_REVISION_CONFLICT" });
        await expect(lookup()).resolves.toEqual(local);
        channel = registry.channelSave({
          ...ref(),
          fields: { ...fields, enabled: false },
          approve: true,
          secret: "fixture-secret",
        });
        await expect(lookup()).resolves.toEqual(local);
        expect(hits).toBe(5);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
  it("模型目录与插件宿主使用相同的鉴权字段规则", async () => {
    const fields = {
      endpoint: "https://example.invalid",
      allowLocal: false,
      label: "示例",
      model: "sample",
      agentEnabled: false,
      channel: {},
    };
    const transport = vi.fn(
      async (_request: import("../../packages/provider-runtime/src/host").HostRequest) => ({
        status: 200,
        body: { data: [{ id: "sample" }] },
        text: "",
        headers: {},
      }),
    );
    for (const [type, name] of [
      ["header", "X.Api+Key"],
      ["query", "访问 & key"],
      ["query", "cookie"],
    ] as const) {
      await expect(
        fetchModelCatalog(fields, { auth: { type, name } }, "fixture-key", transport),
      ).resolves.toEqual({ models: ["sample"] });
      const [request] = transport.mock.calls.at(-1)!;
      if (type === "header") expect(request.headers[name]).toBe("fixture-key");
      else expect([...new URL(request.url).searchParams]).toEqual([[name, "fixture-key"]]);
    }
    await expect(
      fetchModelCatalog(
        fields,
        { auth: { type: "header", name: "Connection" } },
        "fixture-key",
        transport,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_CONFIG_INVALID" });
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it("独立 Agent 无需 OpenAI 插件，迁移旧固定版本不改在途任务或旧式连接", async () => {
    await withRegistry(async ({ registry, input, directory }) => {
      const legacy = registry.save(input);
      const fields = {
        name: "网关",
        endpoint: input.fields.endpoint,
        allowLocal: true,
        enabled: true,
        sort: 100,
        headers: [],
      };
      let channel = registry.channelSave({ fields, expectedRevision: 0, approve: true });
      const draft = {
        channelId: channel.id,
        channelRevision: channel.revision,
        expectedRevision: 0,
        upstreamModel: "fixture-gateway",
        settings: { api: "gemini" },
        config: { kind: "agent" as const, name: "网关助手", sort: 100, description: "" },
        enabled: false,
      };
      registry.pluginToggle({ hash: input.pluginHash, enabled: false });
      const offline = registry.modelSave(draft);
      expect(offline.pluginHash).toBe("");
      expect(channelModelHealth(offline, channel)).toEqual({
        status: "offline",
        label: "未上线",
        reason: "渠道「网关」还没有设置 Key",
      });
      const toggle = () =>
        registry.modelToggle({
          id: offline.id,
          expectedRevision: registry.provider(offline.id).revision,
          enabled: true,
        });
      expect(toggle).toThrow("PROVIDER_SECRET_MISSING");
      channel = registry.channelSave({
        id: channel.id,
        expectedRevision: channel.revision,
        approve: false,
        secret: "new-key",
        fields: { ...fields, enabled: false },
      });
      expect(toggle).toThrow("PROVIDER_DISABLED");
      channel = registry.channelSave({
        id: channel.id,
        expectedRevision: channel.revision,
        approve: false,
        fields,
      });
      const online = toggle();
      expect(channelModelHealth(online, channel)).toEqual({
        status: "online",
        label: "在线",
        reason: "",
      });
      expect(registry.agentBinding(online.id, online.revision)).toMatchObject({
        origin: "gateway",
        secret: "new-key",
        plugin: undefined,
      });
      expect(() => registry.trialBinding(online.id, online.revision)).toThrow(
        "AGENT_MODEL_INCOMPATIBLE",
      );
      expect(() => registry.agentBinding(legacy.id, legacy.revision)).toThrow("PLUGIN_DISABLED");
      expect(() =>
        registry.modelSave({
          ...draft,
          channelRevision: channel.revision,
          pluginHash: input.pluginHash,
        }),
      ).toThrow("PROVIDER_CONFIG_INVALID");
      expect(() =>
        registry.modelSave({
          ...draft,
          channelRevision: channel.revision,
          settings: { pathPrefix: "../bad" },
        }),
      ).toThrow("PROVIDER_CONFIG_INVALID");
      const db = new DatabaseSync(join(directory, "settings.sqlite"));
      try {
        db.prepare(
          "UPDATE provider_profiles SET profile=json_set(profile,'$.pluginHash',?) WHERE id=?",
        ).run(input.pluginHash, online.id);
      } finally {
        db.close();
      }
      registry.rememberJobBinding("old-project", "old-job", registry.provider(online.id));
      const reopened = await SettingsRegistry.open(
        directory,
        "resources/provider-plugins",
        "out/provider-runtime/runner",
        {
          encrypt: (value) => Buffer.from(value).reverse(),
          decrypt: (value) => Buffer.from(value).reverse().toString(),
        },
      );
      try {
        expect(reopened.provider(legacy.id).pluginHash).toBe(input.pluginHash);
        expect(reopened.provider(online.id)).toMatchObject({
          pluginHash: "",
          revision: online.revision,
        });
        expect(
          reopened.queryBinding(online.id, online.revision, input.pluginHash, {
            project: "old-project",
            id: "old-job",
          }).plugin.hash,
        ).toBe(input.pluginHash);
      } finally {
        reopened.close();
      }
    });
  });
  it("创建双凭证渠道并迁移模型，冲突回滚，迁移后仅使用目标渠道凭证", async () => {
    await withRegistry(async ({ registry, input, failEncryption }) => {
      const fields = {
        name: "来源",
        endpoint: input.fields.endpoint,
        allowLocal: true,
        enabled: true,
        sort: 0,
        headers: [],
      };
      const source = registry.channelSave({
        fields,
        approve: true,
        expectedRevision: 0,
        secret: "source-token",
        secretKey: "secondary-token",
      });
      const target = registry.channelSave({
        fields: { ...fields, name: "目标" },
        approve: true,
        expectedRevision: 0,
        secret: "target-token",
      });
      expect(source).toMatchObject({ hasSecret: true, hasSecretKey: true });
      const model = registry.modelSave({
        channelId: source.id,
        channelRevision: source.revision,
        expectedRevision: 0,
        config: { kind: "text", name: "测试", description: "", sort: 0 },
        upstreamModel: "example",
        pluginHash: input.pluginHash,
        settings: {},
        enabled: true,
      });
      const remove = {
        id: source.id,
        expectedRevision: source.revision,
        migration: {
          targetId: target.id,
          targetRevision: target.revision,
          models: [{ id: model.id, expectedRevision: model.revision }],
        },
      };
      expect(() =>
        registry.channelRemove({ ...remove, migration: { ...remove.migration, models: [] } }),
      ).toThrowError(expect.objectContaining({ code: "SETTINGS_REVISION_CONFLICT" }));
      expect(registry.binding(model.id, model.revision).secret).toBe("source-token");
      const config = { kind: "text", name: "批量迁移", description: "", sort: 1 } as const;
      const base = {
        expectedRevision: 0,
        upstreamModel: "batch",
        config,
        pluginHash: input.pluginHash,
        settings: {},
        enabled: true,
      };
      expect(() =>
        registry.modelSave({
          ...base,
          channelId: source.id,
          channelRevision: source.revision,
          config: {
            ...config,
            pricing: {
              unit: "request",
              input: 1,
              tiers: [{ on: true, unit: 4, when: { resolution: "8K" } }],
            },
          },
        }),
      ).toThrowError(expect.objectContaining({ code: "MODEL_PRICING_INVALID" }));
      const another = registry.modelSave({
        ...base,
        channelId: source.id,
        channelRevision: source.revision,
      });
      const move = {
        ...base,
        id: another.id,
        expectedRevision: another.revision,
        channelId: target.id,
        channelRevision: target.revision,
        moveFrom: { id: source.id, revision: source.revision },
      };
      const duplicate = registry.modelSave({
        ...base,
        channelId: target.id,
        channelRevision: target.revision,
        enabled: false,
      });
      expect(() => registry.modelSave(move)).toThrowError(
        expect.objectContaining({ code: "PROVIDER_DUPLICATE_MODEL" }),
      );
      registry.modelRemove({ id: duplicate.id, expectedRevision: duplicate.revision });
      const running = { project: "project", id: "active" };
      registry.rememberJobBinding(
        running.project,
        running.id,
        registry.binding(another.id, another.revision).profile,
      );
      registry.reconcileJobPins(running.project, [
        { id: running.id, pluginHash: input.pluginHash, channelId: source.id },
      ]);
      const moved = registry.modelSave(move);
      expect(registry.binding(moved.id, moved.revision).secret).toBe("target-token");
      expect(
        registry.queryBinding(another.id, another.revision, input.pluginHash, running),
      ).toMatchObject({
        secret: "source-token",
        profile: { channelId: source.id },
      });
      expect(() =>
        registry.queryBinding(another.id, moved.revision, input.pluginHash, running),
      ).toThrow();
      registry.reconcileJobPins(running.project, [], [running.id]);
      expect(registry.channelList().find(({ id }) => id === source.id)?.activeJobs).toBe(0);
      expect(
        registry.queryBinding(another.id, another.revision, input.pluginHash, running).secret,
      ).toBe("source-token");
      registry.reconcileJobPins(running.project, []);
      expect(() =>
        registry.queryBinding(another.id, another.revision, input.pluginHash, running),
      ).toThrow();
      registry.channelRemove(remove);
      expect(registry.binding(model.id, model.revision + 1).secret).toBe("target-token");
      failEncryption();
      expect(() =>
        registry.channelSave({ fields, expectedRevision: 0, approve: true, secret: "failure" }),
      ).toThrow();
      expect(registry.channelList().map(({ id }) => id)).toEqual([target.id]);
    });
  });

  it("渠道单次可导入 500 个不同型号，501 个拒绝整批，重复导入不会新增", async () => {
    await withRegistry(async ({ registry, input }) => {
      const channel = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "导入边界",
          endpoint: input.fields.endpoint,
          allowLocal: true,
          enabled: true,
          sort: 0,
          headers: [],
        },
      });
      const version = { id: channel.id, expectedRevision: channel.revision };
      const models = Array.from({ length: 500 }, (_, index) => `model-${index}`);
      expect(() =>
        registry.modelImport({ ...version, models: [...models, "one-more"] }),
      ).toThrowError(expect.objectContaining({ code: "PROVIDER_CONFIG_INVALID" }));
      expect(registry.list().providers).toHaveLength(0);
      expect(registry.modelImport({ ...version, models: [...models, " model-0 ", " "] })).toEqual({
        added: 500,
      });
      expect(registry.modelImport({ ...version, models })).toEqual({ added: 0 });
    });
  });

  it("拉取分配全局公开 key，同名重建使用新内部身份，部分写入可重试", async () => {
    await withRegistry(async ({ registry, input, directory }) => {
      const fields = {
        name: "渠道",
        endpoint: input.fields.endpoint,
        allowLocal: true,
        enabled: true,
        sort: 0,
        headers: [],
      };
      const first = registry.channelSave({ expectedRevision: 0, approve: true, fields });
      const second = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: { ...fields, name: "第二个渠道" },
      });
      const pull = (channel: typeof first, models: string[]) =>
        registry.modelImport({ id: channel.id, expectedRevision: channel.revision, models });
      const upstream = "_/厂商/acme.X_";
      expect(pull(first, [upstream, "中文", "A".repeat(99)])).toEqual({ added: 3 });
      const models = registry.list().providers;
      expect(models.map((model) => model.modelKey)).toEqual(["acme.X", "model", "A".repeat(80)]);
      const original = models[0]!;
      const body = registry.agentModel("acme.X").body;
      expect(body).toMatchObject({
        key: "acme.X",
        channels: [{ channel: first.id, upstream_model: upstream }],
      });
      expect(pull(second, [upstream, "acme.X!"])).toEqual({ added: 2, prefixed: 2 });
      expect(registry.agentModelList({ channel: second.id }).map((model) => model.key)).toEqual([
        `${second.id}-acme.X`,
        `${second.id}-acme.X-2`,
      ]);
      expect(pull(first, [original.id])).toEqual({ added: 1, prefixed: 1 });
      const save = {
        expectedRevision: 0,
        channelRevision: first.revision,
        channelId: first.id,
        enabled: false,
        config: { kind: "text" as const, name: "正文", description: "", sort: 100 },
        settings: {},
        upstreamModel: "custom",
        pluginHash: input.pluginHash,
      };
      const document = {
        key: "acme.X",
        kind: "text",
        label: "正文",
        sort: 100,
        channels: [{ channel: first.id, upstream_model: "custom", protocol: { plugin: "openai" } }],
      };
      expect(() => registry.modelSave({ ...save, documentText: JSON.stringify(document) })).toThrow(
        "MODEL_DOCUMENT_INVALID",
      );
      registry.modelRemove({ id: original.id, expectedRevision: original.revision });
      const replacement = registry.modelSave({ ...save, documentText: JSON.stringify(document) });
      expect(replacement.id).not.toBe(original.id);
      expect(() =>
        registry.modelToggle({ id: original.id, expectedRevision: 1, enabled: false }),
      ).toThrow("SETTINGS_REVISION_CONFLICT");
      expect(registry.agentModel("acme.X")).toEqual(registry.agentModel(replacement.id));
      expect(registry.pluginPinnedModels({ key: "openai" })).toMatchObject([
        { id: replacement.id, modelKey: "acme.X", name: "正文" },
      ]);
      expect(registry.pluginDeleteCheck({ key: "openai" }).models).toMatchObject([
        { id: replacement.id, modelKey: "acme.X" },
      ]);
      registry.recordRequestError("previous-id", original.id, first.id, Date.now(), "TIMEOUT");
      registry.recordRequestError(
        "replacement-id",
        replacement.id,
        first.id,
        Date.now(),
        "TIMEOUT",
      );
      expect(registry.agentRecentErrors({ model_key: "acme.X" }).items).toMatchObject([
        { model_key: "acme.X", task_id: "replacement-id" },
      ]);
      expect(await registry.agentQuote({ key: "acme.X" })).toEqual(
        await registry.agentQuote({ key: replacement.id }),
      );
      const db = new DatabaseSync(join(directory, "settings.sqlite"));
      try {
        db.exec(
          "CREATE TRIGGER interrupt_pull BEFORE INSERT ON provider_profiles WHEN json_extract(NEW.profile,'$.model')='interrupted' BEGIN SELECT RAISE(ABORT,'fixture interruption'); END",
        );
        expect(() =>
          pull(first, ["before-interruption", "interrupted", "after-interruption"]),
        ).toThrow("fixture interruption");
        expect(registry.agentModelList({ q: "interruption" }).map((model) => model.key)).toEqual([
          "before-interruption",
        ]);
        db.exec("DROP TRIGGER interrupt_pull");
        expect(pull(first, ["before-interruption", "interrupted", "after-interruption"])).toEqual({
          added: 2,
        });
      } finally {
        db.close();
      }
    });
  });

  it("待配置模型可保存时限，过期版本不覆盖，未选能力不能上线", async () => {
    await withRegistry(async ({ registry, input }) => {
      const channel = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "草稿",
          endpoint: input.fields.endpoint,
          allowLocal: true,
          enabled: true,
          sort: 0,
          headers: [],
        },
      });
      registry.modelImport({
        id: channel.id,
        expectedRevision: channel.revision,
        models: ["长".repeat(129)],
      });
      const [model] = registry.list().providers;
      if (!model) throw Error("缺少待配置模型");
      const change = {
        id: model.id,
        expectedRevision: model.revision,
        sourceId: channel.id,
        sourceRevision: channel.revision,
        deadline: 345,
      };
      expect(registry.modelPendingEdit(change).issues.map((issue) => issue.path)).toEqual([
        "kind",
        "channels[0].upstream_model",
        "capabilities.prompt.max_length",
        "pricing.billing",
      ]);
      expect(() => registry.modelPendingEdit({ ...change, deadline: 123 })).toThrowError(
        expect.objectContaining({ code: "SETTINGS_REVISION_CONFLICT" }),
      );
      expect(registry.provider(model.id)).toMatchObject({
        pending: true,
        pendingDeadlineSeconds: 345,
        revision: model.revision + 1,
        enabled: false,
      });
      expect(() =>
        registry.modelToggle({ id: model.id, expectedRevision: model.revision + 1, enabled: true }),
      ).toThrowError(expect.objectContaining({ code: "MODEL_PENDING" }));
    });
  });

  it("渠道模型排序校验完整列表，遇到过期修订时回滚全部修改", async () => {
    await withRegistry(async ({ registry, input }) => {
      const channel = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "排序测试渠道",
          endpoint: input.fields.endpoint,
          allowLocal: true,
          enabled: true,
          sort: 0,
          headers: [],
        },
      });
      registry.modelImport({
        id: channel.id,
        expectedRevision: channel.revision,
        models: ["one", "two"],
      });
      const [first, second] = registry.list().providers;
      if (!first || !second) throw new Error("缺少测试模型");
      expect([first.pendingSort, second.pendingSort]).toEqual([10, 20]);
      const configured = registry.modelSave({
        id: first.id,
        expectedRevision: first.revision,
        channelId: channel.id,
        channelRevision: channel.revision,
        pluginHash: input.pluginHash,
        upstreamModel: first.model,
        enabled: false,
        settings: {},
        config: { kind: "text", name: "文本模型", description: "", sort: 999 },
      });
      expect(configured.config?.sort).toBe(10);
      const pendingEntry = { id: second.id, expectedRevision: second.revision };
      const order = [pendingEntry, { id: configured.id, expectedRevision: configured.revision }];
      const reorder = { channelId: channel.id, channelRevision: channel.revision, order };
      const original = registry.list().providers;
      const conflict = expect.objectContaining({ code: "SETTINGS_REVISION_CONFLICT" });
      expect(() =>
        registry.modelReorder({ ...reorder, order: [pendingEntry, pendingEntry] }),
      ).toThrowError(conflict);
      expect(() =>
        registry.modelReorder({
          ...reorder,
          order: [pendingEntry, { id: configured.id, expectedRevision: first.revision }],
        }),
      ).toThrowError(conflict);
      expect(registry.list().providers).toEqual(original);
      expect(registry.modelReorder(reorder)).toEqual({ saved: true });
      expect(registry.provider(second.id)).toMatchObject({
        pending: true,
        pendingSort: 10,
        revision: second.revision + 1,
      });
      expect(registry.provider(configured.id)).toMatchObject({
        config: { sort: 20 },
        revision: configured.revision + 1,
      });
      const sorted = registry.list().providers;
      registry.modelReorder({
        ...reorder,
        order: order.map((entry) => ({ ...entry, expectedRevision: entry.expectedRevision + 1 })),
      });
      expect(registry.list().providers).toEqual(sorted);
    });
  });

  it("Vertex 模型只在凭证请求地址变化时要求确认", async () => {
    await withRegistry(async ({ registry }) => {
      const vertex = registry.list().plugins.find(({ key }) => key === "vertex-ai");
      if (!vertex) throw new Error("缺少 Vertex 适配器");
      const channel = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "Vertex 测试渠道",
          endpoint: "https://us-central1-aiplatform.googleapis.com",
          allowLocal: false,
          enabled: true,
          sort: 0,
          headers: [],
        },
      });
      const save: SettingsInput<"modelSave"> = {
        channelId: channel.id,
        channelRevision: channel.revision,
        expectedRevision: 0,
        upstreamModel: "veo-3.0-generate-001",
        pluginHash: vertex.hash,
        enabled: false,
        config: { kind: "video", name: "Veo", description: "", sort: 100 },
        settings: {},
      };
      const model = registry.modelSave(save);
      const changeAddress = {
        ...save,
        id: model.id,
        expectedRevision: model.revision,
        settings: { tokenUrl: "https://vertex-proxy.example/token" },
      };
      expect(() => registry.modelSave(changeAddress)).toThrowError(
        expect.objectContaining({ code: "MODEL_ENDPOINT_APPROVAL_REQUIRED" }),
      );
      expect(registry.provider(model.id)).toEqual(model);
      const updated = registry.modelSave({ ...changeAddress, approve: true });
      expect(updated.channel).toMatchObject(changeAddress.settings);
      expect(
        registry.modelSave({
          ...changeAddress,
          expectedRevision: updated.revision,
          config: { ...save.config, name: "Veo (更新名称)" },
        }).config?.name,
      ).toBe("Veo (更新名称)");
    });
  });

  it("仅在自定义鉴权连接保存第二凭证，供共享模型使用并随连接变更失效", async () => {
    await withRegistry(async ({ registry, input }) => {
      const plugin = registry.list().plugins.find(({ key }) => key === "kling");
      if (!plugin) throw new Error("Missing Kling adapter");
      const secretKey = "fixture-secondary-key";
      expect(() => registry.save({ ...input, secretKey })).toThrowError(
        expect.objectContaining({ code: "PROVIDER_CONFIG_INVALID" }),
      );
      const fields = { ...input.fields, agentEnabled: false, channel: {} };
      const profile = registry.save({ ...input, pluginHash: plugin.hash, fields, secretKey });
      registry.addModels({
        id: profile.id,
        expectedRevision: profile.revision,
        models: ["second-model"],
        agentEnabled: false,
      });
      const child = registry
        .list()
        .providers.find(({ connectionId }) => connectionId === profile.id);
      if (!child) throw new Error("Missing shared model");
      expect(child.hasSecretKey).toBe(true);
      expect(registry.binding(child.id, child.revision).secretKey).toBe(secretKey);
      expect(JSON.stringify(registry.list())).not.toContain(secretKey);
      expect(registry.redact(secretKey)).toBe("[凭证已移除]");
      const update = {
        ...input,
        pluginHash: plugin.hash,
        fields,
        id: profile.id,
        secret: undefined,
      };
      const cleared = registry.save({
        ...update,
        expectedRevision: profile.revision,
        clearSecretKey: true,
      });
      expect(cleared).toMatchObject({ hasSecret: true, hasSecretKey: false });
      expect(registry.provider(child.id)).toMatchObject({
        revision: child.revision + 1,
        hasSecretKey: false,
      });
      const restored = registry.save({ ...update, expectedRevision: cleared.revision, secretKey });
      const moved = registry.save({
        ...update,
        expectedRevision: restored.revision,
        secret: input.secret,
        fields: { ...fields, endpoint: "http://127.0.0.1:2" },
      });
      expect(registry.binding(moved.id, moved.revision).secretKey).toBeUndefined();
      expect(registry.provider(child.id).hasSecretKey).toBe(false);
    });
  });

  it("保存 Vertex 服务账号 JSON，允许可选字段并保护已授权的令牌地址", async () => {
    await withRegistry(async ({ registry, input }) => {
      const plugin = registry.list().plugins.find(({ key }) => key === "vertex-ai");
      if (!plugin) throw new Error("Missing Vertex adapter");
      const secret = JSON.stringify(
        { client_email: "fixture@example.test", private_key: "fixture", project_id: "fixture" },
        null,
        2,
      );
      const fields = {
        ...input.fields,
        agentEnabled: false,
        channel: { storageUri: "gs://fixture/" },
      };
      const profile = registry.save({ ...input, fields, secret, pluginHash: plugin.hash });
      expect(profile.channel).toMatchObject({
        tokenUrl: "https://oauth2.googleapis.com/token",
        location: "us-central1",
      });
      expect(registry.binding(profile.id, profile.revision).secret).toBe(secret);
      expect(JSON.stringify(registry.list().providers)).not.toContain("private_key");
      expect(() =>
        registry.save({
          ...input,
          pluginHash: plugin.hash,
          id: profile.id,
          expectedRevision: profile.revision,
          approve: false,
          fields: {
            ...fields,
            channel: { ...fields.channel, tokenUrl: "https://oauth.example.test/token" },
          },
        }),
      ).toThrowError(expect.objectContaining({ code: "PLUGIN_APPROVAL_REQUIRED" }));
    });
  });

  it("分配版本号并按共享连接升级模型，拒绝不兼容配置与删除引用", async () => {
    await withRegistry(async ({ registry, input }) => {
      const plugin = await registry.draft(
        registry.agentPlugin("openai").code + "\nmodule.exports.meta.key='upgrade-fixture';",
      );
      const first = await registry.draft(`${plugin.source}\n// First revision`);
      const second = await registry.draft(`${plugin.source}\n// Second revision`);
      expect([first.version, second.version]).toEqual(["1.2.2", "1.2.3"]);
      await expect(registry.draft(first.source)).rejects.toMatchObject({
        code: "PLUGIN_VERSION_DUPLICATE",
      });
      const parent = registry.save({
        ...input,
        pluginHash: plugin.hash,
        fields: { ...input.fields, agentEnabled: false },
      });
      await registry.addModels({
        id: parent.id,
        expectedRevision: parent.revision,
        models: ["extra"],
        agentEnabled: false,
      });
      const incompatible = await registry.draft(
        `${plugin.source}\nmodule.exports.meta.channelSettings.extra = {type:'string', label:'Extra', required:true};`,
      );
      expect(
        registry.pluginUpgrade({
          fromHash: plugin.hash,
          toHash: second.hash,
          approve: true,
          models: [{ id: parent.id, model: parent.model, expectedRevision: parent.revision }],
        }),
      ).toMatchObject({
        upgraded: 0,
        failed: [{ id: parent.id, code: "SETTINGS_REVISION_CONFLICT" }],
      });
      expect(
        registry.pluginUpgrade({ fromHash: plugin.hash, toHash: incompatible.hash, approve: true }),
      ).toMatchObject({
        upgraded: 0,
        failed: [{ code: "PROVIDER_CONFIG_INVALID" }, { code: "PROVIDER_CONFIG_INVALID" }],
      });
      expect(
        registry.pluginUpgrade({ fromHash: plugin.hash, toHash: second.hash, approve: true }),
      ).toEqual({ upgraded: 2, failed: [] });
      const providers = registry.list().providers;
      expect(providers).toHaveLength(2);
      for (const entry of providers) {
        expect(entry).toMatchObject({
          pluginHash: second.hash,
          revision: 2,
          enabled: true,
          hasSecret: true,
        });
        expect(registry.binding(entry.id, entry.revision).secret).toBe(input.secret);
      }
      expect(providers.find(({ model }) => model === "extra")?.connectionId).toBe(parent.id);
      expect(() => registry.pluginRemove({ hash: second.hash })).toThrowError(
        expect.objectContaining({ code: "PLUGIN_REFERENCED" }),
      );
    });
  });

  it("接受 128 KiB 以上的源码，按 UTF-8 字节限制到 512 KiB", async () => {
    await withRegistry(async ({ registry }) => {
      const plugin = registry.list().plugins.find(({ key }) => key === "openai");
      if (!plugin) throw new Error("Missing source adapter");
      await expect(
        registry.draft(
          `${plugin.source}\nmodule.exports.meta.key='limit-test';\n/*${"字".repeat(50000)}*/`,
        ),
      ).resolves.toMatchObject({ key: "limit-test" });
      await expect(
        registry.draft(`${plugin.source}\n/*${"字".repeat(180000)}*/`),
      ).rejects.toMatchObject({ code: "PLUGIN_SOURCE_LIMIT" });
    });
  });

  it("保存失败保留凭证，插件 hash 改变需要重新授权，旧修订不能覆盖新值", async () => {
    await withRegistry(async ({ registry, input, failEncryption }) => {
      const profile = registry.save(input);
      const base = { ...input, id: profile.id, expectedRevision: profile.revision, approve: false };
      failEncryption();
      expect(() => registry.save({ ...base, secret: "new-fixture" })).toThrowError(
        expect.objectContaining({ code: "PROVIDER_SECRET_STORE_UNAVAILABLE" }),
      );
      expect(registry.binding(profile.id, profile.revision).secret).toBe(input.secret);
      const plugin = registry.list().plugins.find(({ hash }) => hash === profile.pluginHash);
      const draft = await registry.draft(
        `${plugin?.source}\nmodule.exports.meta.key='reauthorize-test';`,
        "agent",
      );
      const changed = {
        ...base,
        pluginHash: draft.hash,
        secret: undefined,
        fields: { ...input.fields, agentEnabled: false },
      };
      expect(() => registry.save(changed)).toThrowError(
        expect.objectContaining({ code: "PLUGIN_APPROVAL_REQUIRED" }),
      );
      const replaced = registry.save({ ...changed, approve: true });
      expect(replaced.hasSecret).toBe(false);
      expect(() => registry.save(base)).toThrowError(
        expect.objectContaining({ code: "SETTINGS_REVISION_CONFLICT" }),
      );
    });
  });

  it("渠道模型回滚新增的可选路径：删除属性而不是写入空串或 null", async () => {
    await withRegistry(async ({ registry, input }) => {
      const channel = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "渠道",
          endpoint: input.fields.endpoint,
          allowLocal: true,
          enabled: true,
          sort: 0,
          headers: [],
        },
      });
      const model = registry.modelSave({
        expectedRevision: 0,
        channelId: channel.id,
        channelRevision: channel.revision,
        upstreamModel: "example",
        config: { name: "模型", kind: "agent", description: "", sort: 0 },
        settings: { api: "responses" },
        enabled: false,
      });
      const request = { providerId: model.id, expectedRevision: model.revision };
      await expect(
        registry.preview({ ...request, changes: [{ field: "label", value: "改共享名称" }] }),
      ).rejects.toMatchObject({ code: "PROVIDER_SHARED_CONNECTION" });
      const proposal = await registry.preview({
        ...request,
        changes: [{ field: "channel", key: "pathPrefix", value: "/v3" }],
      });
      await expect(registry.applyProposal("20", proposal, [0], "one")).resolves.toMatchObject({
        navigable: true,
        reversible: true,
        items: [{ before: null, after: "/v3" }],
      });
      const reverse = await registry.reverseProposal(proposal.orderNo, "one");
      expect(reverse.items).toEqual([{ field: "channel.pathPrefix", before: "/v3", after: null }]);
      const incidental = await registry.preview({
        ...request,
        expectedRevision: model.revision + 1,
        changes: [{ field: "channel", key: "api", value: "gemini" }],
      });
      await expect(
        registry.applyProposal("unapproved-removal", incidental, [0], "one"),
      ).rejects.toMatchObject({ code: "SETTINGS_PROPOSAL_INVALID" });
      await expect(registry.applyProposal("21", reverse, [0], "one")).resolves.toMatchObject({
        reversible: false,
        items: [{ before: "/v3", after: null }],
      });
      expect(registry.provider(model.id).channel).toEqual({ api: "responses" });
    });
  });

  it("公开单号在并发待审时不重复；旧数字和长单号回执不改写也能建立反向单", async () => {
    await withRegistry(async ({ registry, input, directory }) => {
      const profile = registry.save(input);
      const request = {
        providerId: profile.id,
        expectedRevision: profile.revision,
        changes: [{ field: "label", value: "修改后" }],
      };
      const proposals = await Promise.all(
        Array.from({ length: 32 }, () => registry.preview(request)),
      );
      expect(new Set(proposals.map((proposal) => proposal.orderNo)).size).toBe(32);
      const reserved = proposals[0]!.orderNo;
      await expect(registry.reverseProposal(reserved, "owner")).rejects.toMatchObject({
        code: "SETTINGS_PROPOSAL_INVALID",
      });
      const database = new DatabaseSync(join(directory, "settings.sqlite"));
      try {
        for (const legacy of ["174523001", "CO-261102-25C9F1F7D639983DD4DE611406655215"]) {
          const stored = JSON.stringify({
            order: legacy,
            target: "model",
            key: profile.id,
            revision: profile.revision,
            reversible: true,
            sessionId: "owner",
            items: [{ field: "label", before: "原值", after: profile.label, status: "applied" }],
          });
          database
            .prepare("INSERT INTO settings_receipts VALUES (?,?,?)")
            .run(legacy, "legacy", stored);
          const reverse = await registry.reverseProposal(legacy, "owner");
          expect(reverse).toMatchObject({
            revertOf: legacy,
            items: [{ field: "label", before: profile.label, after: "原值" }],
          });
          expect(
            database.prepare("SELECT result FROM settings_receipts WHERE id=?").get(legacy)?.result,
          ).toBe(stored);
        }
      } finally {
        database.close();
      }
    });
  });

  it("反向单只取同一会话真实回执中已应用的字段，过期或重复回滚不能写入", async () => {
    await withRegistry(async ({ registry, input }) => {
      const original = registry.save(input);
      const proposal = await registry.preview({
        providerId: original.id,
        expectedRevision: original.revision,
        changes: [
          { field: "label", value: "  新名称  " },
          { field: "model", value: "不选" },
        ],
      });
      const receipt = await registry.applyProposal("10", proposal, [0], "first");
      expect(proposal.orderNo).toMatch(/^CO-\d{6}-[\dA-F]{6}$/);
      expect(receipt).toMatchObject({
        order: proposal.orderNo,
        reversible: true,
        items: [
          { field: "label", before: original.label, after: "新名称", status: "applied" },
          { field: "model", before: original.model, after: "不选", status: "rejected" },
        ],
      });
      expect(receipt).not.toHaveProperty("sessionId");
      await expect(registry.applyProposal("10", proposal, [0], "first")).resolves.toEqual(receipt);
      await expect(registry.reverseProposal(proposal.orderNo, "second")).rejects.toMatchObject({
        code: "SETTINGS_PROPOSAL_INVALID",
      });
      await expect(registry.reverseProposal("10", "first")).rejects.toMatchObject({
        code: "SETTINGS_PROPOSAL_INVALID",
      });
      const reverse = await registry.reverseProposal(proposal.orderNo, "first");
      expect(reverse).toMatchObject({
        revertOf: proposal.orderNo,
        items: [{ field: "label", before: "新名称", after: original.label }],
      });
      expect(reverse.orderNo).not.toEqual(proposal.orderNo);
      expect(registry.provider(original.id).label).toBe("新名称");
      await expect(registry.applyProposal("11", reverse, [0], "first")).resolves.toMatchObject({
        order: reverse.orderNo,
        reversible: false,
      });
      expect(registry.provider(original.id)).toMatchObject({
        label: original.label,
        model: original.model,
      });
      await expect(registry.reverseProposal(reverse.orderNo, "first")).rejects.toMatchObject({
        code: "SETTINGS_PROPOSAL_INVALID",
      });
      await expect(registry.reverseProposal(proposal.orderNo, "first")).rejects.toMatchObject({
        code: "SETTINGS_REVISION_CONFLICT",
      });
    });
  });

  it("已提交配置与凭证的决定在 Worker 启动时对账，外部试跑未知不补发", async () => {
    await withRegistry(async ({ registry, directory, input }) => {
      const profile = registry.save(input);
      const store = openStore(join(directory, "agent.sqlite"));
      const targets = new SpikeTargets(join(directory, "targets.sqlite"));
      const sessions: string[] = [];
      const approvalIds: string[] = [];
      let savedReceipt: Awaited<ReturnType<SettingsRegistry["applyProposal"]>>;
      try {
        targets.scope(scope);
        const create = (kind: string, payload: unknown, pending = false) => {
          const session = store.createSession({
            userId: "1",
            canvasId: "0",
            title: kind,
            mode: "admin",
            modelKey: "fixture",
          });
          sessions.push(session.id);
          targets.bindSession(session.id, scope);
          const run = store.createRun({
            sessionId: session.id,
            canvasId: "0",
            userId: "1",
            status: pending ? "waiting_approval" : "interrupted",
            mode: "admin",
          });
          const approval = store.createApproval({
            runId: run.id,
            sessionId: session.id,
            canvasId: "0",
            userId: "1",
            kind,
            toolCallId: kind,
            payload,
            quoteCredits: 0,
            status: "pending",
            expiresAt: Date.now() + 60000,
          });
          approvalIds.push(approval.id);
          if (!pending)
            store.updateApprovalIf(approval.id, ["pending"], {
              status: "approved",
              decision: { decision: "approve", items: [{ index: 0, approve: true }] },
            });
          return approval.id;
        };
        const proposal = await registry.preview({
          providerId: profile.id,
          expectedRevision: profile.revision,
          changes: [{ field: "label", value: "已提交" }],
        });
        const changeId = create("admin_change", proposal);
        savedReceipt = await registry.applyProposal(changeId, proposal, [0], sessions[0]);
        expect(savedReceipt).toMatchObject({
          order: proposal.orderNo,
          applied: 1,
          skipped: 0,
          items: [{ field: "label", before: profile.label, after: "已提交", status: "applied" }],
        });
        await expect(registry.applyProposal("stale-fixture", proposal, [0])).rejects.toMatchObject({
          code: "SETTINGS_REVISION_CONFLICT",
        });
        const secret = registry.actionTarget("admin_secret", profile.id, 2);
        registry.configureSecret(
          create("admin_secret", secret, true),
          secret,
          "replacement-fixture",
        );
        create("admin_test_run", registry.actionTarget("admin_test_run", profile.id, 3));
      } finally {
        store.close();
        targets.close();
      }

      for (const _boot of [1, 2]) {
        const runtime = await LocalAgentRuntime.open({
          directory,
          modelBridgeUrl: "http://127.0.0.1:1",
          settings: async (command, raw) => {
            const args = raw as {
              approvalId: string;
              payload: unknown;
              selected: number[];
              recovery: boolean;
              sessionId: string;
            };
            if (command === "apply")
              return registry.applyProposal(
                args.approvalId,
                args.payload as Awaited<ReturnType<SettingsRegistry["preview"]>>,
                args.selected,
                args.sessionId,
              );
            const target = args.payload as ReturnType<SettingsRegistry["actionTarget"]>;
            if (command === "hasSecretReceipt")
              return registry.hasSecretReceipt(args.approvalId, target);
            if (command === "approvedTest") {
              expect(args.recovery).toBe(true);
              return registry.approvedTest(args.approvalId, target, args.recovery);
            }
            throw new Error(`Unexpected command ${command}`);
          },
        });
        try {
          expect(approvalIds.map((id) => runtime.store.getApproval("1", id).result)).toEqual([
            savedReceipt,
            { configured: true },
            { code: "PROVIDER_OUTCOME_UNKNOWN" },
          ]);
          for (const [index, sessionId] of sessions.entries())
            expect(
              (await runtime.page(scope, sessionId, 0)).events.filter(
                ({ type }) => type === "approval.decided",
              ),
            ).toMatchObject([{ approvalId: approvalIds[index] }]);
          expect(registry.provider(profile.id)).toMatchObject({
            revision: 3,
            label: "已提交",
            hasSecret: true,
          });
        } finally {
          await runtime.close();
        }
      }
    });
  });
});

it("S3 生产传输拒绝跨源、重定向和未授权的本机端点", async () => {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits++;
    response.writeHead(302, { location: "/never-follow" }).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("回环测试服务未监听");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const request = {
      method: "GET",
      url: endpoint,
      headers: {},
      timeoutMs: 1000,
      responseType: "text",
    } as const;
    const blocked = { code: "PROVIDER_ENDPOINT_BLOCKED" };
    await expect(openProviderResponse(endpoint, false, request)).rejects.toMatchObject(blocked);
    await expect(
      openProviderResponse(endpoint, true, { ...request, url: "http://127.0.0.1:1" }),
    ).rejects.toMatchObject(blocked);
    expect(hits).toBe(0);
    await expect(openProviderResponse(endpoint, true, request)).rejects.toMatchObject(blocked);
    expect(hits).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("小说研读与分集规划经回环模型返回，遗漏末章的格式段携带反馈重试", async () => {
  await withRegistry(async ({ registry, input }) => {
    const analysis = {
      source_kind: "novel",
      summary: "雨夜收到一封信",
      characters_md: "来客",
      outline_md: "门响，拆信。",
    };
    const episode = {
      title: "来信",
      synopsis: "来客递信",
      hook: "谁敲门",
      cliffhanger: "信封未拆",
      unit_from: 1,
      unit_to: 2,
    };
    const replies = [
      JSON.stringify(analysis),
      "第1集，来信。",
      JSON.stringify({ episodes: [{ ...episode, unit_to: 1 }] }),
      JSON.stringify({ episodes: [episode] }),
    ];
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content);
      const delta = { content: replies[requests.length - 1] };
      response
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(
          `data: ${JSON.stringify({ choices: [{ delta, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw Error("回环服务缺少端口");
      const model = registry.save({
        ...input,
        fields: { ...input.fields, endpoint: `http://127.0.0.1:${address.port}` },
      });
      const signal = AbortSignal.timeout(10000);
      const source = "## [1] 第一章\n敲门。\n## [2] 第二章\n拆信。\n";
      await expect(
        registry.dramaAssetStage(model, "analyze", { source, source_kind: "novel" }, {}, signal),
      ).resolves.toEqual(analysis);
      const scope = { unit_from: 1, unit_to: 2 };
      const draft = await registry.dramaAssetStage(
        model,
        "plan",
        { source, source_summary: analysis.summary },
        scope,
        signal,
      );
      await expect(
        registry.dramaAssetStage(
          model,
          "plan_format",
          { batch_from: 1, batch_to: 2, draft_md: draft },
          scope,
          signal,
        ),
      ).resolves.toEqual({ episodes: [episode] });
      const variables = requests.map((prompt) =>
        JSON.parse(prompt.split("```json\n")[1]!.split("\n```")[0]!),
      );
      expect(variables).toEqual([
        { source, source_kind: "novel" },
        { source, source_summary: analysis.summary },
        { batch_from: 1, batch_to: 2, draft_md: replies[1] },
        {
          batch_from: 1,
          batch_to: 2,
          draft_md: replies[1],
          validation_error: expect.stringContaining("规划未覆盖批次末尾"),
        },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

it("Gemini 两轮网关调用保留函数签名、参数、结果和最终用量", async () => {
  await withRegistry(async ({ registry, input }) => {
    const requests: { path: string; key?: string | string[]; body: unknown }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        path: request.url ?? "",
        key: request.headers["x-goog-api-key"],
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      const part =
        requests.length === 1
          ? {
              functionCall: { name: "lookup", args: { name: "海报" } },
              thoughtSignature: "签名+/=",
            }
          : { text: "找到海报" };
      response
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(
          `data: ${JSON.stringify({ candidates: [{ content: { parts: [part] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2, thoughtsTokenCount: 1 } })}\n\n`,
        );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("缺少回环服务");
      const profile = registry.save({
        ...input,
        fields: {
          ...input.fields,
          endpoint: `http://127.0.0.1:${address.port}`,
          channel: { api: "gemini" },
        },
      });
      const binding = registry.binding(profile.id, profile.revision);
      const messages: unknown[] = [{ role: "user", content: "找海报" }];
      const send = async () => {
        const parameters = {
          type: "object",
          additionalProperties: false,
          properties: {
            minimum: { type: "number", minimum: 0, maximum: 9 },
            status: {
              anyOf: [
                { type: "string", const: "todo" },
                { type: "string", enum: ["doing", "done"] },
              ],
            },
          },
        };
        const stream = await openAgentStream(
          binding,
          {
            messages,
            tools: [{ type: "function", function: { name: "lookup", parameters } }],
            tool_choice: { type: "function", function: { name: "lookup" } },
          },
          registry.redactor(),
          3000,
          AbortSignal.timeout(3000),
        );
        let body = "";
        for await (const chunk of stream) body += chunk.toString();
        return body
          .split("\n\n")
          .filter((frame) => frame.startsWith("data: {"))
          .map((frame) => JSON.parse(frame.slice(6)));
      };
      const frames = await send();
      expect(requests[0]?.body).toMatchObject({
        tools: [
          {
            functionDeclarations: [
              {
                name: "lookup",
                parameters: {
                  properties: {
                    minimum: { type: "number", description: "（0 到 9）" },
                    status: { type: "string", enum: ["todo", "doing", "done"] },
                  },
                },
              },
            ],
          },
        ],
        toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] } },
      });
      expect(JSON.stringify(requests[0]?.body)).not.toMatch(/additionalProperties|anyOf/);
      const call = frames[0].choices[0].delta.tool_calls[0];
      expect(call.function).toEqual({ name: "lookup", arguments: '{"name":"海报"}' });
      expect(frames[1].choices[0].finish_reason).toBe("tool_calls");
      messages.push(
        { role: "assistant", tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "asset-123" },
      );
      const answer = await send();
      expect(answer[0].choices[0].delta.content).toBe("找到海报");
      expect(answer.at(-1).usage).toMatchObject({
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
      });
      expect(requests[1]).toMatchObject({
        path: "/antigravity/v1beta/models/fixture:streamGenerateContent?alt=sse",
        key: "fixture-credential",
        body: {
          contents: [
            { role: "user", parts: [{ text: "找海报" }] },
            {
              role: "model",
              parts: [
                {
                  functionCall: { name: "lookup", args: { name: "海报" } },
                  thoughtSignature: "签名+/=",
                },
              ],
            },
            {
              role: "user",
              parts: [{ functionResponse: { name: "lookup", response: { content: "asset-123" } } }],
            },
          ],
        },
      });
      const mediaURL = "https://cdn.example.com/reference.mp4?signature=fixture";
      const videoPayload = {
        messages: [
          {
            role: "user",
            content: [{ type: "video", video: { mime_type: "video/mp4", url: mediaURL } }],
          },
        ],
      };
      await expect(
        openAgentStream(
          binding,
          videoPayload,
          registry.redactor(),
          3000,
          AbortSignal.timeout(3000),
        ),
      ).rejects.toMatchObject({ code: "AGENT_MODEL_CAPABILITY_UNSUPPORTED" });
      expect(requests).toHaveLength(2);
      const enabled = {
        ...binding,
        profile: {
          ...binding.profile,
          config: {
            kind: "agent" as const,
            name: "视频理解",
            sort: 0,
            description: "",
            video: true,
          },
        },
      };
      const stream = await openAgentStream(
        enabled,
        videoPayload,
        registry.redactor(),
        3000,
        AbortSignal.timeout(3000),
      );
      let result = "";
      for await (const chunk of stream) result += chunk.toString();
      expect(result).toContain("[DONE]");
      expect(requests[2]?.body).toMatchObject({
        contents: [
          { role: "user", parts: [{ fileData: { mimeType: "video/mp4", fileUri: mediaURL } }] },
        ],
      });
      const video = { mime_type: "video/mp4", data: "AAEC" };
      const analyzed = await probeAgentStream(enabled, registry.redactor(), 3000, {
        prompt: "分析视频",
        video,
      });
      expect(analyzed.text).toBe("找到海报");
      expect(requests[3]?.body).toMatchObject({
        contents: [
          {
            role: "user",
            parts: [{ text: "分析视频" }, { inlineData: { mimeType: "video/mp4", data: "AAEC" } }],
          },
        ],
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

it("渠道 Agent 流活跃时续期、静默时释放唯一名额，兼容整段 OpenAI 和 Gemini 回复", async () => {
  await withRegistry(async ({ registry, directory }) => {
    let mode = "active";
    let first = true;
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url!);
      if (mode === "auth") {
        response.writeHead(401).end("private error detail");
        return;
      }
      if (mode === "no-headers") return;
      if (mode === "invalid-json") {
        response.writeHead(200, { "content-type": "application/json" }).end("{");
        return;
      }
      if (mode === "retry" && first) {
        first = false;
        return;
      }
      if (mode === "json") {
        const body = request.url?.includes("streamGenerateContent")
          ? { candidates: [{ content: { parts: [{ text: "gemini-ok" }] }, finishReason: "STOP" }] }
          : {
              choices: [
                { message: { role: "assistant", content: "chat-ok" }, finish_reason: "stop" },
              ],
            };
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(body, null, 2));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" }).flushHeaders();
      if (mode === "silent") return;
      if (mode === "truncated") {
        response.end('data: {"choices":[{"delta":{"content":"unfinished"}}]}\n');
        return;
      }
      if (mode === "finish-only") {
        response.end(
          'data: {"choices":[{"index":0,"delta":{"content":"finished"},"finish_reason":"stop"}]}',
        );
        return;
      }
      if (mode === "error-frame") {
        response.end('data: {"error":{"message":"private error detail"}}\n\ndata: [DONE]\n\n');
        return;
      }
      if (mode === "usage") {
        response.write(
          'data: ping\ndata: {"candidates":[{"content":{"parts":[{"text":"usage-ok"}]},"finishReason":"STOP"}]}\n',
        );
        response.write('data: {"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}\n');
        return;
      }
      if (mode === "partial") {
        response.write('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n');
        return;
      }
      let count = 0;
      const timer = setInterval(() => {
        if (++count < 9) response.write(": keepalive\n\n");
        else {
          clearInterval(timer);
          response.write(
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"active-ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          );
        }
      }, 55);
      response.on("close", () => clearInterval(timer));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw Error("缺少测试服务");
      const channel = registry.channelSave({
        expectedRevision: 0,
        approve: true,
        secret: "fixture-key",
        fields: {
          name: "网关渠道",
          endpoint: `http://127.0.0.1:${address.port}`,
          allowLocal: true,
          enabled: true,
          sort: 0,
          headers: [],
          concurrent: 1,
        },
      });
      const model = registry.modelSave({
        expectedRevision: 0,
        channelId: channel.id,
        channelRevision: channel.revision,
        upstreamModel: "fixture",
        config: {
          name: "助手",
          kind: "agent",
          description: "",
          sort: 1,
          timeoutSeconds: 10,
          agentDeadlineSeconds: 5,
        },
        settings: { api: "chat_completions" },
        enabled: true,
      });
      const saved = registry.agentBinding(model.id, model.revision);
      const binding = {
        ...saved,
        profile: { ...saved.profile, config: { ...model.config!, timeoutSeconds: 0.25 } },
      };
      const probe = (timeout = 3000) =>
        probeAgentStream(binding, registry.redactor(), timeout, { prompt: "hi" });
      await expect(probe()).resolves.toMatchObject({ text: "active-ok" });
      for (const scenario of ["no-headers", "silent", "partial"]) {
        mode = scenario;
        await expect(probe()).rejects.toMatchObject({ code: "AGENT_TEST_TIMEOUT" });
      }
      mode = "retry";
      await expect(probe()).resolves.toMatchObject({ text: "active-ok" });
      mode = "active";
      await expect(probe(190)).rejects.toMatchObject({ code: "AGENT_TEST_TIMEOUT" });
      mode = "json";
      await expect(probe()).resolves.toMatchObject({ text: "chat-ok" });
      const gemini = { ...binding, profile: { ...binding.profile, channel: { api: "gemini" } } };
      await expect(
        probeAgentStream(gemini, registry.redactor(), 3000, { prompt: "hi" }),
      ).resolves.toMatchObject({ text: "gemini-ok" });
      mode = "usage";
      await expect(
        probeAgentStream(gemini, registry.redactor(), 3000, { prompt: "hi" }),
      ).resolves.toMatchObject({ text: "usage-ok" });
      mode = "invalid-json";
      await expect(
        probeAgentStream(gemini, registry.redactor(), 3000, { prompt: "hi" }),
      ).rejects.toMatchObject({ code: "AGENT_TEST_INVALID_STREAM" });
      expect(requests).toEqual([
        ...Array(10).fill("/v1/chat/completions"),
        ...Array(3).fill("/antigravity/v1beta/models/fixture:streamGenerateContent?alt=sse"),
      ]);
      mode = "auth";
      await expect(probe()).rejects.toMatchObject({ code: "AGENT_TEST_AUTH_FAILED" });
      mode = "silent";
      const controller = new AbortController();
      const canceled = await openAgentStream(
        binding,
        { messages: [] },
        registry.redactor(),
        3000,
        controller.signal,
      );
      const closed = new Promise((resolve) => canceled.once("close", resolve));
      canceled.on("error", () => {});
      controller.abort();
      await closed;
      const abandoned = await openAgentStream(
        binding,
        { messages: [] },
        registry.redactor(),
        3000,
        AbortSignal.timeout(3000),
      );
      const waiting = new AbortController();
      const queued = openAgentStream(
        binding,
        { messages: [] },
        registry.redactor(),
        3000,
        waiting.signal,
      );
      waiting.abort();
      await expect(queued).rejects.toThrow();
      const abandonedClosed = once(abandoned, "close");
      abandoned.destroy();
      await abandonedClosed;
      const database = new DatabaseSync(join(directory, "settings.sqlite"), { readOnly: true });
      try {
        const records = () =>
          database
            .prepare("SELECT metadata FROM gateway_attempts ORDER BY rowid")
            .all()
            .map((row) => JSON.parse(String(row.metadata)));
        await vi.waitFor(() => expect(records()).toHaveLength(requests.length));
        const rows = records();
        expect(rows.map((row) => [row.net_attempt, row.result])).toEqual([
          [1, "ok"],
          [1, "timeout"],
          [2, "timeout"],
          [1, "timeout"],
          [2, "timeout"],
          [1, "timeout"],
          [1, "timeout"],
          [2, "ok"],
          [1, "timeout"],
          [1, "ok"],
          [1, "ok"],
          [1, "ok"],
          [1, "failed"],
          [1, "failed"],
          [1, "canceled"],
          [1, "canceled"],
        ]);
        expect(new Set(rows.map((row) => row.call_id)).size).toBe(13);
        for (const index of [2, 4, 7]) expect(rows[index].call_id).toBe(rows[index - 1].call_id);
        expect(rows[0]).toMatchObject({
          event: "llm.call",
          purpose: "model_trial",
          channel: channel.id,
          upstream_model: "fixture",
          format: "openai",
          response_chars: 9,
          finish_reason: "stop",
          usage_missing: true,
        });
        expect(rows[1]).toMatchObject({ ttft_ms: null, upstream_status: null });
        expect(rows[3]).toMatchObject({ ttft_ms: null, upstream_status: 200 });
        expect(rows[5]).toMatchObject({ response_chars: 7, error_type: "timeout" });
        expect(rows[7].latency_ms).toBeGreaterThanOrEqual(rows[7].ttft_ms);
        expect(rows[7].ttft_ms).toBeGreaterThan(0);
        expect(rows[11]).toMatchObject({
          format: "gemini",
          usage_missing: false,
          input_tokens: 3,
          output_tokens: 2,
          cached_tokens: 0,
          response_chars: 8,
        });
        expect(rows[13]).toMatchObject({ error_type: "upstream", upstream_status: 401 });
        expect(rows[15]).toMatchObject({
          request_bytes: Buffer.byteLength(
            JSON.stringify({ messages: [], model: "fixture", stream: true }),
          ),
          purpose: "agent",
        });
        expect(JSON.stringify(rows)).not.toMatch(
          /fixture-key|private error detail|active-ok|127\.0\.0\.1|Authorization|"messages"|usage-ok|gemini-ok|chat-ok/,
        );
      } finally {
        database.close();
      }
      mode = "json";
      await expect(
        probeAgentStream(
          {
            ...binding,
            observeAttempt: () => {
              throw Error("diagnostic unavailable");
            },
          },
          registry.redactor(),
          3000,
          { prompt: "hi" },
        ),
      ).resolves.toMatchObject({ text: "chat-ok" });
      mode = "truncated";
      await expect(probe()).rejects.toMatchObject({ code: "AGENT_TEST_INVALID_STREAM" });
      mode = "error-frame";
      await expect(probe()).rejects.toMatchObject({ code: "AGENT_TEST_HTTP_FAILED" });
      mode = "finish-only";
      await expect(probe()).resolves.toMatchObject({ text: "finished" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

it("设备网关诊断原子淘汰旧尝试，重开只读连接可读取最近 1024 条", async () => {
  await withRegistry(async ({ directory }) => {
    const path = join(directory, "settings.sqlite");
    const writer = new DatabaseSync(path);
    try {
      writer.exec(`WITH RECURSIVE sequence(idx) AS (SELECT 1 UNION ALL SELECT idx+1 FROM sequence WHERE idx<1030)
        INSERT INTO gateway_attempts SELECT 'fixture',idx,'{}' FROM sequence`);
    } finally {
      writer.close();
    }
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        reader
          .prepare(
            "SELECT min(net_attempt) AS first,max(net_attempt) AS last,count(*) AS count FROM gateway_attempts",
          )
          .get(),
      ).toMatchObject({ first: 7, last: 1030, count: 1024 });
    } finally {
      reader.close();
    }
  });
});

it("小灵连接检测区分认证、限流、非流式响应、断流与超时", async () => {
  await withRegistry(async ({ registry, input }) => {
    let mode = "auth";
    const server = createServer((_request, response) => {
      switch (mode) {
        case "auth":
          response.writeHead(401).end();
          break;
        case "rate":
          response.writeHead(429).end();
          break;
        case "json":
          response.writeHead(200, { "content-type": "application/json" }).end("{}");
          break;
        case "truncated":
          response
            .writeHead(200, { "content-type": "text/event-stream" })
            .end(
              'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_partial"}}\n\n' +
                'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"OK"}\n\n',
            );
          break;
        default:
          response.writeHead(200, { "content-type": "text/event-stream" }).flushHeaders();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务未监听");
      const profile = registry.save({
        ...input,
        fields: {
          ...input.fields,
          endpoint: `http://127.0.0.1:${address.port}`,
          channel: { api: "responses" },
        },
      });
      const binding = registry.binding(profile.id, profile.revision);
      const redactor = registry.redactor();
      for (const [scenario, code] of [
        ["auth", "AGENT_TEST_AUTH_FAILED"],
        ["rate", "AGENT_TEST_RATE_LIMITED"],
        ["json", "AGENT_TEST_INVALID_STREAM"],
        ["truncated", "AGENT_TEST_INVALID_STREAM"],
        ["timeout", "AGENT_TEST_TIMEOUT"],
      ]) {
        mode = scenario ?? "";
        await expect(
          probeAgentStream(binding, redactor, mode === "timeout" ? 100 : 3000),
        ).rejects.toMatchObject({ code });
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

it("小灵检测拒绝重入和陈旧修订，不创建会话", async () => {
  await withRegistry(async ({ registry, directory, input }) => {
    let finish!: () => void;
    const arrived = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hits = 0;
    const server = createServer(async (_request, response) => {
      hits++;
      finish();
      await waiting;
      response
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(
          'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试服务未监听");
      const profile = registry.save({
        ...input,
        fields: { ...input.fields, endpoint: `http://127.0.0.1:${address.port}` },
      });
      const agent = new SettingsAgent(registry, directory, "unused");
      const target = { id: profile.id, expectedRevision: profile.revision };
      const pending = expect(agent.testConnection(target)).rejects.toMatchObject({
        code: "SETTINGS_REVISION_CONFLICT",
      });
      await arrived;
      await expect(agent.testConnection(target)).rejects.toMatchObject({ code: "AGENT_TEST_BUSY" });
      registry.disable(target);
      release();
      await pending;
      await expect(agent.testConnection(target)).rejects.toMatchObject({
        code: "SETTINGS_REVISION_CONFLICT",
      });
      expect(hits).toBe(1);
    } finally {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

it("Responses 文本和工具参数增量中的跨帧凭证会被移除", () => {
  const secret = "fixture-secret-value";
  const clean = cleanModelStream(
    {
      secrets: [secret],
      redact: (value) => value.replaceAll(secret, "[凭证已移除]"),
    },
    true,
  );
  for (const type of ["response.output_text.delta", "response.function_call_arguments.delta"]) {
    const event = (delta: string) => `data: ${JSON.stringify({ type, output_index: 0, delta })}`;
    expect(clean(event("fixture-secret"))).not.toContain("fixture-secret");
    expect(clean(event("-value"))).toContain("[凭证已移除]");
  }
});
