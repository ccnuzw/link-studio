import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { CanvasAgentService } from "../../src/main/project/canvas-agent";
import { ProjectCoordinator } from "../../src/main/project/coordinator";
import { createDrama, dramaDocument } from "../../src/main/project/drama";
import { submitApprovedDramaJob } from "../../src/main/project/drama-job";
import type { SettingsRegistry } from "../../src/main/settings/registry";

test("两个短剧并行，切回不重复提交，取消与释放不影响另一个项目", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-background-"));
  const coordinator = new ProjectCoordinator();
  coordinator.registerWindow(1, () => {});
  coordinator.registerWindow(2, () => {});
  const model = { id: randomUUID(), revision: 1 };
  const pending = new Map<string, () => void>();
  const generate = vi.fn(
    async (_model, _step, variables, _scope, signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        pending.set(variables.episode.title, () => resolve(`${variables.episode.title}的剧本`));
        signal.addEventListener("abort", () => reject(Error("已取消")), { once: true });
      }),
  );
  const registry = {
    dramaJobQuote: async () => ({ model, estimate: 6 }),
    agentBinding: () => ({ profile: { config: { contextWindow: 32768 } } }),
    redact: (text: string) => text,
    dramaAssetStage: generate,
  } as unknown as SettingsRegistry;
  const service = new CanvasAgentService({} as never, async () => registry);
  async function start(name: string) {
    const parent = await coordinator.grantProjectDirectory(1, root, "create");
    const session = await coordinator.create(1, parent, randomUUID(), name, "drama");
    const store = coordinator.getStore(1, session.projectHandle);
    await createDrama(
      store,
      { title: name, script: "第一章 相遇\n再次见面。", sourceKind: "novel" },
      [],
      [],
      () => [],
      undefined,
      model,
    );
    await store.updateGeneration((state) => {
      const doc = dramaDocument(state)!;
      Object.assign(doc.planning!, { phase: "done", cursor: 1, summary: "相遇" });
      doc.episodes = [
        {
          episode_no: 1,
          title: name,
          synopsis: "相遇",
          script_md: "",
          revision: 1,
          unit_from: 1,
          unit_to: 1,
        },
      ];
      return { changed: true, result: null };
    });
    const job = await submitApprovedDramaJob(store, registry, "run", "approval", {
      args: { step: "scripts", episodes: [1] },
      estimate: 6,
    });
    service.attach(store);
    await vi.waitFor(() => expect(pending.has(name)).toBe(true));
    return { store, handle: session.projectHandle, id: job.id };
  }
  try {
    const first = await start("短剧甲");
    await coordinator.park(1, first.handle);
    const second = await start("短剧乙");
    await coordinator.park(1, second.handle);
    const foreign = await coordinator.grantProjectDirectory(2, first.store.directory);
    expect(await coordinator.open(2, foreign)).toEqual({ disposition: "focusedExisting" });
    const token = await coordinator.grantProjectDirectory(1, first.store.directory);
    expect(await coordinator.open(1, token)).toMatchObject({
      disposition: "opened",
      session: { projectHandle: first.handle },
    });
    expect(coordinator.getStore(1, first.handle)).toBe(first.store);
    await service.cancelStudioJob(second.store, second.id);
    await coordinator.releaseIdle(
      (store) => dramaDocument(store.snapshot)!.jobs!.some((job) => job.status === "running"),
      async (handle) => service.detach(coordinator.getStore(1, handle)),
    );
    expect(() => coordinator.getStore(1, second.handle)).toThrow();
    pending.get("短剧甲")!();
    await vi.waitFor(() =>
      expect(dramaDocument(first.store.snapshot)!.jobs?.[0]?.status).toBe("succeeded"),
    );
    expect(generate).toHaveBeenCalledTimes(2);
    expect(dramaDocument(first.store.snapshot)!.episodes[0]?.script_md).toBe("短剧甲的剧本");
    service.detach(first.store);
  } finally {
    for (const finish of pending.values()) finish();
    await coordinator.releaseWindow(1);
    await coordinator.releaseWindow(2);
    await rm(root, { recursive: true, force: true });
  }
});
