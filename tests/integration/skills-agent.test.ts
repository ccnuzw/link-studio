import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CanvasAgentService } from "../../src/main/project/canvas-agent";
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

afterEach(async () => {
  await store.close();
  library.close();
  await rm(root, { recursive: true, force: true });
});

it("Agent 只搜索启用的 agent 技能，并读取当前生效版本", async () => {
  const file = join(root, "SKILL.md");
  await writeFile(file, packageText("版本一正文"));
  const first = library.stage(1, await readSkillPackage(file));
  library.confirm(1, { id: first.id ?? "", enabled: true, scopes: ["agent"] });

  const agent = new CanvasAgentService(null as never, async () => null as never, undefined, {
    catalog: (query) => library.agentCatalog(query),
    content: (name, version) => library.agentContent(name, version),
  });
  agent.attach(store);
  const project = agent.key(store);
  const search = await agent.command("skills", { project, query: "测试" });
  expect(search).toEqual([
    { id: "agent-fixture@1", title: "Agent 测试技能", summary: "只读测试说明" },
  ]);

  expect(await agent.command("skill", { project, id: "agent-fixture@1" })).toEqual({
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
  expect(await agent.command("skill", { project, id: "agent-fixture@2" })).toEqual({
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
  expect(library.agentContent("agent-fixture", 1)).toBeNull();
});
