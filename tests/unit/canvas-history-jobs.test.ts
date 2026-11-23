import type { GenerationJob } from "@link-studio/core";
import { expect, it } from "vitest";
import { historyJobRows, historyJobScope } from "../../src/renderer/workspace/canvas-history-jobs";

const job: GenerationJob = {
  id: "first",
  nodeId: "source",
  status: "running",
  kind: "video",
  providerId: "local",
  providerRevision: 1,
  providerLabel: "本地",
  model: "sample",
  outputs: [],
  progress: 0,
  createdAt: "2026-11-20",
  updatedAt: "2026-11-21",
  canRecheck: false,
  canCancelRemote: false,
};

it("从派生版本和未完成批次找到源任务，普通上传的素材 ID 不引用任务", () => {
  const { includes: include } = historyJobScope(
    [
      {
        id: "derived",
        data: {
          label: "版本 1",
          outputs: [{ id: "first:0" }, { id: "first:1" }, { id: "uploaded" }],
          pendingMediaVersion: { batchId: "batch" },
        },
      },
    ],
    [],
    true,
  );
  expect(
    [
      job,
      { ...job, id: "second", batchId: "batch" },
      { ...job, id: "batch" },
      { ...job, id: "uploaded" },
      { ...job, id: "other" },
    ]
      .filter(include)
      .map((item) => item.id),
  ).toEqual(["first", "second", "batch"]);
});

it("已加载项目按打开时的任务集合对账，新节点不查历史，首次加载项目仍会补查", () => {
  const nodes = [{ id: job.nodeId, data: { label: "镜头" } }];
  expect(historyJobScope(nodes, [], true).fetch).toBe(false);
  const empty = historyJobScope(nodes, [], false),
    warm = historyJobScope(nodes, [job], true);
  expect(empty.fetch && empty.acceptsSnapshot(job)).toBe(true);
  expect(warm.fetch && warm.includes(job)).toBe(true);
  expect(warm.acceptsSnapshot({ ...job, id: "next" })).toBe(false);
  expect(
    historyJobRows([job, { ...job, status: "succeeded", updatedAt: "2026-11-22" }, job], [job]),
  ).toEqual([{ ...job, status: "succeeded", updatedAt: "2026-11-22" }]);
});

it("保留打开时的记录集合，不让延迟轮询覆盖较新的对账结果", () => {
  const done = { ...job, status: "succeeded" as const, updatedAt: "2026-11-22" };
  const next = { ...job, id: "second", createdAt: "2026-11-23" };
  expect(historyJobRows([done, next], [job, { ...job, id: "new" }])).toEqual([next, done]);
  expect(historyJobRows([job], [done])).toEqual([done]);
});
