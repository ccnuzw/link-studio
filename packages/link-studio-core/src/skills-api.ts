import { type Static, Type as T } from "@sinclair/typebox";

export const skillScopes = {
  agent: "画布 Agent",
  plan: "分集规划",
  scripts: "分集剧本",
  assets: "资产拆解",
  asset_prompts: "资产图提示词",
  video: "视频提示词",
} as const;

export const skillLimits = { zipMiB: 50, totalMiB: 100, fileMiB: 25, files: 500 } as const;

const scopeKeys = Object.keys(skillScopes) as (keyof typeof skillScopes)[];
const scope = T.Union(scopeKeys.map((key) => T.Literal(key)));
const scopes = T.Array(scope, { maxItems: scopeKeys.length, uniqueItems: true });
const name = T.String({ maxLength: 64, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" });
const path = T.String({ minLength: 1, maxLength: 512 });
const version = T.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const id = T.String({ pattern: "^[a-f0-9-]{36}$" });
const pickKind = T.Union([T.Literal("zip"), T.Literal("folder"), T.Literal("markdown")]);
const request = { additionalProperties: false } as const;

export const skillsRequests = {
  list: T.Object({}, request),
  pick: T.Object({ kind: pickKind }, request),
  drop: T.Object({ path: T.String({ minLength: 1, maxLength: 32768 }) }, request),
  discard: T.Object({ id }, request),
  confirm: T.Object({ id, enabled: T.Boolean(), scopes }, request),
  update: T.Object(
    { name, title: T.String({ minLength: 1, maxLength: 128 }), enabled: T.Boolean(), scopes },
    request,
  ),
  activate: T.Object({ name, version }, request),
  removeVersion: T.Object({ name, version }, request),
  remove: T.Object({ name }, request),
  preview: T.Union([T.Object({ id, path }, request), T.Object({ name, version, path }, request)]),
} as const;

export type SkillScope = keyof typeof skillScopes;
export type SkillPickKind = Static<typeof pickKind>;
export type SkillFile = { path: string; size: number };
export type SkillVersion = {
  version: number;
  description: string;
  createdAt: string;
  files: SkillFile[];
};
export type SkillItem = {
  name: string;
  title: string;
  origin: "local" | "builtin";
  enabled: boolean;
  scopes: SkillScope[];
  activeVersion: number;
  versions: SkillVersion[];
};
export type SkillInspection = {
  id: string | null;
  name: string;
  title: string;
  description: string;
  files: SkillFile[];
  warnings: string[];
  error?: string;
  plan: { action: "create" | "new_version"; version: number } | null;
};
export type SkillPreview = { text: string | null; truncated: boolean };
export type SkillResult<Value> = { ok: true; value: Value } | { ok: false; message: string };
export type SkillsMethod = keyof typeof skillsRequests;
export type SkillsInput<Method extends SkillsMethod> = Static<(typeof skillsRequests)[Method]>;
export type SkillsValues = {
  list: SkillItem[];
  pick: SkillInspection | null;
  drop: SkillInspection;
  discard: null;
  confirm: SkillItem;
  update: SkillItem;
  activate: SkillItem;
  removeVersion: SkillItem;
  remove: null;
  preview: SkillPreview;
};

export type SkillsAPI = {
  [Method in Exclude<SkillsMethod, "drop">]: (
    input: SkillsInput<Method>,
  ) => Promise<SkillResult<SkillsValues[Method]>>;
} & { drop(file: File): Promise<SkillResult<SkillInspection>> };
