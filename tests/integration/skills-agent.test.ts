import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { addCanvasGateway } from "../../packages/agent-runtime/src/canvas-gateway";
import { addDramaGateway } from "../../packages/agent-runtime/src/drama-gateway";
import { createLocalGateway } from "../../packages/agent-runtime/src/gateway";
import { SpikeTargets } from "../../packages/agent-runtime/src/targets";
import { CanvasAgentService } from "../../src/main/project/canvas-agent";
import { createDrama, dramaDocument } from "../../src/main/project/drama";
import { ProjectStore } from "../../src/main/project/store";
import { readSkillPackage } from "../../src/main/skills/intake";
import { SkillLibrary } from "../../src/main/skills/library";

let root: string;
let library: SkillLibrary;
let store: ProjectStore;

const packageText = (body: string) => `---
name: agent-fixture
title: Agent 测试技能
description: 只读测试说明
---
${body}
`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "link-skills-agent-"));
  library = new SkillLibrary(join(root, "library"));
  store = await ProjectStore.create(root, "Agent 技能测试");
});

it("短剧按生效版本及环节冻结技能，引用链排除脚本、二进制和循环", async () => {
  const folder = join(root, "fixture");
  await mkdir(join(folder, "scripts"), { recursive: true });
  const body = "读 z.md 和 a.md 及 scripts/omit.md、skip.PY、binary、invalid。";
  await Promise.all(
    Object.entries({
      "SKILL.md": packageText(body),
      "z.md": "读 deep.md",
      "a.md": "再读 z.md",
      "deep.md": "末尾",
      "scripts/omit.md": "跳过",
      "skip.PY": "跳过",
      binary: Buffer.from([0]),
      invalid: Buffer.from([255]),
    }).map(([path, content]) => writeFile(join(folder, path), content)),
  );
  const stage = async () =>
    library.confirm(1, {
      id: library.stage(1, await readSkillPackage(folder)).id!,
      enabled: false,
      scopes: ["video"],
    });
  await stage();
  const read = library.dramaSnapshot.bind(library);
  expect(read("assets", "agent-fixture")).toBeUndefined();
  const first = read("video", "agent-fixture")!;
  expect(first.body.split("<skill>\n")[1]).toBe(
    `${body}\n\n## z.md\n读 deep.md\n\n## a.md\n再读 z.md\n\n## deep.md\n末尾\n</skill>`,
  );
  await createDrama(
    store,
    { title: "镜头", script: "来客推门。", prompts: { video: first.id } },
    [],
    [],
    () => [],
    read,
  );
  await writeFile(join(folder, "SKILL.md"), packageText("🎥".repeat(16001)));
  await stage();
  expect(read("video", "agent-fixture")).toEqual(first);
  library.activate({ name: "agent-fixture", version: 2 });
  expect(read("video", "agent-fixture")?.body.split("<skill>\n")[1]).toBe(
    `${"🎥".repeat(16000)}\n</skill>`,
  );
  library.update({ name: "agent-fixture", title: "改名", enabled: true, scopes: ["agent"] });
  expect(read("video", "agent-fixture")).toBeUndefined();
  expect(dramaDocument(store.snapshot)?.prompt_snapshots?.video).toEqual(first);
});

afterEach(async () => {
  await store.close();
  library.close();
  await rm(root, { recursive: true, force: true });
});

