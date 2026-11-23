import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { skillsRequests } from "@link-studio/core";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readSkillPackage } from "../../src/main/skills/intake";
import { SkillLibrary } from "../../src/main/skills/library";

let directory: string;
let library: SkillLibrary | undefined;
const skill = (body: string) =>
  `---\nname: shot-list\ntitle: 镜头清单\ndescription: >-\n  整理\n  镜头列表\n---\n${body}\n`;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "link-skills-test-"));
});
afterEach(async () => {
  library?.close();
  library = undefined;
  await rm(directory, { recursive: true, force: true });
});

function zipEntry(path: string, content: string) {
  const name = Buffer.from(path);
  const bytes = Buffer.from(content);
  const checksum = crc32(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + bytes.length, 16);
  return Buffer.concat([local, name, bytes, central, name, end]);
}

it("读取单文件、带目录的 ZIP 或目录，规范化后同内容去重", async () => {
  const file = join(directory, "skill.md");
  const archive = join(directory, "shot-list.zip");
  const folder = join(directory, "shot-list");
  await mkdir(folder);
  await Promise.all([
    writeFile(file, skill("镜头 01")),
    writeFile(archive, zipEntry("shot-list/SKILL.md", skill("镜头 01"))),
    writeFile(join(folder, "SKILL.md"), skill("镜头 01")),
    writeFile(join(folder, ".DS_Store"), "ignored"),
  ]);
  const packages = await Promise.all([file, archive, folder].map(readSkillPackage));
  expect(new Set(packages.map(({ hash }) => hash)).size).toBe(1);
  for (const pkg of packages) {
    expect(pkg).toMatchObject({
      name: "shot-list",
      title: "镜头清单",
      description: "整理 镜头列表",
    });
    expect([...pkg.files.keys()]).toEqual(["SKILL.md"]);
  }
});

it("拒绝路径越界、符号链接、错误的 YAML、多个入口和过大文件", async () => {
  const archive = join(directory, "invalid.zip");
  const file = join(directory, "SKILL.md");
  await writeFile(archive, zipEntry("../SKILL.md", skill("unsafe")));
  await expect(readSkillPackage(archive)).rejects.toThrow("不安全的文件路径");
  await rm(archive);
  await writeFile(file, "---\nname: Bad_Name\ndescription: 示例\n---\n");
  await expect(readSkillPackage(file)).rejects.toThrow("name 必须");
  const child = join(directory, "child");
  await mkdir(child);
  await writeFile(join(child, "SKILL.md"), skill("another"));
  await expect(readSkillPackage(directory)).rejects.toThrow("多个 SKILL.md");
  await rm(child, { recursive: true });
  if (process.platform !== "win32") {
    await symlink(file, join(directory, "link.md"));
    await expect(readSkillPackage(directory)).rejects.toThrow("符号链接");
  }
  await writeFile(file, Buffer.alloc((25 << 20) + 1));
  await expect(readSkillPackage(file)).rejects.toThrow("文件过大");
});

it("预检暂存绑定窗口，同名新增版本并保留生效版本和配置", async () => {
  const file = join(directory, "SKILL.md");
  await writeFile(file, skill("版本 1"));
  const first = await readSkillPackage(file);
  const db = join(directory, "library");
  library = new SkillLibrary(db);
  const stage = library.stage(1, first);
  const request = { id: stage.id ?? "", enabled: true, scopes: ["agent" as const] };
  expect(Value.Check(skillsRequests.confirm, request)).toBe(true);
  expect(Value.Check(skillsRequests.confirm, { ...request, scopes: ["agent", "agent"] })).toBe(
    false,
  );
  expect(Value.Check(skillsRequests.confirm, { ...request, scopes: ["unknown"] })).toBe(false);
  expect(library.list()).toEqual([]);
  expect(library.preview(1, { id: request.id, path: "SKILL.md" }).text).toContain("版本 1");
  expect(() => library?.confirm(2, request)).toThrow("暂存已失效");
  const created = library.confirm(1, request);
  expect(library.stage(1, first)).toMatchObject({
    plan: null,
    error: expect.stringContaining("已有的 v1"),
  });
  await writeFile(file, skill("版本 2"));
  const next = library.stage(1, await readSkillPackage(file));
  expect(next.plan).toEqual({ action: "new_version", version: 2 });
  expect(library.confirm(1, { id: next.id ?? "", enabled: false, scopes: [] })).toMatchObject({
    activeVersion: 1,
    enabled: true,
    scopes: ["agent"],
  });
  expect(() => library?.removeVersion({ name: created.name, version: 1 })).toThrow("切换生效版本");
  library.activate({ name: created.name, version: 2 });
  library.removeVersion({ name: created.name, version: 1 });
  library.update({
    name: created.name,
    title: "拍摄清单",
    enabled: true,
    scopes: ["agent", "video"],
  });
  library.close();
  library = new SkillLibrary(db);
  expect(library.list()).toMatchObject([
    { title: "拍摄清单", activeVersion: 2, versions: [{ version: 2 }] },
  ]);
  expect(library.catalog("video")).toMatchObject([{ name: created.name, version: 2 }]);
  expect(library.preview(1, { name: created.name, version: 2, path: "SKILL.md" }).text).toContain(
    "版本 2",
  );
  expect(() => library?.remove({ name: created.name })).toThrow("关闭所有使用场景");
  library.update({ name: created.name, title: "拍摄清单", enabled: false, scopes: ["video"] });
  expect(library.catalog("video")).toHaveLength(1);
  expect(() => library?.remove({ name: created.name })).toThrow("关闭所有使用场景");
  library.update({ name: created.name, title: "拍摄清单", enabled: false, scopes: [] });
  library.remove({ name: created.name });
  expect(library.list()).toEqual([]);
  expect(() => library?.preview(1, { name: created.name, version: 2, path: "SKILL.md" })).toThrow(
    "找不到此文件",
  );
});

