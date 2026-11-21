import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ProjectDialogsAPI, ProjectsAPI } from "./projects-api.ts";
import type { SettingsAPI } from "./settings-api.ts";
import type { SkillsAPI } from "./skills-api.ts";

export * from "./canvas.ts";
export type * from "./canvas-agent.ts";
export {
  canvasAgentMediaModels,
  isCanvasAgentAnswerValue,
  isCanvasAgentQuestionnaire,
} from "./canvas-agent.ts";
export * from "./canvas-exchange.ts";
export * from "./director.ts";
export * from "./generation.ts";
export * from "./grid-split.ts";
export * from "./media-generation.ts";
export * from "./model-config.ts";
export * from "./projects-api.ts";
export type * from "./settings-api.ts";
export { providerPluginSourceLimit } from "./settings-api.ts";
export * from "./skills-api.ts";

export const APP_INFO_CHANNEL = "link-studio:app:get-info";

export const AppInfoRequestSchema = Type.Object(
  { requestId: Type.String({ pattern: "^[a-f0-9-]{36}$" }) },
  { additionalProperties: false },
);

export const AppInfoSchema = Type.Object(
  {
    productName: Type.Literal("灵可"),
    agentName: Type.Literal("小灵"),
    version: Type.String({ maxLength: 64 }),
    platform: Type.String({ maxLength: 32 }),
    arch: Type.String({ maxLength: 32 }),
    electron: Type.String({ maxLength: 64 }),
    chromium: Type.String({ maxLength: 64 }),
    node: Type.String({ maxLength: 64 }),
    packaged: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type AppInfo = Static<typeof AppInfoSchema>;
export type AppInfoRequest = Static<typeof AppInfoRequestSchema>;

export type DesktopResult<Data> =
  | { ok: true; data: Data }
  | { ok: false; error: { code: "INVALID_ARGUMENT" | "FORBIDDEN" | "INTERNAL"; message: string } };

export interface DesktopAPI {
  app: { getInfo(): Promise<DesktopResult<AppInfo>> };
}

export function isAppInfoRequest(value: unknown): value is AppInfoRequest {
  return Value.Check(AppInfoRequestSchema, value);
}

export function isAppInfo(value: unknown): value is AppInfo {
  return Value.Check(AppInfoSchema, value);
}
