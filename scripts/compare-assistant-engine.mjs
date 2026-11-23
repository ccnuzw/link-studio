import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const revision = "ff4070c7b23581b1a79eacbfeddc56f836562377";
const root = path.resolve(import.meta.dirname, "..");
const reference = path.resolve(
  process.env.AGENT_REFERENCE_WEB ?? path.join(root, "../video-canvas/web"),
  "..",
);
const temp = await mkdtemp(path.join(tmpdir(), "assistant-engine-"));
const output = path.join(root, "test-results/assistant-workspaces/engine.json");
const generateTurn = {
  tools: [{ id: "make-image", name: "generate_media", args: { items: [{ nodeId: "shot" }] } }],
};
const proposedGeneration = {
  generate: {
    payload: { items: [{ node_id: "shot", price: 5 }], quote_credits: 5 },
    quote_credits: 5,
    summary: "生成一张分镜",
    content: "已提交给用户批准，等待决定。",
  },
};
const questionTurn = {
  tools: [{ id: "question", name: "ask_user", args: { question: "检查哪个范围？" } }],
};
const cases = {
  reply: { turns: [{ thinking: "先核对范围", text: "核对完成" }] },
  tool: {
    turns: [
      { tools: [{ id: "read", name: "canvas_get_state", args: { nodeIds: ["shot"] } }] },
      { text: "已读取节点" },
    ],
  },
  failed: { turns: [{ error: { status: 402, message: "积分不足", errorCode: 40001 } }] },
  budget: {
    turns: [
      { error: { status: 402, message: "超出本轮积分预算", errorCode: 60008 } },
      { text: "接着做完了" },
    ],
  },
  ask: { turns: [questionTurn, { text: "已核对当前渠道" }] },
  queuedAnswer: {
    turns: [{ ...questionTurn, delayMs: 150 }, { text: "已按补充要求核对当前渠道" }],
  },
  queuedStop: { turns: [{ ...questionTurn, delayMs: 150 }, { text: "意外的继续回复" }] },
  steer: { turns: [{ text: "先核对名称", delayMs: 150 }, { text: "也核对计费单位" }] },
  approve: { turns: [generateTurn, { text: "已开始生成" }], propose: proposedGeneration },
  reject: { turns: [generateTurn, { text: "已取消生成" }], propose: proposedGeneration },
};

