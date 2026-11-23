import type { CreativeData, GenerationJob } from "@link-studio/core";
import { expect, it } from "vitest";
import { mediaNodeJob } from "../../src/renderer/workspace/media-node-job";
import { runningEdgeTargets } from "../../src/renderer/workspace/running-edge-targets";

const data: CreativeData = { kind: "image", label: "图片", text: "" };
const failed: GenerationJob = {
  id: "first",
  nodeId: "node",
  kind: "image",
  status: "failed",
  progress: 0,
  providerId: "provider",
  providerLabel: "本地",
  model: "fixture",
  providerRevision: 1,
  createdAt: "",
  updatedAt: "",
  outputs: [],
  canCancelRemote: false,
  canRecheck: false,
};

it.each(["image", "audio", "video"] as const)("只取本节点的普通 %s 任务", (kind) => {
  const job = { ...failed, kind };
  expect(
    mediaNodeJob(
      [
        { ...job, nodeId: "other" },
        { ...job, purpose: "drama-board" },
        { ...job, purpose: "character-voice" },
        { ...job, kind: "text" },
        job,
      ],
      "node",
      { ...data, kind },
    ),
  ).toBe(job);
});

it("同批优先展示仍在生成的成员；成功或结果不明时不引导重新提交", () => {
  const first = { ...failed, batchId: "batch" };
  const second = { ...first, id: "second", status: "running" as const };
  expect(mediaNodeJob([first, second], "node", data)).toBe(second);
  const done = {
    ...first,
    status: "succeeded" as const,
    outputs: [{ kind: "image" as const, assetId: "first-output" }],
  };
  expect(
    mediaNodeJob([done, second], "node", { ...data, assetId: "first-output" }),
  ).toBeUndefined();
  expect(mediaNodeJob([done, second], "node", { ...data, assetId: "previous-batch" })).toBe(second);
  for (const status of ["succeeded", "outcome_unknown"] as const)
    expect(mediaNodeJob([first, { ...second, status }], "node", data)).toBeUndefined();
  expect(mediaNodeJob([{ ...first, status: "cancelled" }, failed], "node", data)).toBeUndefined();
  expect(mediaNodeJob([first, { ...second, status: "failed" }], "node", data)).toBe(first);
});

it("不让历史失败覆盖已采用的素材、上传、或较新的终态", () => {
  expect(mediaNodeJob([failed], "node", { ...data, assetId: "asset" })).toBeUndefined();
  expect(
    mediaNodeJob([{ ...failed, status: "running" }], "node", { ...data, uploaded: true }),
  ).toBeUndefined();
  for (const status of ["outcome_unknown", "succeeded", "cancelled"] as const)
    expect(
      mediaNodeJob([{ ...failed, id: "latest", status }, failed], "node", data),
    ).toBeUndefined();
});

it("旧版本仍在历史时，只把正在替换它的批次失败显示在卡面", () => {
  const pending = {
    ...data,
    outputs: [{ kind: "image" as const, id: "old", assetId: "asset", createdAt: "" }],
    pendingMediaVersion: { batchId: "batch", outputId: "old" },
  };
  expect(mediaNodeJob([failed], "node", pending)).toBeUndefined();
  const member = { ...failed, batchId: "batch" };
  expect(mediaNodeJob([member], "node", pending)).toBe(member);
  expect(
    mediaNodeJob([member], "node", { ...pending, assetId: "asset", activeOutputId: "old" }),
  ).toBeUndefined();
  const later = { ...member, id: "second", updatedAt: "2026-11-22T20:00:00Z" };
  expect(mediaNodeJob([member, later], "node", pending)).toBe(later);
  expect(mediaNodeJob([member, { ...later, status: "cancelled" }], "node", data)).toBeUndefined();
});

it("同批首份回填即停止连线快闪；尚有任务时选回旧版也不回到生成占位", () => {
  const pending = { ...failed, batchId: "batch", id: "remaining", status: "running" as const };
  const first = {
    ...failed,
    batchId: "batch",
    status: "succeeded" as const,
    bound: true,
    outputs: [{ kind: "image" as const, assetId: "new" }],
  };
  const outputs = [
    { id: "old", kind: "image" as const, assetId: "old", createdAt: "" },
    { id: `${first.id}:0`, kind: "image" as const, assetId: "new", createdAt: "" },
  ];
  const target = (data: CreativeData) => [{ id: "node", type: "creative" as const, data }];
  expect(runningEdgeTargets(target({ ...data, outputs: outputs.slice(0, 1) }), [pending])).toEqual(
    new Set(["node"]),
  );
  for (const assetId of ["new", "old"]) {
    expect(mediaNodeJob([pending, first], "node", { ...data, outputs, assetId })).toBeUndefined();
    expect(runningEdgeTargets(target({ ...data, outputs, assetId }), [pending, first])).toEqual(
      new Set(),
    );
  }
  expect(
    runningEdgeTargets(target({ ...data, outputs, assetId: "old" }), [
      pending,
      { ...first, bound: false },
    ]),
  ).toEqual(new Set(["node"]));
});

it("上传进度也属于节点运行态；中断不发光，旧批任务不盖过新批终态", () => {
  const target = {
    id: "node",
    type: "creative" as const,
    data: { ...data, uploaded: true as const, uploadProgress: 0 },
  };
  expect(runningEdgeTargets([target], [])).toEqual(new Set(["node"]));
  expect(
    runningEdgeTargets([{ ...target, data: { ...target.data, uploadInterrupted: true } }], []),
  ).toEqual(new Set());
  expect(
    runningEdgeTargets(
      [{ ...target, data }],
      [failed, { ...failed, id: "older", status: "running" }],
    ),
  ).toEqual(new Set());
});
