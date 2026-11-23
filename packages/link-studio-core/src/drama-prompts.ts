import { type Static, Type } from "@sinclair/typebox";
import { boardTemplateError } from "./drama-board.ts";

export const dramaPromptNames = {
  plan: "分集规划",
  scripts: "分集剧本",
  assets: "资产拆解",
  asset_prompts: "资产图提示词",
  video: "视频提示词",
  board: "故事板提示词",
} as const;
export const promptSteps = [
  "plan",
  "scripts",
  "assets",
  "asset_prompts",
  "video",
  "board",
] as const;
export type PromptStep = (typeof promptSteps)[number];
const step = Type.Union(promptSteps.map((key) => Type.Literal(key)));
const strict = { additionalProperties: false };
const id = Type.String({ pattern: "^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$" });
const name = Type.String({ minLength: 1, maxLength: 40 });
const body = Type.String({ minLength: 1, maxLength: 20000 });
const revision = Type.Integer({ minimum: 1 });
const entry = Type.Object({ id, name, body, revision, step }, strict);
export type DramaPromptEntry = Static<typeof entry>;
const skillId = Type.String({ pattern: "^skill:[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 69 });
const pick = Type.Union([id, skillId]);
export const PromptPicks = Type.Partial(
  Type.Object(
    { plan: pick, scripts: pick, assets: pick, asset_prompts: pick, video: pick, board: id },
    strict,
  ),
);
export type PromptPicks = Static<typeof PromptPicks>;
const change = Type.Union([pick, Type.Null()]);
export const PromptChanges = Type.Partial(
  Type.Object(
    {
      plan: change,
      scripts: change,
      assets: change,
      asset_prompts: change,
      video: change,
      board: Type.Union([id, Type.Null()]),
    },
    strict,
  ),
);
export type PromptChanges = Static<typeof PromptChanges>;
const skillSnapshot = Type.Object(
  {
    id: skillId,
    source: Type.Literal("skill"),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    step,
    revision,
    body: Type.String({ maxLength: 33000 }),
  },
  strict,
);
export type DramaSkillSnapshot = Static<typeof skillSnapshot>;
const snapshot = Type.Union([entry, skillSnapshot]);
export const PromptSnapshots = Type.Partial(
  Type.Object(
    {
      plan: snapshot,
      scripts: snapshot,
      assets: snapshot,
      asset_prompts: snapshot,
      video: snapshot,
      board: entry,
    },
    strict,
  ),
);
export type PromptSnapshots = Static<typeof PromptSnapshots>;
export const PromptLibraryRequest = Type.Union([
  Type.Object({ action: Type.Literal("list") }, strict),
  Type.Object(
    {
      action: Type.Literal("save"),
      id: Type.Optional(id),
      revision: Type.Integer({ minimum: 0 }),
      step,
      name,
      body,
    },
    strict,
  ),
  Type.Object({ action: Type.Literal("delete"), id, revision }, strict),
]);
export function dramaPromptProblem(step: PromptStep, name: string, body: string) {
  if (!name.trim()) return "请填写名称";
  if (name.trim().length > 40) return "名称不能超过 40 字";
  if (!body.trim()) return "正文不能为空";
  if (body.length > 20000) return "正文不能超过 20,000 字";
  return step === "board" ? boardTemplateError(body) : undefined;
}
