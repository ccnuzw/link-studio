import type { CreativeData, GenerationJob } from "@link-studio/core";
import { expect, it } from "vitest";
import {
  pendingVersionJobs,
  versionBadge,
  versionJobs,
  versionNodes,
  versionOutputs,
} from "../../src/renderer/workspace/node-versions";

const source: CreativeData = {
  kind: "image",
  label: "风景",
  text: "下一稿",
  assetId: "asset",
  activeOutputId: "second",
  outputs: [
    { id: "first", kind: "image", assetId: "asset", createdAt: "" },
    { id: "second", kind: "image", assetId: "asset", createdAt: "" },
  ],
};
const running: GenerationJob = {
  id: "second-job",
  batchId: "current",
  nodeId: "node",
  kind: "image",
  status: "running",
  progress: 0,
  providerId: "local",
  providerLabel: "本地",
  model: "model",
  providerRevision: 1,
  createdAt: "",
  updatedAt: "",
  outputs: [],
  canRecheck: false,
  canCancelRemote: false,
};

it("徽标和可操作的占位只计入当前普通媒体批次，不把上一批运行中的任务带回来", () => {
  const jobs = versionJobs(
    [
      { ...running, nodeId: "other" },
      { ...running, purpose: "character-voice" },
      running,
      { ...running, id: "third-job" },
      { ...running, batchId: "older" },
    ],
    "node",
    "image",
  );
  expect(pendingVersionJobs(jobs).map((job) => job.id)).toEqual(["second-job", "third-job"]);
  expect(versionBadge(source, jobs)).toEqual({ count: 4, generating: true });
  expect(
    versionBadge(source, [
      { ...running, status: "succeeded" },
      { ...running, batchId: "older" },
    ]),
  ).toEqual({ count: 2, generating: false });
  expect(versionBadge({ ...source, kind: "script" }, jobs)).toBeUndefined();
});

it("同素材的两个版本保持各自标识；新节点避开邻居，不继承提示词、模型或任务", () => {
  const origin = { x: 10, y: 20, width: 280, height: 220 };
  const created = versionNodes(
    { ...source, pendingMediaVersion: { batchId: "current", outputId: "second" } },
    source.outputs!,
    origin,
    [origin, { ...origin, x: 330 }],
  );
  expect(created.map((node) => node.position)).toEqual([
    { x: 650, y: 20 },
    { x: 970, y: 20 },
  ]);
  expect(new Set(created.map((node) => node.id)).size).toBe(2);
  for (const [index, node] of created.entries()) {
    const output = source.outputs![index]!;
    expect(node.selected).toBe(true);
    expect(node.data).toEqual({
      kind: "image",
      label: `风景 · 版本${index + 1}`,
      text: "",
      assetId: "asset",
      outputs: [output],
      activeOutputId: output.id,
    });
  }
  const legacy = { ...source, outputs: undefined, activeOutputId: undefined };
  expect(versionOutputs(legacy)).toEqual([
    { id: "asset", kind: "image", assetId: "asset", createdAt: "" },
  ]);
  expect(versionBadge(legacy, [])).toBeUndefined();
});
