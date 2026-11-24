import type { SettingsValues } from "@link-studio/core";
import type {
  CanvasCharacter,
  CanvasOperation,
  CanvasShot,
  EditableCanvasNode,
  ProjectCanvasView,
} from "../../../packages/link-studio-core/src/canvas.ts";
import type {
  AgentStoryboardPatch,
  CanvasAgentOps,
} from "../../../packages/link-studio-core/src/canvas-agent.ts";
import type { ProjectState } from "../../../packages/link-studio-core/src/project.ts";
import {
  canvasBounds,
  freeCanvasPosition,
  groupFrame,
  refitAndPushGroups,
} from "./canvas-agent-layout.ts";
import { editNodeGeneration } from "./canvas-agent-model";
import { editStoryboard } from "./canvas-agent-storyboard.ts";
import { ProjectError } from "./errors.ts";

function editCharacter(
  patch: Partial<Pick<CanvasCharacter, "name" | "look" | "description" | "voicePrompt">>,
  previous?: CanvasCharacter,
): CanvasCharacter {
  const name = patch.name?.trim() ?? previous?.name;
  if (!name) throw new ProjectError("CANVAS_OPERATION_INVALID", "角色卡需要角色名");
  const result: CanvasCharacter = {
    ...previous,
    name,
    look:
      patch.look !== undefined ? patch.look.trim() || "基础形象" : (previous?.look ?? "基础形象"),
    description: patch.description?.trim() ?? previous?.description ?? "",
    extraAssetIds: previous?.extraAssetIds ?? [],
  };
  if (patch.voicePrompt !== undefined) {
    const voicePrompt = patch.voicePrompt.trim();
    if (voicePrompt) result.voicePrompt = voicePrompt;
    else delete result.voicePrompt;
  }
  return result;
}