async function exercise(directory, name, scenario, canvasId) {
  const { withEngine } = await import(
    pathToFileURL(path.join(directory, "test/engine-helpers.ts"))
  );
  let result;
  await withEngine(
    scenario,
    async (fixture) => {
      const run = await fixture
        .start({
          message: "核对本次配置",
          mode: canvasId === "0" ? "admin" : "all",
          ...(name === "budget" && { budgetCredits: 5 }),
        })
        .catch((cause) => {
          throw new Error(
            `${name} ${directory}: ${JSON.stringify(fixture.persisted("run.status"))}`,
            { cause },
          );
        });
      const queued = name === "queuedAnswer" || name === "queuedStop";
      if (name === "steer" || queued) await fixture.engine.interject("1", run.id, "也核对计费单位");
      await fixture.engine.idle();
      if (queued) {
        assert.equal(fixture.run(run.id).status, "waiting_input");
        assert.deepEqual(fixture.persisted("steer.read"), []);
        assert.equal(fixture.go.modelRequests.length, 1);
      }
      if (name === "ask" || name === "queuedAnswer") {
        assert.equal(fixture.run(run.id).status, "waiting_input");
        assert.equal(fixture.go.modelRequests.length, 1);
        const [approval] = fixture.store.listApprovals(run.id);
        await fixture.engine.decide("1", approval.id, { decision: "approve", answer: "当前渠道" });
        await fixture.engine.idle();
        assert.match(
          JSON.stringify(fixture.go.modelRequests.at(-1).body.messages),
          /用户回答：当前渠道/,
        );
      }
      if (name === "steer" || name === "queuedAnswer") {
        const [steer] = fixture.persisted("message.user").filter((message) => message.steer);
        assert.deepEqual(fixture.persisted("steer.read"), [{ ids: [steer.id] }]);
        assert.match(
          JSON.stringify(fixture.go.modelRequests.at(-1).body.messages),
          /也核对计费单位/,
        );
        if (queued)
          assert.ok(
            fixture.types().indexOf("approval.decided") < fixture.types().indexOf("steer.read"),
          );
      }
      if (name === "queuedStop") {
        await fixture.engine.cancel("1", run.id);
        await fixture.engine.idle();
        const [steer] = fixture.persisted("message.user").filter((message) => message.steer);
        assert.deepEqual(fixture.persisted("steer.dropped"), [
          { ids: [steer.id], reason: "canceled" },
        ]);
        assert.deepEqual(fixture.persisted("steer.read"), []);
        assert.ok(
          fixture.types().indexOf("steer.dropped") < fixture.types().lastIndexOf("run.status"),
        );
        assert.equal(fixture.go.modelRequests.length, 1);
      }
      if (name === "approve" || name === "reject") {
        const [approval] = fixture.store.listApprovals(run.id);
        assert.equal(fixture.go.modelRequests.length, 1);
        await fixture.engine.decide(
          "1",
          approval.id,
          name === "approve"
            ? { decision: "approve" }
            : { decision: "reject", answer: "保留现有分镜" },
        );
        await fixture.engine.idle();
        const final = fixture.store.getApproval("1", approval.id);
        assert.equal(final.status, name === "approve" ? "executed" : "rejected");
        assert.match(
          JSON.stringify(fixture.go.modelRequests.at(-1).body.messages),
          name === "approve" ? /用户批准了generate，已执行/ : /用户的说明：保留现有分镜/,
        );
      }
      if (name === "budget") {
        assert.equal(fixture.run(run.id).status, "budget_exhausted");
        await assert.rejects(fixture.engine.resume("1", run.id), { code: 10001 });
        await fixture.engine.resume("1", run.id, 20);
        await fixture.engine.idle();
      }
      assert.equal(
        fixture.run(run.id).status,
        { failed: "failed", queuedStop: "canceled" }[name] ?? "succeeded",
      );
      result = {
        requests: fixture.go.modelRequests.map((request) => request.body),
        eventTypes: fixture.types(),
        statuses: fixture.statuses(),
        messages: fixture.persisted("message.done"),
        spent: fixture.run(run.id).spentCredits,
      };
    },
    { canvasId },
  );
  return result;
}

try {
  const archive = path.join(temp, "reference.tar");
  execFileSync("git", ["-C", reference, "archive", "-o", archive, revision, "agent"]);
  execFileSync("tar", ["-xf", archive, "-C", temp]);
  await symlink(path.join(root, "node_modules"), path.join(temp, "node_modules"));
  const samples = {};
  for (const [scope, canvasId] of [
    ["canvas", "7"],
    ["settings", "0"],
  ]) {
    for (const [name, scenario] of Object.entries(cases)) {
      if (scope === "settings" && ["budget", "tool", "approve", "reject"].includes(name)) continue;
      const sample = `${scope}-${name}`;
      const desktop = await exercise(
        path.join(root, "packages/agent-runtime/upstream"),
        name,
        scenario,
        canvasId,
      );
      const baseline = await exercise(path.join(temp, "agent"), name, scenario, canvasId);
      assert.deepEqual(desktop, baseline, sample);
      samples[sample] = desktop;
    }
  }
  await mkdir(path.dirname(output), { recursive: true });
  const recovery = {};
  for (const [side, directory] of [
    ["reference", path.join(temp, "agent")],
    ["desktop", path.join(root, "packages/agent-runtime/upstream")],
  ]) {
    const report = execFileSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--test",
        "--test-reporter=tap",
        "test/engine-recovery.test.ts",
      ],
      { cwd: directory, encoding: "utf8", timeout: 60000 },
    );
    recovery[side] = [...report.matchAll(/^ok \d+ - (.+)$/gm)].map((match) => match[1]);
    assert.ok(recovery[side].length > 0);
  }
  assert.deepEqual(recovery.desktop, recovery.reference);
  await writeFile(output, JSON.stringify({ revision, samples, recovery }, null, 2));
  console.log(`${Object.keys(samples).length} matching engine cases`);
  console.log(`${recovery.desktop.length} recovery cases passed on both engines`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
