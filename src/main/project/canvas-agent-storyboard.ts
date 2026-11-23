import {
  type CanvasShot,
  maxStoryboardShots,
} from "../../../packages/link-studio-core/src/canvas.ts";
import type { AgentStoryboardPatch } from "../../../packages/link-studio-core/src/canvas-agent.ts";
import { ProjectError } from "./errors.ts";

function invalid(message: string): never {
  throw new ProjectError("CANVAS_OPERATION_INVALID", message);
}

export function editStoryboard(
  previous: CanvasShot[],
  patch: AgentStoryboardPatch,
  newId: () => string,
) {
  let clamped = false;
  const write = (
    fields: NonNullable<AgentStoryboardPatch["shots"]>[number],
    existing?: CanvasShot,
  ): CanvasShot => {
    if (!existing && !fields.scene?.trim()) invalid("新镜头要写画面描述");
    if (!Object.keys(fields).length) invalid("镜头没有要改的字段");
    const shot = {
      ...(existing ?? {
        id: newId(),
        scene: "",
        shot: "中景",
        camera: "固定",
        action: "",
        dialogue: "",
        duration: 3,
      }),
      ...fields,
    };
    for (const key of ["scene", "action", "dialogue"] as const) {
      const value = fields[key]?.trim();
      if (value === undefined) continue;
      if ((key === "scene" && !value) || Array.from(value).length > 1000)
        invalid("检查镜头描述或对白长度");
      shot[key] = value;
    }
    if (fields.duration !== undefined) {
      shot.duration = Math.round(Math.max(1, Math.min(60, fields.duration)) * 10) / 10;
      clamped ||= shot.duration !== fields.duration;
    }
    return shot;
  };
  if (!patch.shots && !patch.edits?.length) invalid("请提供镜头列表或修改步骤");
  const shots = patch.shots?.map((fields) => write(fields)) ?? [...previous];
  for (const edit of patch.edits ?? []) {
    if (edit.op === "insert") {
      if (edit.after > shots.length) invalid("镜头插入位置越界");
      shots.splice(edit.after, 0, write(edit.set));
      continue;
    }
    const index = edit.no - 1;
    const current = shots[index];
    if (!current) invalid(`没有第 ${edit.no} 镜`);
    if (edit.op === "update") shots[index] = write(edit.set, current);
    else {
      if (edit.op === "move" && edit.to > shots.length) invalid("镜头移动位置越界");
      shots.splice(index, 1);
      if (edit.op === "move") shots.splice(edit.to - 1, 0, current);
    }
  }
  if (shots.length > maxStoryboardShots) invalid(`分镜表最多 ${maxStoryboardShots} 镜`);
  return { shots, clamped };
}
