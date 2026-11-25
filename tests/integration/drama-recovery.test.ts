import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { LocalAgentRuntime } from "../../packages/agent-runtime/src/runtime";
import { settingsHistory } from "../../packages/agent-runtime/src/settings-history";
import { requireTestValue } from "../require-test-value";

test("短剧恢复只查原收据，未写入不自动重试，待审批原样保留", async () => {
  const directory = await mkdtemp(join(tmpdir(), "link-drama-recovery-"));
  const scope = { kind: "drama", projectId: "film" } as const;
  const receipts: string[] = [];
  const bridge = async (command: string, input: unknown) => {
    if (command === "canvas:drama-prepare") return {};
    if (command === "canvas:drama-receipt") {
      const id = String((input as { id: string }).id);
      receipts.push(id);
      return receipts.length === 1 ? { applied: true } : null;
    }
    throw Error(command);
  };
  const options = { directory, modelBridgeUrl: "http://127.0.0.1:1", settings: bridge };
  let runtime = await LocalAgentRuntime.open(options);
  try {
    expect(() => runtime.createSession(scope)).toThrow();
    await runtime.recoverCanvas(scope, bridge);
    const { sessionId } = runtime.createSession(scope);
    const owner = {
      sessionId,
      canvasId: runtime.targets.scope(scope).engineId,
      userId: "1",
      mode: "drama",
    };
    const run = runtime.store.createRun({ ...owner, status: "interrupted" });
    const emit = (status: string) =>
      runtime.store.createApproval({
        ...owner,
        runId: run.id,
        kind: "drama_update_episode",
        toolCallId: status + Math.random(),
        status,
        expiresAt: Date.now() + 60000,
        payload: { secret: "不读取审批内容" },
        quoteCredits: 0,
      });
    const one = emit("approved"),
      two = emit("approved"),
      pending = emit("pending");
    for (const approved of [one, two])
      runtime.store.updateApprovalIf(approved.id, ["approved"], {
        decidedAt: Date.now(),
        decision: { decision: "approve" },
      });
    for (let index = 0; index < 210; index++)
      runtime.store.appendEvent(sessionId, run.id, "run.usage", { index });
    runtime.store.appendEvent(sessionId, run.id, "approval.decided", {
      recoveryId: `approval:${one.id}`,
      kind: one.kind,
      status: "executed",
      result: { applied: true },
    });
    await runtime.close();
    runtime = await LocalAgentRuntime.open(options);
    await runtime.recoverCanvas(scope, bridge);
    await runtime.recoverCanvas(scope, bridge);
    expect(receipts).toHaveLength(2);
    expect(receipts).toEqual(expect.arrayContaining([one.id, two.id]));
    expect(runtime.store.getApproval("1", requireTestValue(receipts[0]))).toMatchObject({
      status: "executed",
      result: { applied: true },
    });
    expect(runtime.store.getApproval("1", requireTestValue(receipts[1]))).toMatchObject({
      status: "failed",
      result: { code: "DRAMA_APPROVAL_INTERRUPTED" },
    });
    expect(runtime.store.getApproval("1", pending.id).status).toBe("pending");
    const page = await runtime.page(scope, sessionId, 200);
    expect(
      page.events
        .filter((event) => event.type === "approval.decided")
        .map((event) => event.approvalId),
    ).toEqual([one.id, two.id]);
    const file = join(directory, "agent.sqlite");
    const audits = settingsHistory(file, "audits");
    expect(audits.rows).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain("不读取审批内容");
    expect(settingsHistory(file, "audits", "failed").rows).toHaveLength(1);
    runtime.store.deleteSession("1", sessionId);
    expect(settingsHistory(file, "runs").rows).toHaveLength(0);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
