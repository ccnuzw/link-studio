import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectCoordinator } from "../../src/main/project/coordinator";
import { ProjectStore } from "../../src/main/project/store";
import { requireTestValue } from "../require-test-value";

let directory: string;
let projectDirectory: string;
let clock: number;
let coordinator: ProjectCoordinator;
const focus = vi.fn();

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "link-studio-coordinator-"));
  const store = await ProjectStore.create(directory, "本地项目");
  projectDirectory = store.directory;
  await store.close();
  clock = 1000;
  focus.mockReset();
  coordinator = new ProjectCoordinator(() => clock);
  coordinator.registerWindow(1, focus);
  coordinator.registerWindow(2, () => undefined);
});

afterEach(async () => {
  for (const windowId of [1, 2]) {
    await coordinator.releaseWindow(windowId).catch(() => undefined);
  }
  await rm(directory, { recursive: true, force: true });
});

async function open(windowId = 1, path = projectDirectory) {
  const token = await coordinator.grantProjectDirectory(windowId, path);
  const result = await coordinator.open(windowId, token);
  if (result.disposition !== "opened") throw new Error("expected new session");
  return result.session;
}

describe.skipIf(process.platform !== "darwin")("S1-01 项目会话协调器", () => {
  it("短剧尚未导入原文时，从目录重开仍进入短剧工作室", async () => {
    const token = await coordinator.grantProjectDirectory(1, directory, "create");
    const created = await coordinator.create(1, token, randomUUID(), "空短剧", "drama");
    const path = coordinator.getStore(1, created.projectHandle).directory;
    await coordinator.close(1, created.projectHandle);
    expect(await open(2, path)).toMatchObject({
      projectId: created.projectId,
      projectKind: "drama",
    });
  });
  it("创建项目并按 operationId 重试只产生一个项目会话", async () => {
    const parent = join(directory, "new-projects");
    await mkdir(parent);
    const token = await coordinator.grantProjectDirectory(1, parent, "create");
    const operationId = randomUUID();
    const created = await coordinator.create(1, token, operationId, "新项目");
    expect(created).toMatchObject({ name: "新项目", revision: 1 });
    const retryToken = await coordinator.grantProjectDirectory(1, parent, "create");
    expect(await coordinator.create(1, retryToken, operationId, "新项目")).toEqual(created);
    expect(await readdir(parent)).toHaveLength(1);
    const changedToken = await coordinator.grantProjectDirectory(1, parent, "create");
    await expect(
      coordinator.create(1, changedToken, operationId, "另一个项目"),
    ).rejects.toMatchObject({
      code: "OPERATION_ID_REUSED",
    });
    await coordinator.close(1, created.projectHandle);
    const staleRetry = await coordinator.grantProjectDirectory(1, parent, "create");
    await expect(coordinator.create(1, staleRetry, operationId, "新项目")).rejects.toMatchObject({
      code: "PROJECT_NOT_OPEN",
    });
    expect(await readdir(parent)).toHaveLength(1);
  });

  it("重试创建已挂起的短剧会恢复原会话，且不会被空闲回收", async () => {
    const operationId = randomUUID();
    const createDrama = async () =>
      coordinator.create(
        1,
        await coordinator.grantProjectDirectory(1, directory, "create"),
        operationId,
        "后台短剧",
        "drama",
      );
    const created = await createDrama();
    await coordinator.park(1, created.projectHandle);
    expect(await createDrama()).toEqual(created);
    const stop = vi.fn(async () => {});
    await coordinator.releaseIdle(() => false, stop);
    expect(stop).not.toHaveBeenCalled();
    expect(coordinator.getSession(1, created.projectHandle)).toEqual(created);
  });

  it("创建授权不能用于打开，且不同用途的 token 不能互换", async () => {
    const createToken = await coordinator.grantProjectDirectory(1, directory, "create");
    await expect(coordinator.open(1, createToken)).rejects.toMatchObject({
      code: "TOKEN_INVALID_OR_EXPIRED",
    });
    const openToken = await coordinator.grantProjectDirectory(1, projectDirectory, "open");
    await expect(coordinator.create(1, openToken, randomUUID(), "越权创建")).rejects.toMatchObject({
      code: "TOKEN_INVALID_OR_EXPIRED",
    });
  });

  it("窗口/用途边界：任意路径不是 token，跨窗口 token 与 handle 均拒绝", async () => {
    await expect(coordinator.open(1, projectDirectory)).rejects.toMatchObject({
      code: "TOKEN_INVALID_OR_EXPIRED",
    });
    const token = await coordinator.grantProjectDirectory(1, projectDirectory);
    await expect(coordinator.open(2, token)).rejects.toMatchObject({
      code: "TOKEN_INVALID_OR_EXPIRED",
    });
    const opened = await coordinator.open(1, token);
    if (opened.disposition !== "opened") throw new Error("expected session");
    expect(() => coordinator.getSession(2, opened.session.projectHandle)).toThrow("项目会话不可用");
    await expect(
      coordinator.rename(2, {
        projectHandle: opened.session.projectHandle,
        operationId: randomUUID(),
        expectedRevision: 1,
        name: "越权",
      }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_OPEN" });
    expect(coordinator.getSession(1, opened.session.projectHandle).revision).toBe(1);
  });

  it("令牌十分钟过期、单次消费，未注册窗口不能申请授权", async () => {
    const expired = await coordinator.grantProjectDirectory(1, projectDirectory);
    clock += 600_000;
    await expect(coordinator.open(1, expired)).rejects.toMatchObject({
      code: "TOKEN_INVALID_OR_EXPIRED",
    });
    const token = await coordinator.grantProjectDirectory(1, projectDirectory);
    expect((await coordinator.open(1, token)).disposition).toBe("opened");
    await expect(coordinator.open(1, token)).rejects.toMatchObject({
      code: "TOKEN_INVALID_OR_EXPIRED",
    });
    await expect(coordinator.grantProjectDirectory(99, projectDirectory)).rejects.toMatchObject({
      code: "PROJECT_PATH_DENIED",
    });
  });

  it.each(["canvas", "drama"] as const)("同窗恢复 %s 项目的原会话，同窗无需激活", async (kind) => {
    const parent = await coordinator.grantProjectDirectory(1, directory, "create");
    const session = await coordinator.create(1, parent, randomUUID(), kind, kind);
    const path = coordinator.getStore(1, session.projectHandle).directory;
    for (const park of [false, true]) {
      if (park) await coordinator.park(1, session.projectHandle);
      const token = await coordinator.authorizeRecent(1, path);
      expect(await coordinator.open(1, token)).toEqual({ disposition: "opened", session });
      expect(coordinator.isParked(session.projectHandle)).toBe(false);
    }
    expect(focus).not.toHaveBeenCalled();
  });

  it("同实例别名/并发打开激活已有窗口，不创建第二个可写会话", async () => {
    const alias = join(directory, "alias");
    await symlink(projectDirectory, alias);
    const first = await coordinator.grantProjectDirectory(1, projectDirectory);
    const second = await coordinator.grantProjectDirectory(2, alias);
    const results = await Promise.all([coordinator.open(1, first), coordinator.open(2, second)]);
    expect(results.map((result) => result.disposition)).toEqual(["opened", "focusedExisting"]);
    expect(focus).toHaveBeenCalledOnce();
    const [{ projectHandle, directoryToken }] = requireTestValue(focus.mock.calls[0]);
    if (results[0]?.disposition !== "opened") throw Error("首窗口未打开项目");
    expect(projectHandle).toBe(results[0].session.projectHandle);
    await expect(coordinator.open(2, directoryToken)).rejects.toMatchObject({
      code: "TOKEN_INVALID_OR_EXPIRED",
    });
    expect(await coordinator.open(1, directoryToken)).toEqual(results[0]);
  });

  it("跨窗定位后台项目期间即使空闲会话释放，原窗口仍能打开目标目录", async () => {
    const session = await open();
    await coordinator.park(1, session.projectHandle);
    const token = await coordinator.authorizeRecent(2, projectDirectory);
    expect(await coordinator.open(2, token)).toEqual({ disposition: "focusedExisting" });
    const [{ directoryToken }] = requireTestValue(focus.mock.calls[0]);
    await coordinator.releaseIdle(
      () => false,
      async () => {},
    );
    const result = await coordinator.open(1, directoryToken);
    if (result.disposition !== "opened") throw Error("原窗口未恢复目标项目");
    expect(result.session.projectId).toBe(session.projectId);
    expect(result.session.projectHandle).not.toBe(session.projectHandle);
  });

  it("projectId 相同的目录副本可独立打开", async () => {
    const duplicate = join(directory, "duplicate.linkstudio");
    await cp(projectDirectory, duplicate, { recursive: true });
    const first = await open();
    const second = await open(2, duplicate);
    expect(first.projectId).toBe(second.projectId);
    expect(first.projectHandle).not.toBe(second.projectHandle);
    await coordinator.rename(2, {
      projectHandle: second.projectHandle,
      operationId: randomUUID(),
      expectedRevision: 1,
      name: "副本",
    });
    expect(coordinator.getSession(1, first.projectHandle).name).toBe("本地项目");
  });

  it("授权后替换目录被拒绝，不打开替换目标", async () => {
    const token = await coordinator.grantProjectDirectory(1, projectDirectory);
    await rename(projectDirectory, `${projectDirectory}.original`);
    await mkdir(projectDirectory);
    await expect(coordinator.open(1, token)).rejects.toMatchObject({ code: "PROJECT_PATH_DENIED" });
    expect(await readdir(projectDirectory)).toEqual([]);
  });

  it("关闭排空写队列、旧 handle 失效，重开原 operationId 重放不重复写入", async () => {
    const session = await open();
    const operationId = randomUUID();
    const input = {
      projectHandle: session.projectHandle,
      operationId,
      expectedRevision: 1,
      name: "保存后重开",
    };
    const saved = coordinator.rename(1, input);
    const closed = coordinator.close(1, session.projectHandle);
    expect(await saved).toEqual({ revision: 2, name: input.name });
    await closed;
    expect(() => coordinator.getSession(1, session.projectHandle)).toThrow("项目会话不可用");
    const reopened = await open();
    expect(reopened.revision).toBe(2);
    expect(
      await coordinator.rename(1, { ...input, projectHandle: reopened.projectHandle }),
    ).toEqual({ revision: 2, name: input.name });
    expect((await readdir(join(projectDirectory, "state"))).length).toBe(2);
    await expect(
      coordinator.rename(1, {
        ...input,
        projectHandle: reopened.projectHandle,
        name: "复用不同请求",
      }),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED" });
  });

  it("窗口释放立即撤销授权，复用相同窗口 ID 不能继承旧 handle/token", async () => {
    const session = await open();
    const token = await coordinator.grantProjectDirectory(1, projectDirectory);
    const released = coordinator.releaseWindow(1);
    coordinator.registerWindow(1, () => undefined);
    await released;
    expect(() => coordinator.getSession(1, session.projectHandle)).toThrow("项目会话不可用");
    await expect(coordinator.open(1, token)).rejects.toMatchObject({
      code: "TOKEN_INVALID_OR_EXPIRED",
    });
    expect((await open()).revision).toBe(1);
  });

  it("窗口释放可重复调用，旧 lease 不会释放复用 ID 的新窗口", async () => {
    const originalLease = coordinator.registerWindow(3, () => undefined);
    const projectToken = await coordinator.grantProjectDirectory(3, projectDirectory);
    const opened = await coordinator.open(3, projectToken);
    if (opened.disposition !== "opened") throw new Error("expected session");
    const firstRelease = coordinator.releaseWindow(3, originalLease);
    const duplicateRelease = coordinator.releaseWindow(3, originalLease);
    const newLease = coordinator.registerWindow(3, () => undefined);
    await Promise.all([firstRelease, duplicateRelease]);
    await coordinator.releaseWindow(3, originalLease);
    expect(() => coordinator.getSession(3, opened.session.projectHandle)).toThrow("项目会话不可用");
    const newToken = await coordinator.grantProjectDirectory(3, projectDirectory);
    expect((await coordinator.open(3, newToken)).disposition).toBe("opened");
    await coordinator.releaseWindow(3, newLease);
  });

  it("写失败后 graceful close 不报告成功并保留会话；窗口销毁可释放系统锁", async () => {
    const session = await open();
    const temporary = join(projectDirectory, "tmp");
    await rename(temporary, `${temporary}.original`);
    await symlink(`${temporary}.original`, temporary);
    await expect(
      coordinator.rename(1, {
        projectHandle: session.projectHandle,
        operationId: randomUUID(),
        expectedRevision: 1,
        name: "失败提交",
      }),
    ).rejects.toMatchObject({ code: "PROJECT_SAVE_FAILED" });
    await expect(coordinator.close(1, session.projectHandle)).rejects.toMatchObject({
      code: "PROJECT_SAVE_FAILED",
    });
    expect(coordinator.getSession(1, session.projectHandle).revision).toBe(1);
    await coordinator.releaseWindow(1);
    await rm(temporary);
    await rename(`${temporary}.original`, temporary);
    coordinator.registerWindow(1, () => undefined);
    expect((await open()).revision).toBe(1);
  });
});
