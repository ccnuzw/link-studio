import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { settleDramaImageParams } from "../../packages/link-studio-core/src/drama-image-params";
import { modelGenerationOptions } from "../../packages/link-studio-core/src/media-generation";
import { ProviderError } from "../../packages/provider-runtime/src/runner";
import { applyCanvas, projectCanvas } from "../../src/main/project/canvas";
import { CanvasAgentService } from "../../src/main/project/canvas-agent";
import {
  addDramaEpisode,
  addDramaSegment,
  createDrama,
  DramaTools,
  deleteDramaEpisode,
  dramaDocument,
  reorderDramaSegments,
  saveDramaScript,
  setDramaSegmentPrompt,
  setDramaSegmentSeconds,
  updateDramaBoardSettings,
} from "../../src/main/project/drama";
import { adaptDramaSegment } from "../../src/main/project/drama-adaptation";
import { type DramaAsset, mergeDramaAssets } from "../../src/main/project/drama-assets";
import { syncDramaBoards } from "../../src/main/project/drama-boards";
import { estimateDramaJob } from "../../src/main/project/drama-estimate";
import { storyboardClearHash, submitApprovedDramaJob } from "../../src/main/project/drama-job";
import {
  controlDramaPlanning,
  extendDramaPlanning,
  runDramaPlanning,
} from "../../src/main/project/drama-planning";
import { runDramaAssetJob } from "../../src/main/project/drama-worker";
import { ProjectStore } from "../../src/main/project/store";
import type { SettingsRegistry } from "../../src/main/settings/registry";

