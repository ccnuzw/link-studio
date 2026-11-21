import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLocalApfs } from "../../packages/media-runtime/src/local-filesystem";
import { canonicalJson, contentHash } from "../../src/main/project/encoding";
import { type CommitStage, ProjectStore } from "../../src/main/project/store";

let parent: string;
const stores: ProjectStore[] = [];
const children: ChildProcess[] = [];

async function create() {
  const store = await ProjectStore.create(parent, "灵可存储验证");
  stores.push(store);
  return store;
}

async function reopen(directory: string) {
  const store = await ProjectStore.open(directory);
  stores.push(store);
  return store;
}

function worker(directory: string, mode = "hold", operationId = randomUUID(), electron = false) {
  const require = createRequire(import.meta.url);
  const child = fork(
    join(import.meta.dirname, "../fixtures/project-process.ts"),
    [directory, mode, operationId],
    {
      execPath: electron ? (require("electron") as string) : process.execPath,
      execArgv: ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  children.push(child);
  return child;
}

function message(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("子进程响应超时")), 10_000);
    const received = (value: Record<string, unknown>) => finish(undefined, value);
    const exited = (code: number | null) => finish(new Error(`子进程提前退出：${code}`));
    function finish(error?: Error, value?: Record<string, unknown>) {
      clearTimeout(timer);
      child.off("message", received);
      child.off("exit", exited);
      if (error) reject(error);
      else resolve(value ?? {});
    }
    child.once("message", received);
    child.once("exit", exited);
  });
}

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "link-studio-storage-"));
});

