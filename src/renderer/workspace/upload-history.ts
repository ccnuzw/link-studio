import type { CreativeData } from "@link-studio/core";

export type UploadHistoryData = CreativeData & { uploadPending?: true };

export function liveUploadFields(
  saved: UploadHistoryData,
  current: UploadHistoryData,
): UploadHistoryData {
  const next = { ...saved };
  for (const key of ["assetId", "uploadFailed", "uploadPending", "mediaAspect"] as const) {
    if (current[key] === undefined) delete next[key];
    else Object.assign(next, { [key]: current[key] });
  }
  return next;
}

export function uploadTransition(before: UploadHistoryData, after: UploadHistoryData) {
  return !!(before.uploaded && after.uploaded && (before.uploadPending || after.uploadPending));
}