it("导出指定历史版本可原样回导，预检提示随版本保留", async () => {
  const folder = join(directory, "source");
  await mkdir(folder);
  const path = join(folder, "SKILL.md");
  await writeFile(
    path,
    skill("参考 references/missing.md").replace("name:", "allowed-tools: [read]\nname:"),
  );
  await writeFile(join(folder, "helper.py"), "print(1)");
  const pkg = await readSkillPackage(folder);
  library = new SkillLibrary(join(directory, "db"));
  const imported = library.confirm(1, {
    id: library.stage(1, pkg).id!,
    enabled: false,
    scopes: [],
  });
  const warnings = imported.versions[0]!.warnings?.join("\n");
  for (const text of ["allowed-tools", "references/missing.md", "脚本"])
    expect(warnings).toContain(text);
  await writeFile(path, skill("下一版"));
  const next = library.stage(1, await readSkillPackage(folder));
  library.confirm(1, { id: next.id!, enabled: false, scopes: [] });
  const zip = join(directory, "export.zip");
  await writeFile(zip, library.exportZip({ name: pkg.name, version: 1 }));
  expect((await readSkillPackage(zip)).hash).toBe(pkg.hash);
});

it("环节绑定校验试跑归属、结果、时效，持久钉版与失效回退", async () => {
  const db = join(directory, "db"),
    file = join(directory, "SKILL.md");
  library = new SkillLibrary(db);
  await writeFile(file, skill("第一版方法"));
  const pkg = await readSkillPackage(file);
  library.confirm(1, { id: library.stage(1, pkg).id!, enabled: true, scopes: ["agent"] });
  const candidate = { source: "skill" as const, name: pkg.name, version: 1 },
    step = "marketing.create" as const;
  const details = {
    candidate,
    step,
    model: "test",
    sample: "perfume",
    passed: true,
    preview: "样例",
    issues: [],
  };
  const { identity } = library.method(candidate);
  const good = library.recordTrial(details, identity),
    bad = library.recordTrial({ ...details, passed: false }, identity);
  const bind = { step, candidate, trial: good.id };
  for (const invalid of [
    { ...bind, trial: bad.id },
    { ...bind, candidate: { source: "builtin" as const } },
    { ...bind, step: "marketing.follow" as const },
  ])
    expect(() => library!.bind(invalid)).toThrow("试跑");
  try {
    vi.useFakeTimers();
    vi.setSystemTime(good.finished + 86400001);
    expect(() => library!.bind(bind)).toThrow("24 小时");
  } finally {
    vi.useRealTimers();
  }
  library.bind(bind);
  await writeFile(file, skill("第二版方法"));
  const next = library.stage(1, await readSkillPackage(file));
  library.confirm(1, { id: next.id!, enabled: false, scopes: [] });
  library.activate({ name: pkg.name, version: 2 });
  library.close();
  library = new SkillLibrary(db);
  expect(library.resolveMethod(step)).toMatchObject({
    candidate,
    fallback: false,
    method: { Version: 1, Body: "第一版方法" },
  });
  library.removeVersion({ name: pkg.name, version: 1 });
  expect(library.resolveMethod(step)).toMatchObject({
    candidate,
    fallback: true,
    method: { Source: "builtin" },
  });
  expect(() => library!.bind(bind)).toThrow("试跑");
  library.update({ name: pkg.name, title: pkg.title, enabled: false, scopes: [] });
  library.remove({ name: pkg.name });
  library.confirm(1, { id: library.stage(1, pkg).id!, enabled: true, scopes: ["agent"] });
  expect(library.resolveMethod(step).fallback).toBe(true);
  expect(() => library!.bind(bind)).toThrow("试跑");
});
