import { type ComponentProps, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { RenderFilingPicker } from "../settings/filing-library";
import { settingsError } from "../settings/settings-page";
import { AssetPickerDialog } from "./asset-picker-dialog";

type Services = Omit<ComponentProps<typeof AssetPickerDialog>, "capacity" | "confirm" | "close">;

export function FilingAssetPicker({
  services,
  request,
}: {
  services: Services;
  request: Parameters<RenderFilingPicker>[0];
}) {
  const { channel, humanId, name, close, done } = request;
  const [members, setMembers] = useState<Set<string>>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setMembers(undefined);
    setFailed(false);
    void window.desktop.projects
      .listAssets({ projectHandle: services.handle, filingChannelId: channel.id })
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          setFailed(true);
          return;
        }
        setMembers(
          new Set(
            result.value.assets
              .filter((asset) => asset.metadata.filingHumanName)
              .flatMap((asset) => [
                asset.assetId,
                ...(typeof asset.metadata.libraryItemId === "string"
                  ? [asset.metadata.libraryItemId]
                  : []),
              ]),
          ),
        );
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [services.handle, channel.id, channel.revision, attempt]);
  return createPortal(
    <AssetPickerDialog
      {...services}
      filingChannelId={channel.id}
      capacity={1}
      lockedKind="image"
      dialogTitle="选择图片"
      confirmLabel="添加并提交备案"
      close={close}
      feedback={
        failed ? (
          <p role="alert">
            无法读取渠道的图片归属。
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              重试
            </button>
          </p>
        ) : (
          services.feedback
        )
      }
      reasonOf={(asset) =>
        !members
          ? failed
            ? "图片归属未知"
            : "正在读取图片归属"
          : members.has(asset.assetId) || members.has(String(asset.metadata.libraryItemId))
            ? "已在真人库"
            : undefined
      }
      confirm={async ([asset]) => {
        if (!asset) return "请先选择图片";
        const result = await window.desktop.projects.enrollImage({
          projectHandle: services.handle,
          assetId: asset.assetId,
          channelId: channel.id,
          channelRevision: channel.revision,
          humanId,
          name,
        });
        if (!result.ok) return result.error.message ?? "图片备案失败";
        if ("error" in result.value) return settingsError(result.value.error);
        done(
          result.value.status === "failed"
            ? "图片已加入真人库，提交方舟失败，可在详情重新提交。"
            : "图片已加入真人库并提交审核。",
        );
      }}
    />,
    document.body,
  );
}