it("画布与短剧按运行固定版本、分段读取资源；撤销场景即失效", async () => {
  await createDrama(store, { title: "短剧", script: "来客推门。" });
  const folder = join(root, "references-test");
  await mkdir(folder);
  const install = async (body: string) => {
    await writeFile(join(folder, "SKILL.md"), packageText(body));
    await writeFile(join(folder, "例子.md"), body + "镜".repeat(30000));
    library.confirm(1, {
      id: library.stage(1, await readSkillPackage(folder)).id!,
      enabled: true,
      scopes: ["agent"],
    });
  };
  await install("一版");
  const agent = new CanvasAgentService(null as never, async () => null as never, undefined, {
    catalog: library.agentCatalog.bind(library),
    page: library.agentPage.bind(library),
  });
  agent.attach(store);
  const projectId = agent.key(store),
    targets = new SpikeTargets(":memory:");
  const bridge = async (command: string, args: unknown) =>
    command === "model"
      ? { name: "mock", context_window: 32768, max_tokens: 1024 }
      : agent.command(command.slice(7), args);
  const platform = addDramaGateway(
    addCanvasGateway(createLocalGateway({ targets }), targets, bridge),
    targets,
    bridge,
  );
  try {
    const contexts = (["canvas", "drama"] as const).map((kind) => {
      const scope = { kind, projectId },
        { engineId } = targets.scope(scope);
      targets.bindSession(kind, scope);
      return {
        user_id: "1",
        canvas_id: engineId,
        session_id: kind,
        run_id: kind,
        mode: kind === "canvas" ? "all" : "drama",
      };
    });
    for (const context of contexts) {
      const prepared = await platform.prepare(context);
      expect(prepared.system_prompt).toContain("agent-fixture@1");
      expect(prepared.tools.map((tool) => tool.name)).toContain("skill_read");
      const read = await platform.tool(
        context,
        "skill_read",
        { name: "agent-fixture" },
        { toolCallId: "r" },
      );
      expect(JSON.parse(read.content).files).toContainEqual(
        expect.objectContaining({ path: "例子.md" }),
      );
    }
    await install("二版");
    library.activate({ name: "agent-fixture", version: 2 });
    for (const context of contexts) {
      const args = { name: "agent-fixture", file: "例子.md" };
      const first = await platform.tool(context, "skill_read", args, { toolCallId: "f" });
      expect(first.tool_end?.summary).toContain("@v1/例子.md");
      const page = JSON.parse(first.content);
      const next = JSON.parse(
        (
          await platform.tool(
            context,
            "skill_read",
            { ...args, offset: page.nextOffset },
            { toolCallId: "f2" },
          )
        ).content,
      );
      expect(page.text + next.text).toBe("一版" + "镜".repeat(30000));
      await platform.endRun(context);
      expect(
        JSON.parse(
          (
            await platform.tool({ ...context, run_id: "new" }, "skill_read", args, {
              toolCallId: "n",
            })
          ).content,
        ).id,
      ).toBe("agent-fixture@2");
    }
    library.update({ name: "agent-fixture", title: "停用", enabled: false, scopes: ["video"] });
    for (const context of contexts)
      expect(
        (
          await platform.tool(
            { ...context, run_id: "new" },
            "skill_read",
            { name: "agent-fixture" },
            { toolCallId: "n2" },
          )
        ).is_error,
      ).toBe(true);
  } finally {
    targets.close();
  }
});

it("Agent 只搜索启用的 agent 技能，并读取当前生效版本", async () => {
  const file = join(root, "SKILL.md");
  await writeFile(file, packageText("版本一正文"));
  const first = library.stage(1, await readSkillPackage(file));
  library.confirm(1, { id: first.id ?? "", enabled: true, scopes: ["agent"] });

  const agent = new CanvasAgentService(null as never, async () => null as never, undefined, {
    catalog: (query) => library.agentCatalog(query),
    page: library.agentPage.bind(library),
  });
  agent.attach(store);
  const project = agent.key(store);
  const targets = new SpikeTargets(":memory:");
  try {
    const scope = { kind: "canvas" as const, projectId: project };
    const { engineId } = targets.scope(scope);
    targets.bindSession("session", scope);
    const gateway = addCanvasGateway(createLocalGateway({ targets }), targets, (command, args) =>
      agent.command(command.slice("canvas:".length), args),
    );
    const context = {
      user_id: "1",
      canvas_id: engineId,
      session_id: "session",
      run_id: "run",
      mode: "all",
    };
    const invoke = (name: string, args: unknown) =>
      gateway.tool(context, name, args, { toolCallId: name });
    expect((await invoke("skill_search", { query: "无匹配" })).content).toBe("[]");
    const catalog = JSON.parse((await invoke("skill_search", { query: "测试" })).content);
    expect(catalog[0].id).toBe("agent-fixture@1");
    expect(JSON.parse((await invoke("skill_read", { id: catalog[0].id })).content).text).toContain(
      "版本一正文",
    );
  } finally {
    targets.close();
  }
  const search = await agent.command("skills", { project, query: "测试" });
  expect(search).toEqual([
    { id: "agent-fixture@1", title: "Agent 测试技能", summary: "只读测试说明" },
  ]);

  expect(await agent.command("skill", { project, id: "agent-fixture@1" })).toMatchObject({
    id: "agent-fixture@1",
    text: expect.stringContaining("版本一正文"),
  });

  await writeFile(file, packageText("版本二正文"));
  const second = library.stage(1, await readSkillPackage(file));
  library.confirm(1, { id: second.id ?? "", enabled: true, scopes: ["agent"] });
  library.activate({ name: "agent-fixture", version: 2 });
  expect(await agent.command("skills", { project, query: "" })).toEqual([
    { id: "agent-fixture@2", title: "Agent 测试技能", summary: "只读测试说明" },
  ]);
  expect(await agent.command("skill", { project, id: "agent-fixture@1" })).toBeNull();
  expect(await agent.command("skill", { project, id: "agent-fixture@2" })).toMatchObject({
    id: "agent-fixture@2",
    text: expect.stringContaining("版本二正文"),
  });
});

it("Agent 不读取未启用或非 agent scope 的技能", async () => {
  const file = join(root, "SKILL.md");
  await writeFile(file, packageText("受保护正文"));
  const staged = library.stage(1, await readSkillPackage(file));
  library.confirm(1, { id: staged.id ?? "", enabled: false, scopes: ["plan"] });
  expect(library.agentCatalog()).toEqual([]);
  expect(library.agentPage("agent-fixture@1", 0)).toBeNull();
});