export function compileAgentOps(
  canvas: ProjectCanvasView,
  { ops }: CanvasAgentOps,
  makeId: (index: number) => string,
  assets: ProjectState["assets"],
  settings: SettingsValues["list"],
) {
  const original = new Map(canvas.nodes.map((node) => [node.id, node]));
  const aliases = new Map<string, string>();
  const nodes = new Map<string, EditableCanvasNode>();
  const edges: CanvasOperation[] = [];
  const touched = new Set<string>();
  const refitGroups = new Set<string>();
  const explicitPositions = new Set<string>();
  const pending = new Set<string>();
  const warnings: string[] = [];
  let nextShot = -1;
  const shotsFor = (index: number, shots: CanvasShot[], patch: AgentStoryboardPatch) => {
    const result = editStoryboard(shots, patch, () => makeId(nextShot--));
    if (result.clamped)
      warnings.push(`第 ${index + 1} 项：有镜头的时长超出 1–60 秒或多于 1 位小数，已修正`);
    return result.shots;
  };
  const current = (id: string) => {
    const node = nodes.get(id) ?? original.get(id);
    if (!node || node.type === "unknown")
      throw new ProjectError("CANVAS_OPERATION_INVALID", "节点不可编辑");
    return node;
  };
  const resolve = (ref: string) => {
    const node = current(aliases.get(ref) ?? ref);
    if (original.has(node.id)) touched.add(node.id);
    return node;
  };
  const register = (id: string, tempId?: string) => {
    if (!tempId) return;
    if (aliases.has(tempId) || original.has(tempId) || nodes.has(tempId))
      throw new ProjectError("CANVAS_OPERATION_INVALID", "临时 ID 重复");
    aliases.set(tempId, id);
  };
  const bounds = (node: EditableCanvasNode) => canvasBounds(node, current, assets);
  const all = () => [...new Map([...original, ...nodes]).values()];
  for (const [index, op] of ops.entries()) {
    if (op.op === "create_node") {
      const id = makeId(index);
      register(id, op.tempId);
      if (op.position) explicitPositions.add(id);
      const parent = op.parentGroup ? resolve(op.parentGroup) : undefined;
      if (parent && parent.type !== "group")
        throw new ProjectError("CANVAS_OPERATION_INVALID", "parentGroup 需要指向组框");
      let position = op.position;
      if (parent) {
        refitGroups.add(parent.id);
        if (!position) {
          const members = all().filter(
            (node) => node.type === "creative" && node.parentId === parent.id,
          );
          const right = members.reduce((edge, member) => {
            const width = bounds(current(member.id)).width;
            return Math.max(edge, member.position.x + width);
          }, -Infinity);
          const last = members.at(-1);
          position = last ? { x: right + 120, y: last.position.y } : { x: 48, y: 72 };
        }
      }
      const board = op.kind === "storyboard";
      if (op.kind !== "character" && op.character)
        throw new ProjectError("CANVAS_OPERATION_INVALID", "请选择角色卡");
      const character = op.kind === "character" ? editCharacter(op.character ?? {}) : undefined;
      if (
        board
          ? op.prompt !== undefined ||
            op.model !== undefined ||
            op.mode ||
            Object.keys(op.params ?? {}).length
          : op.storyboard !== undefined
      )
        throw new ProjectError("CANVAS_OPERATION_INVALID", "请检查分镜表字段");
      if (!parent && !position) pending.add(id);
      nodes.set(id, {
        id,
        type: "creative",
        position: position ?? { x: 0, y: 0 },
        ...(parent && { parentId: parent.id }),
        data: editNodeGeneration(
          {
            kind: op.kind === "storyboard" ? "script" : op.kind === "character" ? "image" : op.kind,
            ...(character ? { character } : {}),
            ...(board
              ? { storyboard: op.storyboard ? shotsFor(index, [], op.storyboard) : [] }
              : {}),
            label:
              op.label ??
              {
                script: "文本",
                image: "图片",
                video: "视频",
                audio: "音频",
                storyboard: "分镜表",
                character: `${character?.name} · ${character?.look}`,
              }[op.kind],
            text: op.prompt ?? "",
            ...(op.kind === "script" &&
              op.prompt !== undefined && {
                textStatus: op.prompt.trim() ? "done" : "idle",
              }),
          },
          op,
          settings,
        ),
      });
    } else if (op.op === "create_group" || op.op === "set_group") {
      let previous = op.op === "set_group" ? resolve(op.id) : undefined;
      if (previous && previous.type !== "group")
        throw new ProjectError("CANVAS_OPERATION_INVALID", "目标不是组框");
      const id = previous?.id ?? makeId(index);
      if (op.op === "create_group") register(id, op.tempId);
      const member = (ref: string) => {
        const node = resolve(ref);
        if (node.type !== "creative")
          throw new ProjectError("CANVAS_OPERATION_INVALID", "组框不能嵌套");
        return node;
      };
      if (
        previous &&
        pending.has(id) &&
        op.op === "set_group" &&
        (op.addMembers?.length || op.removeMembers?.length)
      ) {
        const editable = all().filter((node) => node.type !== "unknown");
        const children = editable.filter(
          (node) => node.type === "creative" && node.parentId === id,
        );
        if (children.length) {
          const frame = groupFrame(children.map(bounds));
          const position = freeCanvasPosition(editable, pending, bounds);
          for (const child of children) {
            const absolute = bounds(child);
            nodes.set(child.id, {
              ...child,
              position: { x: absolute.x - frame.x, y: absolute.y - frame.y },
            });
          }
          previous = { ...previous, position, width: frame.width, height: frame.height };
          nodes.set(id, previous);
        }
        pending.delete(id);
      }
      const add = (op.op === "create_group" ? op.memberIds : op.addMembers)?.map(member) ?? [];
      const remove = op.op === "set_group" ? (op.removeMembers?.map(member) ?? []) : [];
      if (previous && (add.length || remove.length)) refitGroups.add(id);
      if (op.op === "create_group" && op.position && !add.length) explicitPositions.add(id);
      if (remove.some((node) => node.parentId !== id))
        throw new ProjectError("CANVAS_OPERATION_INVALID", "成员不在该组内");
      if (
        op.op === "set_group" &&
        !add.length &&
        !remove.length &&
        op.label === undefined &&
        op.color === undefined &&
        op.labelColor === undefined
      )
        throw new ProjectError("CANVAS_OPERATION_INVALID", "没有要修改的内容");
      for (const node of remove) {
        const { parentId, ...rest } = node;
        const { x, y } = bounds(node);
        nodes.set(node.id, { ...rest, position: { x, y } });
      }
      const members = new Map(
        all()
          .filter((node) => node.type === "creative" && node.parentId === id)
          .map((node) => [node.id, node]),
      );
      const removed = new Set(remove.map((node) => node.id));
      for (const node of add) if (!removed.has(node.id)) members.set(node.id, node);
      const entries = [...members.values()]
        .filter((node) => node.type === "creative")
        .map((node) => ({ node, ...bounds(node) }));
      const refit = entries.length && (add.length || remove.length);
      if (refit && all().some((node) => node.type === "unknown" && node.parentId === id))
        throw new ProjectError("CANVAS_OPERATION_INVALID", "组含有不可编辑成员");
      const frame = refit && !previous ? groupFrame(entries) : undefined;
      const position = frame
        ? { x: frame.x, y: frame.y }
        : (previous?.position ??
          (op.op === "create_group" ? op.position : undefined) ?? { x: 0, y: 0 });
      if (op.op === "create_group" && !op.position && !frame) pending.add(id);
      const data = { ...previous?.data, label: op.label ?? previous?.data.label ?? "组" };
      for (const field of ["color", "labelColor"] as const) {
        const hue = op[field];
        if (hue === "") delete data[field];
        else if (hue !== undefined) data[field] = hue;
      }
      nodes.set(id, {
        id,
        type: "group",
        position,
        width: frame?.width ?? previous?.width ?? 200,
        height: frame?.height ?? previous?.height ?? 140,
        data,
      });
      if (refit)
        for (const { node, x, y } of entries)
          nodes.set(node.id, {
            ...node,
            parentId: id,
            position: { x: x - position.x, y: y - position.y },
          });
    } else if (op.op === "connect") {
      edges.push({
        type: "putEdge",
        edge: { id: makeId(index), source: resolve(op.source).id, target: resolve(op.target).id },
      });
    } else {
      const node = resolve(op.id);
      if (op.op === "move") {
        pending.delete(node.id);
        explicitPositions.add(node.id);
        if (node.type === "creative" && node.parentId) refitGroups.add(node.parentId);
        nodes.set(node.id, { ...node, position: op.position });
      } else if (node.type === "creative") {
        if (
          node.data.director ||
          (op.character && !node.data.character) ||
          (node.data.storyboard
            ? op.prompt !== undefined ||
              op.model !== undefined ||
              op.mode ||
              Object.keys(op.params ?? {}).length
            : op.storyboard !== undefined)
        )
          throw new ProjectError("CANVAS_OPERATION_INVALID", "此节点不支持指定编辑");
        const updated = {
          ...node.data,
          label: op.label ?? node.data.label,
          text: op.prompt ?? node.data.text,
        };
        if (node.data.kind === "script" && op.prompt !== undefined) {
          updated.textStatus = op.prompt.trim() ? "done" : "idle";
          delete updated.textError;
          delete updated.textFailureTask;
        }
        nodes.set(node.id, {
          ...node,
          data: editNodeGeneration(
            {
              ...updated,
              ...(op.character
                ? { character: editCharacter(op.character, node.data.character) }
                : {}),
              ...(op.storyboard
                ? { storyboard: shotsFor(index, node.data.storyboard ?? [], op.storyboard) }
                : {}),
            },
            op,
            settings,
          ),
        });
      } else throw new ProjectError("CANVAS_OPERATION_INVALID", "请选择创作节点");
    }
  }
  if (refitGroups.size || pending.size || explicitPositions.size) {
    const editable = new Map(
      all()
        .filter((node) => node.type !== "unknown")
        .map((node) => [node.id, node]),
    );
    warnings.push(
      ...refitAndPushGroups(canvas, editable, refitGroups, assets, explicitPositions, pending),
    );
    for (const node of editable.values()) {
      if (node !== original.get(node.id)) nodes.set(node.id, node);
    }
  }
  const operations: CanvasOperation[] = [...nodes.values()].map((node) => ({
    type: "putNode",
    node,
  }));
  return {
    operations: [...operations, ...edges],
    touched: [...touched],
    created: Object.fromEntries(aliases),
    warnings,
  };
}