afterEach(async () => {
  for (const child of children.splice(0)) await kill(child);
  for (const store of stores.splice(0)) await store.close();
  await rm(parent, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "darwin")("M0-03 本机 APFS 项目存储", () => {
  it("识别 APFS 目录并拒绝 devfs", async () => {
    const directory = join(parent, "本机 项目");
    await mkdir(directory);
    expect(await isLocalApfs(directory)).toBe(true);
    expect(await isLocalApfs("/dev")).toBe(false);
  });

  it("创建空项目、保存、重启后回执去重，冲突请求不落盘", async () => {
    const store = await create();
    const request = { operationId: randomUUID(), expectedRevision: 1, name: "第一版" };
    const receipt = await store.rename(request);
    expect(receipt.revision).toBe(2);
    const copy = store.snapshot;
    copy.name = "外部修改";
    expect(store.snapshot.name).toBe("第一版");
    await store.close();
    const restored = await reopen(store.directory);
    expect(await restored.rename(request)).toEqual(receipt);
    await expect(restored.rename({ ...request, name: "不同请求" })).rejects.toMatchObject({
      code: "OPERATION_ID_REUSED",
    });
    await expect(restored.rename({ ...request, operationId: randomUUID() })).rejects.toMatchObject({
      code: "PROJECT_CONFLICT",
    });
    expect((await readdir(join(store.directory, "state"))).length).toBe(2);
    await restored.close();
    await expect(restored.rename(request)).rejects.toMatchObject({ code: "PROJECT_CLOSED" });
  });

  it("串行写队列只允许同修订的一次修改，关闭等待排队提交", async () => {
    const store = await create();
    const request = { operationId: randomUUID(), expectedRevision: 1, name: "第一次" };
    const results = Promise.allSettled([
      store.rename(request),
      store.rename({ ...request, operationId: randomUUID(), name: "第二次" }),
    ]);
    await store.close();
    expect((await results).map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((await reopen(store.directory)).snapshot.name).toBe("第一次");
  });

  it("同进程、路径别名和其他进程均不能抢占活动锁，退出后自动释放", async () => {
    const store = await create();
    const alias = join(parent, "别名");
    await symlink(store.directory, alias);
    await expect(ProjectStore.open(alias)).rejects.toMatchObject({ code: "PROJECT_IN_USE" });
    expect(await message(worker(alias))).toMatchObject({ error: "PROJECT_IN_USE" });
    await store.close();
    const owner = worker(alias);
    expect(await message(owner)).toMatchObject({ ready: true });
    expect(await message(worker(store.directory))).toMatchObject({ error: "PROJECT_IN_USE" });
    await kill(owner);
    expect((await reopen(store.directory)).snapshot.revision).toBe(1);
  });

  it("Electron 自带 Node 加载原生锁并与开发 Node 互斥", async () => {
    const store = await create();
    await store.close();
    const owner = worker(store.directory, "hold", randomUUID(), true);
    expect(await message(owner)).toMatchObject({ ready: true });
    await expect(ProjectStore.open(store.directory)).rejects.toMatchObject({
      code: "PROJECT_IN_USE",
    });
    await kill(owner);
    expect((await reopen(store.directory)).snapshot.revision).toBe(1);
  });

  it("两个独立进程同时竞争时只有一个成功", async () => {
    const store = await create();
    await store.close();
    const contenders = [worker(store.directory, "race"), worker(store.directory, "race")];
    expect(await Promise.all(contenders.map(message))).toEqual([
      { waiting: true },
      { waiting: true },
    ]);
    const responses = contenders.map(message);
    for (const child of contenders) child.send("start");
    const results = await Promise.all(responses);
    expect(results.filter((value) => value.ready)).toHaveLength(1);
    expect(results.filter((value) => value.error === "PROJECT_IN_USE")).toHaveLength(1);
  });

  for (const stage of [
    "temporary-synced",
    "snapshot-published",
    "directory-synced",
  ] as CommitStage[]) {
    it(`在 ${stage} 强杀真实进程后只激活完整提交，并能按原 operationId 重试`, async () => {
      const store = await create();
      await store.close();
      const operationId = randomUUID();
      const child = worker(store.directory, stage, operationId);
      const ready = message(child);
      const reached = new Promise<void>((resolve) => {
        child.on("message", (value) => {
          if (typeof value === "object" && value && "stage" in value) resolve();
        });
      });
      expect(await ready).toMatchObject({ ready: true });
      await reached;
      await kill(child);
      const restored = await reopen(store.directory);
      expect(restored.snapshot.revision).toBe(stage === "temporary-synced" ? 1 : 2);
      await restored.rename({ operationId, expectedRevision: 1, name: "强杀恢复" });
      expect(restored.snapshot.revision).toBe(2);
    }, 15_000);
  }

  it("manifest 更新失败仍返回已提交结果，重新打开重建发现信息", async () => {
    const store = await create();
    const manifest = join(store.directory, "manifest.json");
    await rm(manifest);
    await mkdir(manifest);
    const request = { operationId: randomUUID(), expectedRevision: 1, name: "已提交" };
    expect((await store.rename(request)).revision).toBe(2);
    expect(store.warnings).toContain("快照已提交，manifest 更新失败；下次打开时重建");
    await store.close();
    await rm(manifest, { recursive: true });
    const restored = await reopen(store.directory);
    expect(await restored.rename(request)).toMatchObject({ revision: 2 });
    expect(JSON.parse(await readFile(manifest, "utf8"))).toMatchObject({
      name: "已提交",
      revision: 2,
    });
  });

  it("坏尾隔离保留，恢复上一版后允许重新提交", async () => {
    const store = await create();
    await store.rename({ operationId: randomUUID(), expectedRevision: 1, name: "损坏版本" });
    await store.close();
    const stateDirectory = join(store.directory, "state");
    const latest = (await readdir(stateDirectory)).sort().at(-1);
    if (!latest) throw new Error("缺少快照");
    await writeFile(join(stateDirectory, latest), "{截断");
    const restored = await reopen(store.directory);
    expect(restored.snapshot.revision).toBe(1);
    expect(restored.warnings[0]).toContain("损坏尾快照");
    expect(
      (await readdir(join(store.directory, ".runtime"))).some((name) =>
        name.startsWith("recovery-"),
      ),
    ).toBe(true);
    await restored.rename({ operationId: randomUUID(), expectedRevision: 1, name: "恢复编辑" });
    expect(restored.snapshot.revision).toBe(2);
  });

  it("同修订分叉与未来版本拒绝写入，锁在打开失败后释放", async () => {
    const store = await create();
    const { commitHash: _hash, ...body } = store.snapshot;
    await store.close();
    const stateDirectory = join(store.directory, "state");
    const forked = { ...body, name: "分叉" };
    const hash = contentHash(forked);
    const path = join(stateDirectory, `000000000001-${hash}.json`);
    await writeFile(path, canonicalJson({ ...forked, commitHash: hash }));
    await expect(ProjectStore.open(store.directory)).rejects.toMatchObject({
      code: "PROJECT_CORRUPT",
    });
    await rm(path);
    const original = (await readdir(stateDirectory))[0];
    if (!original) throw new Error("缺少快照");
    await writeFile(join(stateDirectory, original), JSON.stringify({ schemaVersion: 2 }));
    await expect(ProjectStore.open(store.directory)).rejects.toMatchObject({
      code: "PROJECT_VERSION_UNSUPPORTED",
    });
  });

  it("目录移动、锁替换、内部目录符号链接均停止写入", async () => {
    const store = await create();
    const moved = join(parent, "moved.linkstudio");
    await rename(store.directory, moved);
    await mkdir(store.directory);
    await expect(
      store.rename({ operationId: randomUUID(), expectedRevision: 1, name: "越界" }),
    ).rejects.toMatchObject({ code: "PROJECT_PATH_DENIED" });
    await store.close();
    const reopened = await reopen(moved);
    const lock = join(moved, ".runtime", "owner.lock");
    await rename(lock, `${lock}.old`);
    await writeFile(lock, "");
    await expect(
      reopened.rename({ operationId: randomUUID(), expectedRevision: 1, name: "旧owner" }),
    ).rejects.toMatchObject({ code: "PROJECT_PATH_DENIED" });
    await reopened.close();
    await rename(join(moved, "state"), join(moved, "old-state"));
    await symlink(join(moved, "old-state"), join(moved, "state"));
    await expect(ProjectStore.open(moved)).rejects.toMatchObject({ code: "PROJECT_PATH_DENIED" });
  });

  it("项目副本以目录身份独立加锁", async () => {
    const store = await create();
    const copy = join(parent, "copy.linkstudio");
    await cp(store.directory, copy, { recursive: true });
    const duplicate = await reopen(copy);
    expect(duplicate.snapshot.projectId).toBe(store.snapshot.projectId);
    await duplicate.rename({ operationId: randomUUID(), expectedRevision: 1, name: "副本" });
    expect(store.snapshot.revision).toBe(1);
  });

  it("发布前失败保留上一版并禁止当前会话继续提交", async () => {
    const store = await create();
    await store.close();
    const faulted = await ProjectStore.open(store.directory, {
      onStage: async () => {
        throw new Error("磁盘故障注入");
      },
    });
    stores.push(faulted);
    const request = { operationId: randomUUID(), expectedRevision: 1, name: "失败写入" };
    await expect(faulted.rename(request)).rejects.toMatchObject({ code: "PROJECT_SAVE_FAILED" });
    await expect(faulted.rename(request)).rejects.toMatchObject({ code: "PROJECT_SAVE_FAILED" });
    await faulted.close();
    expect((await reopen(store.directory)).snapshot.revision).toBe(1);
  });

  it("发布后发生错误按结果未知处理，重开后原请求返回已提交回执", async () => {
    const store = await create();
    await store.close();
    const faulted = await ProjectStore.open(store.directory, {
      onStage: async (stage) => {
        if (stage === "snapshot-published") throw new Error("发布后故障");
      },
    });
    stores.push(faulted);
    const request = { operationId: randomUUID(), expectedRevision: 1, name: "发布后中断" };
    await expect(faulted.rename(request)).rejects.toMatchObject({ code: "PROJECT_SAVE_FAILED" });
    await faulted.close();
    const restored = await reopen(store.directory);
    expect(restored.snapshot.revision).toBe(2);
    expect(await restored.rename(request)).toMatchObject({ revision: 2 });
  });

  it("中间快照损坏且存在后继时拒绝自动选择，缺失修订也拒绝", async () => {
    const store = await create();
    await store.rename({ operationId: randomUUID(), expectedRevision: 1, name: "第二版" });
    await store.rename({ operationId: randomUUID(), expectedRevision: 2, name: "第三版" });
    await store.close();
    const directory = join(store.directory, "state");
    const middle = (await readdir(directory)).sort()[1];
    if (!middle) throw new Error("缺少中间快照");
    await writeFile(join(directory, middle), "{坏链");
    await expect(ProjectStore.open(store.directory)).rejects.toMatchObject({
      code: "PROJECT_CORRUPT",
    });
    await rm(join(directory, middle));
    await expect(ProjectStore.open(store.directory)).rejects.toMatchObject({
      code: "PROJECT_CORRUPT",
    });
  });
});
