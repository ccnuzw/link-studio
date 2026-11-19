import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

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
