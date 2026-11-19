import { type AppInfo, type DesktopResult, isAppInfoRequest } from "@link-studio/core";

export function getAppInfo(
  request: unknown,
  trusted: boolean,
  info: AppInfo,
): DesktopResult<AppInfo> {
  if (!trusted) {
    return { ok: false, error: { code: "FORBIDDEN", message: "当前页面无权访问桌面能力" } };
  }
  if (!isAppInfoRequest(request)) {
    return { ok: false, error: { code: "INVALID_ARGUMENT", message: "请求格式无效" } };
  }
  return { ok: true, data: info };
}