test("片段转写保留启动时原稿指纹，两种格式重开后由小灵读回", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-adapt-"));
  let store = await ProjectStore.create(directory, "转写");
  try {
    const doc = await createDrama(store, { title: "来信", script: "敲门。" });
    const source = "@[信使](n1)敲门。@[信使](n1)转身。";
    const added = await addDramaSegment(store, {
      episode_no: 1,
      revision: doc.revision,
      prompt: source,
      seconds: 5,
    });
    const segment = added.segments![0]!;
    const base = { segmentId: segment.id, episodeNo: 1, episodeOrder: 0 };
    const signal = new AbortController().signal;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = {
      withDramaTextModel: (_preferred: string, task: (model: object) => unknown) => task({}),
      dramaAssetStage: async (_model: object, step: string, variables: { assets: unknown[] }) => {
        expect(variables.assets).toEqual([{ node_id: "n1", name: "信使" }]);
        await gate;
        return { prompt: `${step} @[信使](n1)` };
      },
    } as unknown as SettingsRegistry;
    const request = { ...base, revision: segment.revision, format: "h3" };
    const adapting = adaptDramaSegment(store, registry, request, signal);
    await expect(adaptDramaSegment(store, registry, request, signal)).rejects.toThrow("正在转写");
    const updatedSource = source + "雨停了。";
    await setDramaSegmentPrompt(store, {
      ...base,
      revision: segment.revision,
      prompt: updatedSource,
    });
    release();
    const adapted = (await adapting).segments![0]!;
    expect(adapted.prompt).toBe(updatedSource);
    expect(adapted.adaptations?.h3).toMatchObject({
      source_hash: createHash("sha256").update(source).digest("hex"),
      edited: false,
    });
    await expect(adaptDramaSegment(store, registry, request, signal)).rejects.toMatchObject({
      code: "AGENT_APPROVAL_STALE",
    });
    const both = await adaptDramaSegment(
      store,
      registry,
      { ...request, revision: adapted.revision, format: "generic" },
      signal,
    );
    let releaseRewrite!: () => void;
    const rewriteGate = new Promise<void>((resolve) => {
      releaseRewrite = resolve;
    });
    const rewriting = adaptDramaSegment(
      store,
      {
        ...registry,
        dramaAssetStage: () => rewriteGate.then(() => ({ prompt: "不应覆盖手改" })),
      } as unknown as SettingsRegistry,
      { ...request, revision: both.segments![0]!.revision },
      signal,
    );
    const rejectedRewrite = expect(rewriting).rejects.toMatchObject({
      code: "AGENT_APPROVAL_STALE",
    });
    const edited = await setDramaSegmentPrompt(store, {
      ...base,
      revision: both.segments![0]!.revision,
      format: "h3",
      prompt: "手改的镜头",
    });
    releaseRewrite();
    await rejectedRewrite;
    expect(edited.segments![0]!.adaptations?.generic).toEqual(
      both.segments![0]!.adaptations?.generic,
    );
    const path = store.directory;
    await store.close();
    store = await ProjectStore.open(path);
    const read = await new DramaTools().command(store, "drama-read", {
      runId: "read",
      input: { scope: "segments", episode_no: 1 },
    });
    expect(read).toMatchObject([
      {
        prompt: updatedSource,
        adaptations: {
          h3: {
            prompt: "手改的镜头",
            edited: true,
            source_hash: adapted.adaptations!.h3!.source_hash,
          },
          generic: {
            prompt: "adapt_generic @[信使](n1)",
            source_hash: createHash("sha256").update(updatedSource).digest("hex"),
          },
        },
      },
    ]);
    expect(dramaDocument(store.snapshot)).toEqual(edited);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("片段时长按版本和分集保存，同值不重写，保留采用的视频和相邻片段", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-seconds-"));
  const store = await ProjectStore.create(root, "片场时长");
  try {
    const created = await createDrama(store, { title: "来信", script: "敲门。离开。" });
    const first = await addDramaSegment(store, {
      episode_no: 1,
      revision: created.revision,
      prompt: "敲门",
      seconds: 5,
    });
    await addDramaSegment(store, {
      episode_no: 1,
      revision: first.revision,
      prompt: "离开",
      seconds: 20,
    });
    await store.updateGeneration((state) => {
      dramaDocument(state)!.segments![1]!.chosen_task_id = "selected";
      return { changed: true, result: null };
    });
    const before = dramaDocument(store.snapshot)!;
    const [neighbor, selected] = before.segments!;
    const input = {
      segmentId: selected!.id,
      revision: selected!.revision,
      seconds: 8,
      episodeNo: 1,
      episodeOrder: 0,
    };
    const after = await setDramaSegmentSeconds(store, input);
    expect(after.segments).toEqual([
      neighbor,
      { ...selected, seconds: 8, revision: input.revision + 1 },
    ]);
    expect(after.episodes).toEqual(before.episodes);
    const current = { ...input, revision: input.revision + 1 };
    expect((await setDramaSegmentSeconds(store, current)).revision).toBe(after.revision);
    for (const mismatch of [{ revision: input.revision }, { episodeNo: 2 }, { episodeOrder: 1 }]) {
      await expect(
        setDramaSegmentSeconds(store, { ...current, seconds: 3, ...mismatch }),
      ).rejects.toMatchObject({ code: "AGENT_APPROVAL_STALE" });
    }
    expect(dramaDocument(store.snapshot)).toEqual(after);
    const { seconds: _seconds, ...base } = current;
    const empty = await setDramaSegmentPrompt(store, { ...base, prompt: "" });
    expect(empty.segments).toEqual([
      neighbor,
      { ...after.segments![1], prompt: "", revision: base.revision + 1 },
    ]);
    await expect(setDramaSegmentPrompt(store, { ...base, prompt: "旧稿" })).rejects.toMatchObject({
      code: "AGENT_APPROVAL_STALE",
    });
    expect(dramaDocument(store.snapshot)).toEqual(empty);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("片场新增空白片段写在本集末尾，重开可编辑，旧请求不会再次新增", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-add-clip-"));
  let store = await ProjectStore.create(root, "时间线新增");
  try {
    let doc = await createDrama(store, {
      title: "两集",
      script: "第一集 初见\n敲门。\n第二集 离开\n出门。",
    });
    doc = await addDramaSegment(store, {
      episode_no: 2,
      revision: doc.revision,
      seconds: 5,
      prompt: "楼梯",
    });
    const original = doc.segments![0]!;
    const neighbor = doc.episodes[0]!;
    const request = { episode_no: 2, revision: doc.revision, seconds: 8 };
    const saved = await addDramaSegment(store, request);
    const blank = saved.segments![1]!;
    expect(blank).toMatchObject({ seq: 1, episode_no: 2, prompt: "", revision: 1, seconds: 8 });
    expect(saved.segments![0]).toEqual(original);
    expect(saved.episodes[0]).toEqual(neighbor);
    expect(saved.episodes[1]!.segment_version).toBe(doc.episodes[1]!.segment_version! + 1);
    await expect(addDramaSegment(store, request)).rejects.toMatchObject({
      code: "AGENT_APPROVAL_STALE",
    });
    const dir = store.directory;
    await store.close();
    store = await ProjectStore.open(dir);
    expect(dramaDocument(store.snapshot)).toEqual(saved);
    const edited = await setDramaSegmentPrompt(store, {
      segmentId: blank.id,
      episodeNo: 2,
      episodeOrder: 0,
      revision: 1,
      prompt: "开门。",
    });
    expect(edited.segments![1]).toEqual({ ...blank, revision: 2, prompt: "开门。" });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("排序只接受本集完整排列，换位片段分别递增版本", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-order-"));
  const store = await ProjectStore.create(root, "时间线");
  try {
    let doc = await createDrama(store, {
      title: "两集",
      script: "第一集 初见\n敲门。\n第二集 离开\n出门。",
    });
    for (const episodeNo of [1, 2, 1]) {
      doc = await addDramaSegment(store, {
        episode_no: episodeNo,
        revision: doc.revision,
        seconds: 5,
        prompt: "镜头",
      });
    }
    const [first, other, last] = doc.segments!;
    const previous = [first!.id, last!.id];
    const input = {
      episodeNo: 1,
      episodeOrder: doc.episode_order ?? 0,
      previous,
      ids: [...previous].reverse(),
    };
    for (const ids of [[other!.id, first!.id], [first!.id], [first!.id, first!.id]]) {
      await expect(reorderDramaSegments(store, { ...input, ids })).rejects.toThrow();
      expect(dramaDocument(store.snapshot)).toEqual(doc);
    }
    const ordered = await reorderDramaSegments(store, input);
    expect(ordered.segments).toEqual([
      { ...last, seq: 0, revision: last!.revision + 1 },
      other,
      { ...first, seq: 1, revision: first!.revision + 1 },
    ]);
    expect(ordered.episodes[0]!.segment_version).toBe(doc.episodes[0]!.segment_version! + 2);
    expect(ordered.episodes[1]).toEqual(doc.episodes[1]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("删集与画布引用一次提交，全集、未分类、已有素材和历史任务保留；旧读取和审批不作用于补位集", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-delete-"));
  let store = await ProjectStore.create(root, "分集补位");
  const tools = new DramaTools(),
    command = (cmd: string, input: unknown, id?: string) =>
      tools.command(store, cmd, { runId: "writer", kind: "drama_update_episode", input, id });
  const read = () => command("drama-read", { scope: "episode", episode_no: 2 }),
    edit = { episode_no: 2, script_md: "不应覆盖下一集" };
  const inputs = [
    { name: "多集", episodes: [1, 2, 3] },
    { name: "仅二", episodes: [2] },
    { name: "全集", episodes: [] },
  ];
  const assetId = "927c4701-3bc2-42cf-b1f5-4c387428cb60";
  try {
    await createDrama(store, {
      title: "三集",
      script: "第一集 初见\n敲门。\n第二集 再遇\n递信。\n第三集 离开\n出门。",
    });
    await store.updateGeneration((state) => {
      const doc = dramaDocument(state)!;
      doc.episodes[1]!.revision = 2;
      doc.segments = [2, 3].map((no) => ({
        id: String(no).repeat(32),
        episode_no: no,
        seq: 0,
        revision: 1,
        prompt: "拍街道",
        seconds: 4,
      }));
      for (const no of [2, 3]) syncDramaBoards(state, no, doc.segments);
      mergeDramaAssets(
        state,
        inputs.map((input) => ({
          ...input,
          type: "scene",
          description: "",
          look: "",
          aliases: [],
          voice_prompt: "",
        })),
      );
      state.canvas = applyCanvas(state, [
        {
          type: "putNode",
          node: {
            id: "handwritten-letter",
            type: "creative",
            position: { x: 0, y: 10 },
            data: { kind: "script", label: "手写信件", text: "第三封信", drama: { episodes: [2] } },
          },
        },
      ]);
      state.assets[assetId] = {
        assetId,
        createdAt: state.createdAt,
        displayName: "旧集视频",
        origin: "generated",
        mediaType: "video",
        mimeType: "video/mp4",
        sha256: "a".repeat(64),
        sizeBytes: 10,
        importMode: "copy",
        storage: { kind: "blob", hash: "a".repeat(64) },
        availability: "ready",
        metadata: {},
      };
      doc.episodes[1]!.final_asset_id = assetId;
      doc.jobs = [
        {
          id: "f".repeat(32),
          step: "compose",
          episodes: [2],
          request: { step: "compose", episodes: [2] },
          status: "succeeded",
          created_at: state.createdAt,
          frozen_credits: 0,
          approval_id: "old-task",
          approval_hash: "f".repeat(64),
          final_asset_id: assetId,
        },
      ];
      return { result: null, changed: true };
    });
    await read();
    const proposal = await command("drama-preview", edit),
      before = store.snapshot;
    await deleteDramaEpisode(store, { episode_no: 2, episodeOrder: 0 });
    const dir = store.directory;
    await store.close();
    store = await ProjectStore.open(dir);
    const after = store.snapshot,
      doc = dramaDocument(after)!;
    expect(after.revision).toBe(before.revision + 1);
    expect(after.canvas.revision).toBe(before.canvas.revision + 1);
    expect(after.assets).toEqual(before.assets);
    expect(doc.jobs).toEqual(dramaDocument(before)!.jobs);
    expect(doc.episodes.map((item) => [item.episode_no, item.script_md])).toEqual([
      [1, "第一集 初见\n敲门。"],
      [2, "第三集 离开\n出门。"],
    ]);
    expect(doc.episodes[1]?.revision).toBe(2);
    expect(doc.segments?.map((item) => [item.episode_no, item.id])).toEqual([[2, "3".repeat(32)]]);
    const meta = Object.fromEntries(
      projectCanvas(after.canvas).nodes.flatMap((node) =>
        node.type === "creative" && node.data.drama
          ? [[node.data.label, node.data.drama.episodes]]
          : [],
      ),
    );
    expect(meta).toEqual({
      手写信件: null,
      多集: [1, 2],
      仅二: null,
      全集: [],
      "故事板 · 第 2 集 · 01": null,
      "故事板 · 第 3 集 · 01": [2],
    });
    await expect(command("drama-apply", proposal, "old")).rejects.toMatchObject({
      code: "AGENT_APPROVAL_STALE",
    });
    await expect(command("drama-preview", edit)).rejects.toMatchObject({
      code: "AGENT_APPROVAL_STALE",
    });
    await expect(
      saveDramaScript(store, { episode_no: 2, revision: 2, script_md: "延迟写回" }),
    ).rejects.toMatchObject({ code: "AGENT_APPROVAL_STALE" });
    await expect(
      submitApprovedDramaJob(store, {} as SettingsRegistry, "writer", "old-job", {
        args: { step: "scripts", episodes: [2] },
        estimate: 0,
      }),
    ).rejects.toMatchObject({ code: "AGENT_APPROVAL_STALE" });
    await expect(
      deleteDramaEpisode(store, { episode_no: 2, episodeOrder: 0 }),
    ).rejects.toMatchObject({ code: "AGENT_APPROVAL_STALE" });
    expect(store.snapshot.revision).toBe(after.revision);
    await read();
    const fresh = await command("drama-preview", { episode_no: 2, script_md: "我是原第3集" });
    await command("drama-apply", fresh, "new");
    expect(dramaDocument(store.snapshot)!.episodes[1]?.script_md).toBe("我是原第3集");
    await deleteDramaEpisode(store, { episode_no: 2, episodeOrder: 1 });
    await deleteDramaEpisode(store, { episode_no: 1, episodeOrder: 2 });
    expect(dramaDocument(store.snapshot)!.episodes).toHaveLength(0);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("删集在事务内重新检查规划和任务，拒绝时不改画布和剧本", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-delete-busy-")),
    store = await ProjectStore.create(root, "忙碌");
  try {
    await createDrama(
      store,
      { title: "送信", script: "第一章 敲门\n送来一封信。", sourceKind: "novel" },
      [],
      [],
      () => [],
      undefined,
      { id: "764da0df-7117-448b-8dd8-f25ba29e09e6", revision: 1 },
    );
    await store.updateGeneration((state) => {
      dramaDocument(state)!.episodes.push({
        episode_no: 1,
        title: "来信",
        synopsis: "",
        script_md: "",
      });
      return { result: null, changed: true };
    });
    async function blocked(reason: string) {
      const prior = store.snapshot;
      await expect(deleteDramaEpisode(store, { episode_no: 1, episodeOrder: 0 })).rejects.toThrow(
        reason,
      );
      expect(store.snapshot.commitHash).toBe(prior.commitHash);
    }
    await blocked("正在规划，完成或暂停后再操作");
    for (const status of ["queued", "running"] as const) {
      await store.updateGeneration((state) => {
        const doc = dramaDocument(state)!;
        doc.planning!.phase = "paused";
        doc.jobs = [
          {
            id: "d".repeat(32),
            step: "breakdown",
            episodes: [1],
            request: { step: "breakdown", episodes: [1] },
            status,
            created_at: state.createdAt,
            approval_id: "pending",
            approval_hash: "1".repeat(64),
            frozen_credits: 0,
          },
        ];
        return { result: null, changed: true };
      });
      await blocked("有进行中的任务：资产拆解 · 第 1 集");
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("手写剧本以单集版本保存，其他集不冲突，旧稿与锁集不能覆盖新稿", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-paper-")),
    store = await ProjectStore.create(root, "手写剧本");
  try {
    await createDrama(store, { title: "开门", script: "门外敲了两下。" });
    await addDramaEpisode(store, { revision: 1, title: "新的一集", script_md: "" });
    await saveDramaScript(store, { episode_no: 1, revision: 1, script_md: "第一集修改" });
    const markdown = "## 夜 · 雨巷\n\n敲门。",
      save = (revision: number, script_md: string) =>
        saveDramaScript(store, { episode_no: 2, revision, script_md });
    expect((await save(1, markdown)).episodes[1]).toMatchObject({
      revision: 2,
      script_status: "ready",
      script_md: markdown,
    });
    await expect(save(1, "过期稿")).rejects.toMatchObject({ code: "AGENT_APPROVAL_STALE" });
    expect((await save(2, "")).episodes[1]).toMatchObject({
      revision: 3,
      script_status: "empty",
      script_md: "",
    });
    await store.updateGeneration((state) => {
      dramaDocument(state)!.episodes[1]!.locked = true;
      return { changed: true, result: null };
    });
    await expect(save(3, "绕过锁定")).rejects.toMatchObject({ code: "DRAMA_EPISODE_LOCKED" });
    expect(dramaDocument(store.snapshot)!.episodes.map((item) => item.script_md)).toEqual([
      "第一集修改",
      "",
    ]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("规划失败分类按冻结任务区分，只有自定义输出不合格能改用内置", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-planning-retry-"));
  const store = await ProjectStore.create(root, "重试规划");
  const model = { id: "764da0df-7117-448b-8dd8-f25ba29e09e6", revision: 1 };
  const plan = { ...model, step: "plan" as const, name: "拆章", body: "章末悬念" };
  const scripts = {
    ...plan,
    id: "185da0df-7117-448b-8dd8-f25ba29e09e6",
    step: "scripts" as const,
    name: "对白",
    body: "现在时对白",
  };
  let failure = "DRAMA_CONTEXT";
  const drafts: (string | undefined)[] = [];
  const runtime = {
    recordDramaDuration: () => {},
    agentBinding: () => ({ profile: { config: { contextWindow: 32000 } } }),
    dramaPromptText: async () => "规划",
    dramaAssetStage: async (
      _model: unknown,
      step: string,
      _variables: unknown,
      _scope: unknown,
      _signal: AbortSignal,
      draft?: string,
    ) => {
      if (step === "analyze")
        return { summary: "深夜来信", characters_md: "信使", outline_md: "拆信" };
      if (step === "plan") {
        drafts.push(draft);
        return "一集";
      }
      if (failure) throw new ProviderError(failure);
      return { episodes: [{ title: "拆信", synopsis: "信上有一行字", unit_from: 1, unit_to: 1 }] };
    },
  } as unknown as SettingsRegistry;
  const run = () => runDramaPlanning(store, runtime, new AbortController().signal);
  try {
    await createDrama(
      store,
      {
        title: "重试规划",
        sourceKind: "novel",
        script: "第一章 深夜\n拆信。",
        prompts: { plan: plan.id, scripts: scripts.id },
      },
      [],
      [],
      () => [plan, scripts],
      undefined,
      model,
    );
    await run();
    expect(dramaDocument(store.snapshot)?.planning).toMatchObject({
      phase: "paused",
      pause_code: "context",
      pause_reason: "完整提示词超过模型上下文预算",
      cursor: 0,
    });
    await expect(controlDramaPlanning(store, "retry-builtin")).rejects.toThrow(
      "仅在自定义规划输出不合格",
    );
    failure = "模型输出无法解析";
    await controlDramaPlanning(store, "resume");
    await run();
    expect(dramaDocument(store.snapshot)?.planning).toMatchObject({
      phase: "paused",
      pause_code: "custom_prompt",
      cursor: 0,
    });
    await controlDramaPlanning(store, "retry-builtin");
    await run();
    expect(dramaDocument(store.snapshot)?.planning?.pause_code).toBe("failed");
    expect(dramaDocument(store.snapshot)?.prompt_snapshots).toEqual({ scripts });
    failure = "";
    await controlDramaPlanning(store, "resume");
    await run();
    expect(dramaDocument(store.snapshot)?.planning).toMatchObject({ phase: "done", cursor: 1 });
    expect(drafts).toEqual([plan.body, plan.body, undefined, undefined]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("逐集写剧本：已提交集不重跑；后一集失败保留旧稿并禁止拆解", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-script-"));
  let store = await ProjectStore.create(root, "门廊");
  const model = { id: "764da0df-7117-448b-8dd8-f25ba29e09e6", revision: 2 };
  const prompt = {
    id: model.id,
    step: "scripts" as const,
    name: "第一版",
    body: "写信",
    revision: 1,
  };
  const source = "第一章 雨\n敲门。\n第二章 信\n拆信。";
  const firstScript = "灯灭。" + "🌙".repeat(799) + "信";
  const controller = new AbortController();
  const calls: number[] = [];
  let mode: "interrupt" | "fail" | "success" = "interrupt";
  const registry = {
    dramaJobQuote: async () => ({ model, estimate: 6 }),
    agentBinding: () => ({ profile: { config: { contextWindow: 32768 } } }),
    redact: (message: string) => message,
    dramaAssetStage: async (
      _model: unknown,
      step: string,
      variables: {
        source: string;
        episode: { no: number };
        previous_ending: string;
        known_cast: { name: string }[];
      },
      _scope: unknown,
      _signal: AbortSignal,
      body?: string,
    ) => {
      expect(step).toBe("scripts");
      const number = variables.episode.no;
      calls.push(number);
      expect(body).toBe(mode === "success" ? "新写法" : "写信");
      expect(variables.known_cast.map((entry) => entry.name)).toEqual(["湿信"]);
      if (number === 1) return firstScript;
      expect(variables.source).toBe("## [2] 第二章 信\n第二章 信\n拆信。\n");
      expect(variables.previous_ending).toBe(Array.from(firstScript).slice(-800).join(""));
      if (mode === "interrupt") {
        controller.abort();
        throw Error("项目关闭");
      }
      if (mode === "fail") throw Error("模型暂不可用");
      return "她拆开湿信。";
    },
  } as unknown as SettingsRegistry;
  try {
    await createDrama(
      store,
      { title: "门廊", script: source, sourceKind: "novel", prompts: { scripts: prompt.id } },
      [],
      [],
      () => [prompt],
      undefined,
      model,
    );
    await store.updateGeneration((state) => {
      const doc = dramaDocument(state)!;
      Object.assign(doc.planning!, { phase: "done", cursor: 2, summary: "雨夜来信" });
      doc.episodes = [1, 2].map((number) => ({
        episode_no: number,
        title: `第${number}集`,
        synopsis: "来信",
        unit_from: number,
        unit_to: number,
        script_md: number === 1 ? "" : "上一版剧本",
        revision: 1,
      }));
      mergeDramaAssets(state, [
        {
          type: "prop",
          name: "湿信",
          description: "湿了的信封",
          look: "",
          aliases: [],
          episodes: [1],
          voice_prompt: "",
        },
      ]);
      return { changed: true, result: null };
    });
    const request = { args: { step: "scripts" as const, episodes: [2, 1] }, estimate: 6 };
    const job = await submitApprovedDramaJob(store, registry, "run", "approval", request);
    await store.updateGeneration((state) => {
      dramaDocument(state)!.prompt_snapshots!.scripts!.body = "新写法";
      return { changed: true, result: null };
    });
    await runDramaAssetJob(store, registry, job.id, controller.signal);
    expect(dramaDocument(store.snapshot)?.jobs?.[0]).toMatchObject({
      done_episodes: [1],
      status: "running",
      progress: 40,
    });
    const directory = store.directory;
    await store.close();
    store = await ProjectStore.open(directory);
    await expect(
      new DramaTools().command(store, "drama-read", {
        runId: "resume",
        input: { scope: "overview" },
      }),
    ).resolves.toMatchObject({
      active_jobs: [{ id: job.id, step: "scripts", status: "running", progress: 40 }],
    });
    const [finished, pending] = dramaDocument(store.snapshot)!.episodes;
    await expect(
      saveDramaScript(store, {
        episode_no: 1,
        revision: finished!.revision,
        script_md: firstScript,
      }),
    ).resolves.toMatchObject({ status: "scripting" });
    await expect(
      saveDramaScript(store, { episode_no: 2, revision: pending!.revision, script_md: "覆写" }),
    ).rejects.toThrow("正在生成这一集的剧本");
    mode = "fail";
    await runDramaAssetJob(store, registry, job.id, new AbortController().signal);
    const doc = dramaDocument(store.snapshot)!;
    expect(doc).toMatchObject({
      status: "failed",
      jobs: [{ status: "failed", progress: 40, done_episodes: [1] }],
      episodes: [
        { script_md: firstScript, script_status: "ready" },
        { script_md: "上一版剧本", script_status: "failed" },
      ],
    });
    await expect(
      submitApprovedDramaJob(store, registry, "run", "break", {
        args: { step: "breakdown", episodes: [2] },
        estimate: 6,
      }),
    ).rejects.toMatchObject({ code: "DRAMA_STEP_NOT_READY" });
    expect((await submitApprovedDramaJob(store, registry, "run", "approval", request)).id).toBe(
      job.id,
    );
    mode = "success";
    const retry = await submitApprovedDramaJob(store, registry, "run", "retry", {
      args: { step: "scripts", episodes: [2] },
      estimate: 6,
    });
    await runDramaAssetJob(store, registry, retry.id, new AbortController().signal);
    expect(dramaDocument(store.snapshot)?.jobs?.at(-1)).toMatchObject({
      status: "succeeded",
      progress: 100,
    });
    expect(dramaDocument(store.snapshot)).toMatchObject({
      status: "ready",
      episodes: [{ script_md: firstScript }, { script_md: "她拆开湿信。", script_status: "ready" }],
    });
    expect(calls).toEqual([1, 2, 2, 2]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("资产拆解按原始批次数计进度；第二批中断重开不重复第一批或提前到100%", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-batch-progress-"));
  let store = await ProjectStore.create(root, "十三集");
  const model = { id: "764da0df-7117-448b-8dd8-f25ba29e09e6", revision: 1 },
    controller = new AbortController(),
    scopes: number[][] = [];
  let interrupt = true;
  const overview = () =>
    new DramaTools().command(store, "drama-read", {
      runId: "observer",
      input: { scope: "overview" },
    });
  const registry = {
    dramaJobQuote: async () => ({ model, estimate: 2 }),
    agentBinding: () => ({ profile: { config: { contextWindow: 32768 } } }),
    redact: (message: string) => message,
    async dramaAssetStage(
      _model: unknown,
      step: string,
      _vars: unknown,
      scope: { episodes: number[]; nodes: string[] },
    ) {
      if (step === "breakdown") {
        scopes.push(scope.episodes);
        if (scope.episodes[0] === 13) {
          await expect(overview()).resolves.toMatchObject({ active_jobs: [{ progress: 40 }] });
          if (interrupt) {
            controller.abort();
            throw Error("项目关闭");
          }
        }
        return "资产草稿";
      }
      if (step === "breakdown_format")
        return {
          assets: [
            {
              type: "prop",
              name: `信封${scope.episodes[0]}`,
              look: "",
              description: "信封",
              aliases: [],
              voice_prompt: "",
              episodes: scope.episodes,
            },
          ],
        };
      if (step === "asset_prompts") {
        const job = dramaDocument(store.snapshot)?.jobs?.at(-1);
        expect(job?.progress).toBe(scopes.at(-1)?.[0] === 13 ? 70 : 30);
        expect(job?.done_episodes?.length).toBe(scopes.at(-1)?.[0] === 13 ? 13 : 12);
        return "写信封";
      }
      return { prompts: scope.nodes.map((node_id) => ({ node_id, prompt: "信封特写" })) };
    },
  } as unknown as SettingsRegistry;
  try {
    const numbers = Array.from({ length: 13 }, (_, index) => index + 1);
    await createDrama(store, {
      title: "十三集",
      script: numbers.map((no) => `第${no}集 送信\n门口的来信。`).join("\n"),
    });
    const job = await submitApprovedDramaJob(store, registry, "writer", "batch", {
      args: { step: "breakdown", episodes: numbers },
      estimate: 2,
    });
    await runDramaAssetJob(store, registry, job.id, controller.signal);
    const directory = store.directory;
    await store.close();
    store = await ProjectStore.open(directory);
    expect(dramaDocument(store.snapshot)?.jobs?.[0]).toMatchObject({
      status: "running",
      done_episodes: numbers.slice(0, 12),
      progress: 40,
    });
    interrupt = false;
    await runDramaAssetJob(store, registry, job.id, new AbortController().signal);
    expect(scopes).toEqual([numbers.slice(0, 12), [13], [13]]);
    expect(dramaDocument(store.snapshot)?.jobs?.[0]).toMatchObject({
      status: "succeeded",
      done_episodes: numbers,
      progress: 100,
    });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("主动取消拆解只保留已提交批次，重开不继续被取消的后一批", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-cancel-batch-"));
  let store = await ProjectStore.create(root, "十三封信");
  const episodes = Array.from({ length: 13 }, (_, index) => index + 1),
    scopes: number[][] = [];
  let secondSignal: AbortSignal | undefined;
  const registry = {
    dramaJobQuote: async () => ({
      model: { id: "764da0df-7117-448b-8dd8-f25ba29e09e6", revision: 1 },
      estimate: 2,
    }),
    agentBinding: () => ({ profile: { config: { contextWindow: 32768 } } }),
    redact: (message: string) => message,
    async dramaAssetStage(
      _model: unknown,
      step: string,
      _vars: unknown,
      scope: { episodes: number[]; nodes: string[] },
      signal: AbortSignal,
    ) {
      if (step === "breakdown") {
        scopes.push(scope.episodes);
        if (scope.episodes.includes(13)) {
          secondSignal = signal;
          return new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        }
        return "一封信";
      }
      if (step === "breakdown_format")
        return {
          assets: [
            {
              type: "prop",
              name: "信封",
              look: "",
              description: "来信",
              aliases: [],
              voice_prompt: "",
              episodes: scope.episodes,
            },
          ],
        };
      if (step === "asset_prompts") return "写信封";
      return { prompts: scope.nodes.map((node_id) => ({ node_id, prompt: "红色信封" })) };
    },
  } as unknown as SettingsRegistry;
  const agent = new CanvasAgentService(null as never, async () => registry);
  try {
    await createDrama(store, {
      title: "十三封信",
      script: episodes.map((no) => `第${no}集 送信\n门口的来信。`).join("\n"),
    });
    const job = await submitApprovedDramaJob(store, registry, "writer", "cancel-batch", {
      args: { step: "breakdown", episodes },
      estimate: 2,
    });
    agent.attach(store);
    await expect.poll(() => secondSignal?.aborted).toBe(false);
    await agent.cancelStudioJob(store, job.id, "breakdown");
    expect(secondSignal!.aborted).toBe(true);
    const hash = store.snapshot.commitHash;
    await agent.cancelStudioJob(store, job.id, "breakdown");
    expect(store.snapshot.commitHash).toBe(hash);
    const directory = store.directory;
    agent.detach(store);
    await store.close();
    store = await ProjectStore.open(directory);
    agent.attach(store);
    await runDramaAssetJob(store, registry, job.id, new AbortController().signal);
    const doc = dramaDocument(store.snapshot)!;
    expect(doc.jobs?.[0]).toMatchObject({
      status: "canceled",
      done_episodes: episodes.slice(0, 12),
      progress: 40,
    });
    expect(doc.episodes.filter((ep) => ep.locked).map((ep) => ep.episode_no)).toEqual(
      episodes.slice(0, 12),
    );
    expect(scopes).toEqual([episodes.slice(0, 12), [13]]);
    expect(
      projectCanvas(store.snapshot.canvas).nodes.filter(
        (node) => node.type === "creative" && node.data.text === "红色信封",
      ),
    ).toHaveLength(1);
  } finally {
    agent.detach(store);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("小说第二批中断后重开只恢复冻结批次，失败保持第一批与编辑", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-planning-"));
  let store = await ProjectStore.create(root, "夜信");
  const script = Array.from(
    { length: 14 },
    (_, index) => `第${index + 1}章 来信\n第${index + 1}封信到了。`,
  ).join("\n");
  const model = { id: "764da0df-7117-448b-8dd8-f25ba29e09e6", revision: 3 };
  const replacement = { id: "764da0df-7117-448b-8dd8-f25ba29e09e7", revision: 7 };
  const stages: string[] = [];
  const controller = new AbortController();
  let mode: "interrupt" | "fail" | "finish" = "interrupt";
  const runtime = {
    recordDramaDuration: () => {},
    agentBinding: () => ({ profile: { config: { contextWindow: 32000 } } }),
    dramaPromptText: async () => "目录",
    async dramaAssetStage(
      binding: typeof model,
      step: string,
      input: Record<string, string>,
      scope: { unit_from: number; unit_to: number },
    ) {
      expect(binding).toEqual(mode === "finish" ? replacement : model);
      stages.push(`${step}:${scope.unit_from ?? 0}`);
      if (step === "analyze") {
        expect(input.source).toContain("## [14]");
        return {
          source_kind: "script",
          summary: "十四封信",
          characters_md: "信使",
          outline_md: "雨夜来信",
        };
      }
      if (step === "plan") {
        if (scope.unit_from === 13) {
          expect(input.source).toContain("## [13]");
          expect(input.source).not.toContain("## [14]");
          expect(input.previous_cliffhanger).toBe("信封未拆");
          if (mode === "interrupt") {
            controller.abort();
            throw Error("项目关闭");
          }
          if (mode === "fail") throw Error("模型请求失败");
        }
        return "分集目录";
      }
      await expect(
        new DramaTools().command(store, "drama-read", {
          runId: "formatting",
          input: { scope: "overview" },
        }),
      ).resolves.toMatchObject({
        active_jobs: [{ step: "plan", batch_from: scope.unit_from, progress: 50 }],
      });
      return {
        episodes: [
          {
            title: "来信",
            synopsis: "敲门",
            hook: "谁在门外",
            cliffhanger: "信封未拆",
            unit_from: scope.unit_from,
            unit_to: scope.unit_to,
          },
        ],
      };
    },
  } as unknown as SettingsRegistry;
  try {
    await createDrama(
      store,
      { sourceKind: "novel", rangeEnd: 13, title: "夜信", script },
      [],
      [],
      undefined,
      undefined,
      model,
    );
    expect(dramaDocument(store.snapshot)?.episodes).toEqual([]);
    await runDramaPlanning(store, runtime, controller.signal);
    const saved = dramaDocument(store.snapshot)!;
    expect(saved.planning).toMatchObject({
      summary: "十四封信",
      cursor: 12,
      end: 13,
      phase: "running",
      pending: { from: 13, to: 13 },
    });
    expect(saved.episodes).toHaveLength(1);
    await updateDramaBoardSettings(
      store,
      { revision: 1, settings: { textModel: replacement.id, sceneModel: "", boardModel: "" } },
      [],
      [replacement],
    );
    await expect(
      new DramaTools().command(store, "drama-read", {
        runId: "planning",
        input: { scope: "overview" },
      }),
    ).resolves.toMatchObject({
      active_jobs: [{ step: "plan", lane: "pipeline", batch_from: 13, batch_to: 13 }],
    });
    await store.updateGeneration((state) => {
      const first = dramaDocument(state)!.episodes[0]!;
      first.title = "手改来信";
      return { changed: true, result: null };
    });
    const directory = store.directory;
    await store.close();
    store = await ProjectStore.open(directory);
    expect(dramaDocument(store.snapshot)?.planning?.pending).toEqual(saved.planning?.pending);
    mode = "fail";
    await runDramaPlanning(store, runtime, new AbortController().signal);
    expect(dramaDocument(store.snapshot)?.planning).toMatchObject({
      phase: "paused",
      cursor: 12,
      pause_code: "failed",
    });
    expect(dramaDocument(store.snapshot)?.episodes).toHaveLength(1);
    await controlDramaPlanning(store, "resume");
    await expect(controlDramaPlanning(store, "resume")).rejects.toThrow("当前规划阶段");
    mode = "finish";
    await runDramaPlanning(store, runtime, new AbortController().signal);
    expect(stages).toEqual([
      "analyze:0",
      "plan:1",
      "plan_format:1",
      "plan:13",
      "plan:13",
      "plan:13",
      "plan_format:13",
    ]);
    await expect(
      new DramaTools().command(store, "drama-read", {
        runId: "after-open",
        input: { scope: "overview" },
      }),
    ).resolves.toMatchObject({
      source_kind: "novel",
      status: "outlined",
      phase: "done",
      plan_cursor: 13,
      range_end: 13,
      units_total: 14,
      episodes: [
        { no: 1, title: "手改来信", unit_from: 1, unit_to: 12, script_status: "empty" },
        { no: 2, unit_from: 13, unit_to: 13, script_status: "empty" },
      ],
    });
    const before = dramaDocument(store.snapshot)!;
    const registry = Object.assign(runtime, {
      withDramaTextModel: async <Result>(
        preferred: string,
        quote: (model: typeof replacement) => Promise<Result>,
      ) => {
        expect(preferred).toBe(replacement.id);
        return quote(replacement);
      },
      dramaQuoteForModel: async () => 1,
      dramaStepSeconds: () => 60,
    });
    const both = await Promise.allSettled([
      extendDramaPlanning(store, registry, 0, 13),
      extendDramaPlanning(store, registry, 14, 13),
    ]);
    expect(both.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(both[1]).toMatchObject({
      reason: { code: "DRAMA_STEP_NOT_READY", message: "规划范围已改变" },
    });
    expect(dramaDocument(store.snapshot)).toMatchObject({
      revision: before.revision + 1,
      episodes: before.episodes,
      planning: { phase: "running", end: 14, cursor: 13, summary: "十四封信" },
    });
    await runDramaPlanning(store, runtime, new AbortController().signal);
    expect(stages.slice(7)).toEqual(["plan:14", "plan_format:14"]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("按角色推导比例；模型收窄枚举拒绝建剧，拆解沿用已保存参数", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-param-"));
  const store = await ProjectStore.create(root, "道具");
  try {
    const fields = {
      ratios: ["9:16", "3:2", "21:9"],
      resolutions: ["1K", "2K"],
      defaultRatio: "9:16",
      defaultResolution: "2K",
    };
    const prop = settleDramaImageParams(fields, "prop", { resolution: "8K" });
    expect(prop).toEqual({ aspectRatio: "3:2", resolution: "2K" });
    expect(settleDramaImageParams(fields, "scene")).toMatchObject({ aspectRatio: "21:9" });
    const request = { title: "来客", script: "第一集\n来客", imageParams: { prop } };
    const id = "764da0df-7117-448b-8dd8-f25ba29e09e6";
    const models = [{ id, fields: { ...fields, resolutions: ["1K"] } }];
    await expect(
      createDrama(
        store,
        { ...request, imageModels: { character: "", scene: "", prop: id } },
        models,
      ),
    ).rejects.toThrow("物品图片参数不可用");
    expect(dramaDocument(store.snapshot)).toBeNull();
    await createDrama(store, request, models);
    expect(dramaDocument(store.snapshot)?.image_params).toEqual({ prop });
    await store.updateGeneration((state) => {
      mergeDramaAssets(state, [
        {
          type: "prop",
          name: "信",
          look: "",
          description: "",
          aliases: [],
          episodes: [1],
          voice_prompt: "",
        },
      ]);
      return { changed: true, result: null };
    });
    expect(projectCanvas(store.snapshot.canvas).nodes[0]).toMatchObject({
      data: { generation: { params: prop } },
    });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("开拍时图像或视频模型下线则不建剧，重新选择按用途写入", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-start-images-"));
  const store = await ProjectStore.create(root, "模型选择");
  try {
    const character = "764da0df-7117-448b-8dd8-f25ba29e09e6",
      scene = "764da0df-7117-448b-8dd8-f25ba29e09e7";
    const video = "764da0df-7117-448b-8dd8-f25ba29e09e8";
    const request = {
      title: "来信",
      script: "第一集\n门开了。",
      videoModel: video,
      imageModels: { character, scene, prop: "" },
    };
    await expect(createDrama(store, request, [{ id: scene }])).rejects.toThrow(
      "所选图片模型不可用",
    );
    expect(dramaDocument(store.snapshot)).toBeNull();
    await expect(createDrama(store, request, [{ id: scene }, { id: character }])).rejects.toThrow(
      "所选视频模型不可用",
    );
    await expect(
      createDrama(store, { title: "来信", script: "来信", styleKey: "custom", styleCustom: "  " }),
    ).rejects.toThrow("自定义画风须为1至500字");
    await expect(
      createDrama(store, { title: "来信", script: "来信", styleKey: "unknown" }),
    ).rejects.toThrow("画风不存在");
    expect(dramaDocument(store.snapshot)).toBeNull();
    await createDrama(store, request, [{ id: scene }, { id: character }], [{ id: video }]);
    expect(dramaDocument(store.snapshot)?.video_model).toBe(video);
    expect(dramaDocument(store.snapshot)?.style_key).toBe("real_city_film");
    await expect(
      new DramaTools().command(store, "drama-read", {
        runId: "start",
        input: { scope: "overview" },
      }),
    ).resolves.toMatchObject({
      video_model: video,
      style_key: "real_city_film",
      image_models: { character, scene, prop: "" },
    });
    expect(dramaDocument(store.snapshot)?.board_settings).toMatchObject({
      characterModel: character,
      sceneModel: scene,
      propModel: "",
      boardModel: "",
    });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("切换任务模型时按原稿单元和标题计算容量，失败保留旧设置", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-context-"));
  const store = await ProjectStore.create(root, "换模容量");
  try {
    const title = "第二集 月下";
    const script = `第一集\n门开了。\n${title}\n${"🌙".repeat(300)}`;
    await createDrama(store, { title: "月下", script });
    await store.updateGeneration((state) => {
      dramaDocument(state)!.episodes[1]!.script_md = "精简版";
      return { changed: true, result: null };
    });
    const textModel = "764da0df-7117-448b-8dd8-f25ba29e09e6";
    const request = { revision: 1, settings: { textModel, boardModel: "", sceneModel: "" } };
    const threshold = Array.from(`## [2] ${title}\n\n${title}\n`).length + 300;
    const choose = (chars: number) =>
      updateDramaBoardSettings(
        store,
        request,
        [],
        [
          {
            id: textModel,
            config: {
              name: "文本",
              kind: "agent",
              description: "",
              sort: 0,
              contextWindow: Math.ceil((8192 + chars) / 0.6),
            },
          },
        ],
      );
    const revision = store.snapshot.revision;
    await expect(choose(threshold - 1)).rejects.toMatchObject({
      code: "DRAMA_CONTEXT",
      message: expect.stringContaining(`「${title}」约 ${threshold} 字`),
    });
    expect(store.snapshot.revision).toBe(revision);
    await expect(choose(threshold)).resolves.toMatchObject({ board_settings: { textModel } });
    await expect(
      new DramaTools().command(store, "drama-read", {
        runId: "model",
        input: { scope: "overview" },
      }),
    ).resolves.toMatchObject({ text_model: textModel });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("故事板项目设置独立检查修订，小灵读到指定的图片模型，已有节点保留原稿", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-board-settings-"));
  const store = await ProjectStore.create(root, "项目设置");
  const settings = { sceneModel: "", boardModel: "", template: "水彩{{画面}}" };
  const fields = {
    ratios: [],
    resolutions: [],
    defaultRatio: undefined,
    defaultResolution: undefined,
  };
  const models = [
    {
      id: "32514673-e9fe-440f-b715-5bc167b3ce7a",
      fields,
      options: modelGenerationOptions("image", "openai-image", "gpt-image-1"),
    },
  ];
  try {
    const doc = await createDrama(store, { title: "项目设置", script: "推门。" });
    const empty = await updateDramaBoardSettings(
      store,
      { revision: 1, settings: { sceneModel: "", boardModel: "" } },
      models,
    );
    expect(empty.revision).toBe(doc.revision);
    await store.updateGeneration((state) => {
      syncDramaBoards(state, 1, [
        { id: "one", episode_no: 1, seq: 0, seconds: 5, prompt: "推门。", revision: 1 },
      ]);
      return { changed: true, result: null };
    });
    const canvas = store.snapshot.canvas;
    settings.sceneModel = "32514673-e9fe-440f-b715-5bc167b3ce7a";
    const saved = await updateDramaBoardSettings(store, { revision: 1, settings }, models);
    expect(saved.board_settings_revision).toBe(2);
    await expect(
      updateDramaBoardSettings(store, { revision: 1, settings }, models),
    ).rejects.toMatchObject({ code: "AGENT_APPROVAL_STALE" });
    await expect(
      updateDramaBoardSettings(
        store,
        { revision: 2, settings: { ...settings, template: "无画面" } },
        models,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const repeated = await updateDramaBoardSettings(store, { revision: 2, settings }, models);
    expect(repeated.revision).toBe(saved.revision);
    expect(store.snapshot.canvas).toEqual(canvas);
    const tools = new DramaTools();
    const read = await tools.command(store, "drama-read", {
      runId: "settings",
      input: { scope: "overview" },
    });
    expect(read).toMatchObject({
      image_models: { character: "", prop: "", scene: settings.sceneModel },
    });
    expect(JSON.stringify(read)).not.toContain(settings.template);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("故事板按集同步，保留仍在的节点并清理已移除片段的连线", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-board-sync-"));
  const store = await ProjectStore.create(root, "故事板");
  const prompt =
    "【时间轴】\n" +
    Array.from({ length: 5 }, (_, index) => `${index}-${index + 1}秒：推门。`).join("\n");
  const first = { id: "one", episode_no: 1, seq: 0, seconds: 5, prompt, revision: 1 };
  const second = { ...first, id: "two", episode_no: 2 };
  try {
    await store.updateGeneration((state) => {
      syncDramaBoards(state, 1, [first, second]);
      syncDramaBoards(state, 2, [first, second]);
      const [old, kept] = projectCanvas(state.canvas).nodes;
      if (old?.type !== "creative" || kept?.type !== "creative") throw Error("缺少故事板");
      expect(kept).toMatchObject({
        position: { x: 0, y: 420 },
        data: { drama: { board: { segmentId: "two", layout: "3x2", shotCount: 5 } } },
      });
      const edited = { ...kept, data: { ...kept.data, label: "确认过的故事板" } };
      state.canvas = applyCanvas(state, [
        { type: "putNode", node: edited },
        { type: "putEdge", edge: { id: "link", source: kept.id, target: old.id } },
      ]);
      const revision = state.canvas.revision;
      syncDramaBoards(state, 2, [{ ...second, prompt: "改过的原稿" }]);
      expect(state.canvas.revision).toBe(revision);
      syncDramaBoards(state, 1, [{ ...first, id: "replacement" }, second]);
      const graph = projectCanvas(state.canvas);
      expect(graph.edges).toEqual([]);
      expect(graph.nodes).toHaveLength(2);
      expect(graph.nodes).toContainEqual(edited);
      expect(graph.nodes.map((node) => node.id)).not.toContain(old.id);
      return { changed: true, result: null };
    });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("小灵按集读到分镜排队、失败和就绪状态", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-board-status-"));
  const store = await ProjectStore.create(root, "邻居");
  const tools = new DramaTools();
  const read = (episode_no: number) =>
    tools.command(store, "drama-read", { runId: "read", input: { scope: "episode", episode_no } });
  let fail = true;
  const bodies: (string | undefined)[] = [];
  const registry = {
    dramaJobQuote: async () => ({ model: { id: "text", revision: 1 }, estimate: 14 }),
    agentBinding: () => ({ profile: { config: {} } }),
    redact: (message: string) => message,
    dramaAssetStage: async (
      _model: unknown,
      step: string,
      _input: unknown,
      _scope: unknown,
      _signal: AbortSignal,
      body?: string,
    ) => {
      bodies.push(body);
      if (step === "storyboard") return "第一集草稿";
      if (fail) throw Error("模型输出无法解析");
      return { segments: [{ seconds: 6, prompt: "门开了" }] };
    },
  } as unknown as SettingsRegistry;
  try {
    const video = {
      step: "video" as const,
      id: "764da0df-7117-448b-8dd8-f25ba29e09e6",
      name: "快照",
      revision: 1,
      body: "先拍信封",
    };
    await createDrama(
      store,
      { title: "邻居", script: "敲门", prompts: { video: video.id } },
      [],
      [],
      () => [video],
    );
    await addDramaEpisode(store, { revision: 1, title: "第二集", script_md: "见面" });
    await store.updateGeneration((state) => {
      dramaDocument(state)!.episodes[0]!.locked = true;
      return { changed: true, result: null };
    });
    await expect(read(1)).resolves.toMatchObject({ storyboard_status: "empty" });
    for (const outcome of ["failed", "ready"] as const) {
      fail = outcome === "failed";
      const job = await submitApprovedDramaJob(store, registry, "run", outcome, {
        args: { step: "storyboard", episodes: [1] },
        estimate: 14,
      });
      if (fail)
        await store.updateGeneration((state) => {
          delete dramaDocument(state)!.prompt_snapshots!.video;
          return { changed: true, result: null };
        });
      await expect(read(1)).resolves.toMatchObject({ storyboard_status: "generating" });
      await runDramaAssetJob(store, registry, job.id, new AbortController().signal);
      await expect(read(1)).resolves.toMatchObject({ storyboard_status: outcome });
      await expect(read(2)).resolves.toMatchObject({ storyboard_status: "empty" });
    }
    expect(bodies).toEqual(["先拍信封", undefined, undefined, undefined]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("覆盖已有视频的分镜：确认绑定片段版本和报价，失败不删除，重复提交不重清", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-redo-")),
    store = await ProjectStore.create(root, "重做");
  const videoModel = "07020702-0000-4000-8000-000000000001";
  let available = true;
  const registry = {
    list: () => ({
      plugins: [
        { hash: "video", kind: "video", key: "doubao-video", origin: "builtin", auth: "none" },
      ],
      providers: [
        {
          id: videoModel,
          enabled: available,
          pluginHash: "video",
          model: "doubao-seedance-2-0",
          channel: {},
          config: { kind: "video", refs: { audio: { max: 2, mb: 10 } } },
        },
      ],
    }),
    dramaJobQuote: async () => ({ model: { id: "text", revision: 1 }, estimate: 14 }),
  } as unknown as SettingsRegistry;
  const assetId = "927c4701-3bc2-42cf-b1f5-4c387428cb60",
    args = {
      step: "storyboard" as const,
      episodes: [1],
      video_model: videoModel,
      max_seconds: 15,
      max_audios: 99,
    };
  const submit = (clearHash?: string, estimate = 14) =>
    submitApprovedDramaJob(store, registry, "workspace", "workspace:redo", {
      args,
      estimate,
      ...(clearHash && { clearHash }),
    });
  try {
    await createDrama(store, { title: "重做", script: "第一集 进站\n下雨。\n第二集 出站\n天晴。" });
    await store.updateGeneration((state) => {
      const doc = dramaDocument(state)!;
      for (const episode of doc.episodes) {
        episode.locked = true;
        episode.storyboard_status = "ready";
      }
      doc.segments = [1, 2].map((no) => ({
        id: String(no).repeat(32),
        episode_no: no,
        seq: 0,
        revision: 1,
        seconds: 5,
        prompt: "站台",
        take_ids: [`take-${no}`],
      }));
      for (const no of [1, 2]) syncDramaBoards(state, no, doc.segments);
      state.assets[assetId] = {
        assetId,
        createdAt: state.createdAt,
        displayName: "站台视频",
        origin: "generated",
        mediaType: "video",
        mimeType: "video/mp4",
        sha256: "a".repeat(64),
        sizeBytes: 10,
        importMode: "copy",
        storage: { kind: "blob", hash: "a".repeat(64) },
        availability: "ready",
        metadata: {},
      };
      return { changed: true, result: null };
    });
    const stale = storyboardClearHash(dramaDocument(store.snapshot)!, 1);
    await store.updateGeneration((state) => {
      const segment = dramaDocument(state)!.segments![0]!;
      segment.prompt = "雨中的站台";
      segment.revision++;
      return { changed: true, result: null };
    });
    const before = store.snapshot,
      hash = storyboardClearHash(dramaDocument(before)!, 1);
    await expect(submit()).rejects.toMatchObject({ code: "DRAMA_STORYBOARD_HAS_TAKES" });
    await expect(submit(stale)).rejects.toMatchObject({ code: "AGENT_APPROVAL_STALE" });
    await expect(submit(hash, 13)).rejects.toMatchObject({ code: "AGENT_APPROVAL_STALE" });
    const preview = { ...dramaDocument(before)!, segments: [] };
    await expect(estimateDramaJob(preview, args, registry)).resolves.toMatchObject({
      storyboardLimits: { max_audios: 2 },
    });
    available = false;
    await expect(estimateDramaJob(preview, args, registry)).rejects.toThrow("所选视频模型已不可用");
    await expect(submit(hash)).rejects.toThrow("所选视频模型已不可用");
    available = true;
    expect(store.snapshot).toEqual(before);
    const job = await submit(hash),
      after = store.snapshot;
    expect(job.request).toMatchObject({ video_model: videoModel, max_seconds: 15, max_audios: 2 });
    expect(after.assets).toEqual(before.assets);
    expect(dramaDocument(after)!.segments).toEqual(dramaDocument(before)!.segments!.slice(1));
    expect(projectCanvas(after.canvas).nodes).toEqual(
      projectCanvas(before.canvas).nodes.filter(
        (node) => node.type === "creative" && node.data.drama?.episodes?.includes(2),
      ),
    );
    expect((await submit(hash)).id).toBe(job.id);
    expect(store.snapshot).toEqual(after);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("资产换模只处理分类且未出图的卡片，拆解新卡继承设置", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-asset-model-"));
  const store = await ProjectStore.create(root, "资产");
  const fallback = "764da0df-7117-448b-8dd8-f25ba29e09e6";
  const picked = "920cc312-337f-4b8d-b149-06321987393c";
  const fields = {
    ratios: [],
    resolutions: [],
    defaultRatio: undefined,
    defaultResolution: undefined,
  };
  const models = [fallback, picked].map((id) => ({
    id,
    fields,
    options: modelGenerationOptions("image", "openai-image", "gpt-image-1"),
  }));
  const scene = (name: string): DramaAsset => ({
    type: "scene",
    name,
    episodes: [1],
    aliases: [],
    description: "空镜",
    look: "",
    voice_prompt: "",
  });
  try {
    await createDrama(store, {
      title: "资产",
      script: "推门。",
      imageParams: {
        scene: { aspectRatio: "21:9", resolution: "4K" },
        prop: { aspectRatio: "1:1" },
      },
    });
    await store.updateGeneration((state) => {
      const created = mergeDramaAssets(
        state,
        ["未生成", "失败", "排队", "用户上传", "未分类", "已出图"].map(scene),
      );
      const assetId = "927c4701-3bc2-42cf-b1f5-4c387428cb60";
      state.assets[assetId] = {
        assetId,
        createdAt: state.createdAt,
        displayName: "布景.png",
        origin: "generated",
        mediaType: "image",
        mimeType: "image/png",
        sha256: "a".repeat(64),
        sizeBytes: 10,
        importMode: "copy",
        storage: { kind: "blob", hash: "a".repeat(64) },
        availability: "ready",
        metadata: {},
      };
      for (const { node_id, asset } of created) {
        const node = projectCanvas(state.canvas).nodes.find((node) => node.id === node_id);
        if (node?.type !== "creative" || !node.data.drama || !("type" in node.data.drama))
          throw Error("缺少测试资产");
        node.data.generation = {
          providerId: fallback,
          params: { quality: "high", negativePrompt: "旧模型参数" },
        };
        if (asset.name === "未分类") node.data.drama.episodes = null;
        if (asset.name === "用户上传") node.data.uploaded = true;
        if (asset.name === "已出图") node.data.assetId = assetId;
        if (["排队", "失败"].includes(asset.name))
          state.jobs[node_id] = {
            nodeId: node_id,
            status: asset.name === "排队" ? "queued" : "failed",
          };
        state.canvas = applyCanvas(state, [{ type: "putNode", node }]);
      }
      return { changed: true, result: null };
    });
    const settings = { boardModel: "", sceneModel: picked };
    const before = store.snapshot.revision;
    await expect(
      updateDramaBoardSettings(store, { revision: 1, settings }, models.slice(0, 1)),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(store.snapshot.revision).toBe(before);
    await updateDramaBoardSettings(store, { revision: 1, settings }, models);
    expect(dramaDocument(store.snapshot)?.image_params).toEqual({ prop: { aspectRatio: "1:1" } });
    await store.updateGeneration((state) => {
      mergeDramaAssets(state, [scene("后来拆解")]);
      return { changed: true, result: null };
    });
    for (const node of projectCanvas(store.snapshot.canvas).nodes) {
      if (node.type !== "creative") throw Error("缺少测试资产");
      const switched = ["未生成", "失败"].includes(node.data.label ?? "");
      expect(node.data.generation?.providerId).toBe(
        switched || node.data.label === "后来拆解" ? picked : fallback,
      );
      if (switched) expect(node.data.generation?.params).toEqual({ quality: "high" });
      if (node.data.label === "后来拆解") expect(node.data.generation?.params).toBeUndefined();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("跨集别名复用资产，保留确认的形象和提示词", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-asset-merge-"));
  const store = await ProjectStore.create(root, "邻居");
  try {
    const asset: DramaAsset = {
      type: "character",
      name: "林宁",
      look: "",
      aliases: ["小林"],
      description: "灰色外套",
      voice_prompt: "说话轻缓",
      episodes: [1],
    };
    await store.updateGeneration((state) => {
      const [entry] = mergeDramaAssets(state, [asset]);
      const node = projectCanvas(state.canvas).nodes.find((item) => item.id === entry?.node_id);
      if (node?.type !== "creative") throw Error("缺少角色节点");
      state.canvas = applyCanvas(state, [
        { type: "putNode", node: { ...node, data: { ...node.data, text: "用户确认的提示词" } } },
      ]);
      return { changed: true, result: null };
    });
    await store.updateGeneration((state) => {
      const created = mergeDramaAssets(state, [
        { ...asset, name: "小林", aliases: ["阿宁"], episodes: [2], description: "另一种描述" },
      ]);
      expect(created).toEqual([]);
      return { changed: true, result: null };
    });
    expect(projectCanvas(store.snapshot.canvas).nodes).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          label: "林宁",
          text: "用户确认的提示词",
          character: expect.objectContaining({ look: "基础形象", description: "灰色外套" }),
          drama: expect.objectContaining({
            name: "林宁",
            aliases: ["小林", "阿宁"],
            episodes: [1, 2],
          }),
        }),
      }),
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("短剧写入需要同一运行先读，审批重放幂等，过期修改不覆盖，重开仍可读取", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-drama-store-"));
  let store = await ProjectStore.create(root, "第一部");
  const tools = new DramaTools();
  try {
    const args = {
      runId: "run-1",
      kind: "drama_update_episode",
      input: { episode_no: 1, script_md: "结尾二" },
    };
    await expect(
      tools.command(store, "drama-read", { runId: "run-1", input: { scope: "overview" } }),
    ).rejects.toMatchObject({ code: "AGENT_SCOPE_DENIED" });
    await createDrama(store, { title: "第一部", script: "结尾一" });
    await expect(tools.command(store, "drama-preview", args)).rejects.toMatchObject({
      code: "AGENT_APPROVAL_STALE",
    });
    await tools.command(store, "drama-read", {
      runId: "run-1",
      input: { scope: "episode", episode_no: 1 },
    });
    await expect(
      tools.command(store, "drama-preview", { ...args, runId: "run-2" }),
    ).rejects.toMatchObject({ code: "AGENT_APPROVAL_STALE" });
    const proposal = await tools.command(store, "drama-preview", args);
    expect(dramaDocument(store.snapshot)?.revision).toBe(1);
    const apply = { ...args, id: "approval-1", input: proposal };
    await tools.command(store, "drama-apply", apply);
    await tools.command(store, "drama-apply", apply);
    await expect(
      tools.command(store, "drama-apply", { ...apply, id: "approval-2" }),
    ).rejects.toMatchObject({ code: "AGENT_APPROVAL_STALE" });
    const dir = store.directory;
    await store.close();
    store = await ProjectStore.open(dir);
    expect(dramaDocument(store.snapshot)).toMatchObject({
      revision: 2,
      episodes: [{ script_md: "结尾二" }],
    });
    const withSegment = await addDramaSegment(store, {
      revision: 2,
      episode_no: 1,
      prompt: "门前停住",
      seconds: 5,
    });
    const segment = withSegment.segments?.[0];
    if (!segment) throw new Error("缺少片段");
    const edit = {
      runId: "run-1",
      kind: "drama_update_segment",
      input: { segment_id: segment.id, prompt: "门缓缓打开", seconds: 8 },
    };
    await expect(tools.command(store, "drama-preview", edit)).rejects.toMatchObject({
      code: "AGENT_APPROVAL_STALE",
    });
    const list = await tools.command(store, "drama-read", {
      runId: "run-1",
      input: { scope: "segments", episode_no: 1 },
    });
    expect(list).toEqual([
      { ...segment, status: "idle", adaptations: {}, takes: [], chosen_task_id: "" },
    ]);
    const change = await tools.command(store, "drama-preview", edit);
    expect(change).toMatchObject({
      before: { prompt: "门前停住", seconds: 5 },
      after: { prompt: "门缓缓打开", seconds: 8 },
    });
    const commit = { ...edit, id: "segment-approval", input: change };
    expect(await tools.command(store, "drama-receipt", commit)).toBeNull();
    await tools.command(store, "drama-apply", commit);
    await tools.command(store, "drama-apply", commit);
    await store.close();
    store = await ProjectStore.open(dir);
    expect(dramaDocument(store.snapshot)).toMatchObject({
      revision: 4,
      segments: [{ id: segment.id, revision: 2, seconds: 8, prompt: "门缓缓打开" }],
    });
    expect(await tools.command(store, "drama-receipt", commit)).toEqual({ applied: true });
    expect(
      await tools.command(store, "drama-receipt", { ...commit, runId: "another-run" }),
    ).toBeNull();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("旧项目的大纲审批跨分集与片段变更仍可提交，同一版大纲只能改一次", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-drama-overview-"));
  let store = await ProjectStore.create(root, "回声");
  try {
    await createDrama(store, { title: "回声", script: "第一集\n进门\n第二集\n关门" });
    await store.updateGeneration((state) => {
      const doc = dramaDocument(state)!;
      delete doc.overview_revision;
      doc.revision = 7;
      return { changed: true, result: null };
    });
    const tools = new DramaTools();
    const runId = "outline";
    const kind = "drama_update_outline";
    const read = () => tools.command(store, "drama-read", { runId, input: { scope: "overview" } });
    const propose = (outline_md: string) =>
      tools.command(store, "drama-preview", { runId, kind, input: { outline_md } });
    const apply = (id: string, input: unknown) =>
      tools.command(store, "drama-apply", { runId, kind, id, input });
    await expect(read()).resolves.toMatchObject({
      revision: 7,
      phase: "done",
      status: "ready",
      plan_cursor: 2,
      range_end: 2,
    });
    const pending = await propose("在门口重逢");
    await addDramaSegment(store, { revision: 7, episode_no: 2, prompt: "走廊", seconds: 5 });
    const competing = await propose("在路口重逢");
    await addDramaEpisode(store, { revision: 8, title: "尾声", script_md: "" });
    const directory = store.directory;
    await store.close();
    store = await ProjectStore.open(directory);
    await expect(
      apply("legacy", {
        revision: 7,
        targetRevision: 7,
        episode: 0,
        after: { outline_md: "旧审批" },
      }),
    ).rejects.toMatchObject({ code: "AGENT_APPROVAL_STALE" });
    await apply("approved", pending);
    await apply("approved", pending);
    await expect(apply("conflict", competing)).rejects.toMatchObject({
      code: "AGENT_APPROVAL_STALE",
    });
    await expect(read()).resolves.toMatchObject({ revision: 8, outline_md: "在门口重逢" });
    expect(dramaDocument(store.snapshot)?.revision).toBe(10);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("拆解锁定后旧审批也不能写入剧本，允许修改标题", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-drama-locked-"));
  const store = await ProjectStore.create(root, "锁定测试");
  try {
    await createDrama(store, { title: "锁定测试", script: "门打开了。" });
    const tools = new DramaTools();
    const runId = "locked-episode";
    const read = () =>
      tools.command(store, "drama-read", { runId, input: { scope: "episode", episode_no: 1 } });
    const kind = "drama_update_episode";
    const preview = (patch: object) =>
      tools.command(store, "drama-preview", { runId, kind, input: { episode_no: 1, ...patch } });
    const apply = (id: string, input: unknown) =>
      tools.command(store, "drama-apply", { runId, kind, id, input });
    await expect(read()).resolves.toMatchObject({ locked: false, script_status: "ready" });
    const pending = await preview({ script_md: "新的剧本" });
    await store.updateGeneration((state) => {
      const episode = dramaDocument(state)?.episodes[0];
      if (!episode) throw new Error("缺少分集");
      episode.locked = true;
      return { result: null, changed: true };
    });
    await expect(apply("old", pending)).rejects.toMatchObject({ code: "DRAMA_EPISODE_LOCKED" });
    await expect(read()).resolves.toMatchObject({ locked: true, script_md: "门打开了。" });
    await expect(preview({ synopsis: "覆盖梗概" })).rejects.toMatchObject({
      code: "DRAMA_EPISODE_LOCKED",
    });
    await apply("title", await preview({ title: "开门" }));
    await expect(read()).resolves.toMatchObject({
      title: "开门",
      locked: true,
      script_md: "门打开了。",
    });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("不同集的审批可交叉执行，同一集的过期提案保留当前正文", async () => {
  const root = await mkdtemp(join(tmpdir(), "link-drama-episode-revisions-"));
  const store = await ProjectStore.create(root, "双集测试");
  try {
    await createDrama(store, { title: "双集测试", script: "第一集初稿" });
    await addDramaEpisode(store, { revision: 1, title: "第二集", script_md: "第二集初稿" });
    await addDramaSegment(store, { revision: 2, episode_no: 2, prompt: "室内", seconds: 5 });
    const tools = new DramaTools();
    const runId = "read-episodes";
    const kind = "drama_update_episode";
    const overview = await tools.command(store, "drama-read", {
      runId,
      input: { scope: "overview" },
    });
    expect(overview).toMatchObject({
      episodes: [
        { no: 1, segment_count: 0 },
        { no: 2, segment_count: 1, segment_seconds: 5 },
      ],
    });
    expect(JSON.stringify(overview)).not.toContain("初稿");
    const propose = async (episode_no: number, script_md: string) => {
      await tools.command(store, "drama-read", { runId, input: { scope: "episode", episode_no } });
      return tools.command(store, "drama-preview", {
        runId,
        kind,
        input: { episode_no, script_md },
      });
    };
    const first = await propose(1, "第一集新版");
    const second = await propose(2, "第二集新版");
    const stale = await propose(2, "过期版本");
    const apply = (id: string, input: unknown) =>
      tools.command(store, "drama-apply", { runId, kind, id, input });
    await apply("second", second);
    await apply("first", first);
    await expect(apply("stale", stale)).rejects.toMatchObject({ code: "AGENT_APPROVAL_STALE" });
    expect(dramaDocument(store.snapshot)?.episodes).toMatchObject([
      { script_md: "第一集新版", revision: 2 },
      { script_md: "第二集新版", revision: 2 },
    ]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
