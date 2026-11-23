import { afterAll, expect, test } from "vitest";
import { addCanvasGateway } from "../../packages/agent-runtime/src/canvas-gateway";
import { SpikeTargets } from "../../packages/agent-runtime/src/targets";
import {
  type ApprovalDecision,
  createPlatform,
} from "../../packages/agent-runtime/upstream/src/platform-client";
import { approvedQuoteHasMissing } from "../../packages/link-studio-core/src/agent-generation-quote";
import type { GenerationInput } from "../../packages/link-studio-core/src/generation";
import type { ModelConfig } from "../../packages/link-studio-core/src/model-config";
import { quotePreparedGeneration } from "../../src/main/project/canvas-agent-generation";

const targets = new SpikeTargets(":memory:");
afterAll(() => targets.close());
const platform = addCanvasGateway(
  createPlatform({ baseUrl: "https://example.invalid", serviceToken: "fixture" }),
  targets,
  async () => {
    throw Error("选择审批项不应提交任务");
  },
);
const resolve = (decision: ApprovalDecision) =>
  platform.resolve(
    { run_id: "3", session_id: "2", user_id: "1", canvas_id: "1", mode: "all" },
    "generate",
    { items: ["first", "second", "third"] },
    decision,
  );

test("生成规格用 Unicode 字符、绑定模型和实际引用计价", () => {
  const config: ModelConfig = { kind: "image", name: "样本", description: "", sort: 1 };
  const input: GenerationInput = {
    nodeId: "shot",
    providerId: "model",
    expectedProviderRevision: 1,
    expectedCanvasRevision: 1,
    prompt: "路🌙",
    referenceAssetIds: [],
  };
  expect(
    quotePreparedGeneration(
      {
        ...config,
        systemPrompt: "📷",
        maxOutputTokens: 7,
        pricing: { unit: "token", input: 1_000_000, output: 1_000_000 },
      },
      "text",
      input,
      {},
    ),
  ).toBe(10);
  const tier: ModelConfig = {
    ...config,
    pricing: {
      unit: "request",
      input: 2,
      tiers: [{ when: { op: "i2i", aspect_ratio: "16:9", style_tag: "film" }, on: true, unit: 13 }],
    },
  };
  const wide = { ...input, aspectRatio: "16:9", customParams: { style_tag: "film" } };
  expect(quotePreparedGeneration(tier, "image", wide, {})).toBe(2);
  expect(quotePreparedGeneration({ ...tier, modes: ["i2i"] }, "image", wide, {})).toBe(13);
  expect(
    quotePreparedGeneration(
      tier,
      "image",
      { ...wide, referenceAssetIds: ["frame"] },
      { frame: { mediaType: "image" } },
    ),
  ).toBe(13);
  const video: ModelConfig = {
    ...config,
    pricing: {
      unit: "second",
      input: 2,
      tiers: [{ when: { op: "omni", ref_video: true, generate_audio: true }, on: true, unit: 5 }],
    },
  };
  const omni = {
    ...input,
    op: "omni" as const,
    referenceAssetIds: ["ref"],
    duration: 6,
    generateAudio: true,
  };
  expect(quotePreparedGeneration(video, "video", omni, { ref: { mediaType: "video" } })).toBe(30);
  expect(quotePreparedGeneration(video, "video", omni, { ref: { mediaType: "image" } })).toBe(12);
  expect(
    quotePreparedGeneration(
      { ...config, pricing: { unit: "request", input: 0, pending: true } },
      "image",
      input,
      {},
    ),
  ).toBeUndefined();
});

test("历史中的混合报价只检查批准项，已定价的零积分不算缺价", () => {
  const items = [{ price: 12 }, { price: 0 }, {}];
  expect(approvedQuoteHasMissing(items, undefined)).toBe(true);
  expect(
    approvedQuoteHasMissing(items, [
      { index: 0, approve: true },
      { index: 1, approve: true },
      { index: 2, approve: false },
    ]),
  ).toBe(false);
  expect(
    approvedQuoteHasMissing(items, [
      { index: 0, approve: true },
      { index: 2, approve: true },
    ]),
  ).toBe(true);
});

test("生成预算只按勾选报价，计入先前已用额度；未知价格不冒充免费", async () => {
  const limited = (decision: ApprovalDecision, budget = 32) =>
    platform.resolve(
      {
        run_id: "3",
        session_id: "2",
        user_id: "1",
        canvas_id: "1",
        mode: "all",
        budget_credits: budget,
        spent_extra: 3,
      },
      "generate",
      { items: [{ price: 30 }, { price: 0 }, {}] },
      decision,
    );
  const paid = { decision: "approve" as const, items: [{ index: 0, approve: true }] };
  await expect(limited(paid)).rejects.toMatchObject({ code: 60008 });
  expect(await limited({ ...paid, add_budget: 1 })).toMatchObject({ quote_credits: 30 });
  expect(
    await limited({ decision: "approve", items: [{ index: 1, approve: true }] }),
  ).toMatchObject({ quote_credits: 0 });
  await expect(limited({ decision: "approve" })).rejects.toMatchObject({
    code: "AGENT_GENERATION_PRICE_UNKNOWN",
  });
  expect(await limited({ decision: "approve" }, 0)).toMatchObject({ quote_credits: 30 });
  expect(await limited({ decision: "reject" })).toMatchObject({ quote_credits: 0 });
});

test("批准生成：缺省或空列表批准全部，部分批准按申请顺序，不增加每个节点的结果数", async () => {
  for (const items of [undefined, []])
    expect(await resolve({ decision: "approve", items })).toMatchObject({
      status: "approved",
      admin_change: { selected: [0, 1, 2] },
    });
  expect(
    await resolve({
      decision: "approve",
      items: [
        { index: 2, approve: true, count: 7 },
        { index: 0, approve: true },
        { index: 1, approve: false },
      ],
    }),
  ).toMatchObject({ status: "partially_approved", admin_change: { selected: [0, 2] } });
  expect(await resolve({ decision: "reject", answer: "先调整场次" })).toMatchObject({
    status: "rejected",
    decision: { answer: "先调整场次" },
    admin_change: { selected: [] },
  });
});

test("批准生成：重复（含未选）、越界或没有任何选中项的批准无效", async () => {
  for (const items of [
    [
      { index: 1, approve: false },
      { index: 1, approve: true },
    ],
    [
      { index: 3, approve: false },
      { index: 1, approve: true },
    ],
    [{ index: 1, approve: false }],
  ]) {
    await expect(resolve({ decision: "approve", items })).rejects.toMatchObject({
      code: "AGENT_APPROVAL_STALE",
    });
  }
});
