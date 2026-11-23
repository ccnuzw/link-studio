import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ProjectDialogsAPI, ProjectsAPI } from "./projects-api.ts";
import type { SettingsAPI } from "./settings-api.ts";

export { sanitizeFileName } from "./file-name.ts";

import type { SkillsAPI } from "./skills-api.ts";

export * from "./canvas.ts";
export type * from "./canvas-agent.ts";
export {
  canvasAgentMediaModels,
  isCanvasAgentAnswerValue,
  isCanvasAgentQuestionnaire,
  maxAgentDocumentBytes,
  maxAgentDocuments,
  maxAgentImages,
  readWorkspaceQuestions,
} from "./canvas-agent.ts";
export * from "./canvas-exchange.ts";
export * from "./canvas-layout.ts";
export * from "./channel-validation.ts";
export * from "./director.ts";
export * from "./drama-board.ts";
export * from "./drama-image-params.ts";
export * from "./drama-prompts.ts";
export * from "./generation.ts";
export * from "./grid-split.ts";
export * from "./media-generation.ts";
export * from "./model-config.ts";
export * from "./model-price.ts";
export * from "./projects-api.ts";
export type * from "./settings-api.ts";
export {
  defaultAgentLayout,
  defaultCanvasView,
  EditableModelDocument,
  providerPluginSourceLimit,
} from "./settings-api.ts";
export * from "./skills-api.ts";
export * from "./video-canvas-exchange.ts";
export { canvasVideoDuration } from "./video-canvas-parameters.ts";

export const APP_INFO_CHANNEL = "link-studio:app:get-info";
export const OPEN_SOURCE_CHANNEL = "link-studio:app:open-source";

export function sourceWebUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 8192) return;
  try {
    const url = new URL(raw);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password)
      return url.href;
  } catch {}
}

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
  settings: SettingsAPI;
  skills: SkillsAPI;
  app: { getInfo(): Promise<DesktopResult<AppInfo>>; openSource(url: string): Promise<boolean> };
  dialogs: ProjectDialogsAPI;
  projects: ProjectsAPI;
  projectEvents: {
    onAgentChanged(listener: (sessionId: string) => void): () => void;
    onExportProgress(listener: (event: ProjectExportProgress) => void): () => void;
    onLibraryChanged(listener: () => void): () => void;
  };
  canvasWindow: {
    setNoticeCanvas(handle: string | null, hidden: boolean): void;
    setPending(pending: boolean): void;
    onSaveBeforeClose(save: () => Promise<boolean>): () => void;
  };
}

export type ProjectExportProgress = {
  operationId: string;
  stage: "preparing" | "encoding" | "validating" | "importing" | "completed";
  progress: number;
};

export function isAppInfoRequest(value: unknown): value is AppInfoRequest {
  return Value.Check(AppInfoRequestSchema, value);
}

export function isAppInfo(value: unknown): value is AppInfo {
  return Value.Check(AppInfoSchema, value);
}
export * from "./agent-context-usage.ts";
export * from "./drama.ts";
export * from "./image-display-size.ts";
