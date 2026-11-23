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
import { canvasBounds, groupFrame } from "./canvas-agent-layout.ts";
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
      nodes.set(id, {
        id,
        type: "creative",
        position: op.position ?? { x: (original.size + index) * 40, y: 80 },
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
          },
          op,
          settings,
        ),
      });
    } else if (op.op === "create_group" || op.op === "set_group") {
      const previous = op.op === "set_group" ? resolve(op.id) : undefined;
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
      const add = (op.op === "create_group" ? op.memberIds : op.addMembers)?.map(member) ?? [];
      const remove = op.op === "set_group" ? (op.removeMembers?.map(member) ?? []) : [];
      if (remove.some((node) => node.parentId !== id))
        throw new ProjectError("CANVAS_OPERATION_INVALID", "成员不在该组内");
      if (op.op === "set_group" && !add.length && !remove.length && op.label === undefined)
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
      const frame = refit ? groupFrame(entries) : undefined;
      const position = frame
        ? { x: frame.x, y: frame.y }
        : (previous?.position ??
          (op.op === "create_group" ? op.position : undefined) ?? {
            x:
              Math.max(
                -120,
                ...all()
                  .filter((node) => node.type !== "unknown")
                  .map((node) => {
                    const rect = bounds(node);
                    return rect.x + rect.width;
                  }),
              ) + 120,
            y: 0,
          });
      nodes.set(id, {
        id,
        type: "group",
        position,
        width: frame?.width ?? previous?.width ?? 200,
        height: frame?.height ?? previous?.height ?? 140,
        data: { label: op.label ?? previous?.data.label ?? "组" },
      });
      if (frame)
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
      if (op.op === "move") nodes.set(node.id, { ...node, position: op.position });
      else if (node.type === "creative") {
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
        nodes.set(node.id, {
          ...node,
          data: editNodeGeneration(
            {
              ...node.data,
              label: op.label ?? node.data.label,
              text: op.prompt ?? node.data.text,
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
