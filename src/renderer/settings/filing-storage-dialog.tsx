import type { SettingsInput } from "@link-studio/core";
import { useEffect, useState } from "react";
import { ModelModal } from "./model-editor";
import { settingsError } from "./settings-page";

export function FilingStorageDialog({ close }: { close: () => void }) {
  type Config = SettingsInput<"filingStorageSave">;
  const [form, setForm] = useState<Config>({
    provider: "s3",
    addressing: "auto",
    endpoint: "",
    region: "us-east-1",
    bucket: "",
    publicBase: "",
    accessKey: "",
    secretKey: "",
  });
  const provider = form.provider ?? "s3";
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    void window.desktop.settings
      .filingStorage({})
      .then((result) => {
        if (!active) return;
        if (result.ok && result.value) setForm({ ...result.value, accessKey: "", secretKey: "" });
        if (!result.ok) setNotice(settingsError(result.code));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <ModelModal
      title="图片对象存储"
      subtitle="使用 S3 兼容桶上传本机图片。存储密钥与方舟备案密钥独立。"
      close={() => {
        if (!busy) close();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          try {
            const result = await window.desktop.settings.filingStorageSave(form);
            if (result.ok) close();
            else setNotice(settingsError(result.code));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="model-dialog-body model-editor-form">
          <label>
            存储服务商
            <select
              value={provider}
              disabled={busy || loading}
              onChange={(event) => {
                const next = event.target.value as Config["provider"];
                setForm({
                  ...form,
                  provider: next,
                  endpoint: "",
                  region:
                    next === "aliyun_oss"
                      ? "cn-hangzhou"
                      : next === "tencent_cos"
                        ? "ap-guangzhou"
                        : next === "r2"
                          ? "auto"
                          : "us-east-1",
                  addressing: "auto",
                  accountId: "",
                  bucket: "",
                  publicBase: "",
                  accessKey: "",
                  secretKey: "",
                });
              }}
            >
              <option value="aliyun_oss">阿里云 OSS</option>
              <option value="tencent_cos">腾讯云 COS</option>
              <option value="s3">AWS S3 / 兼容</option>
              <option value="r2">Cloudflare R2</option>
            </select>
          </label>
          {provider === "r2" && (
            <label>
              Account ID
              <input
                required
                pattern="[0-9a-f]{32}"
                disabled={busy || loading}
                value={form.accountId ?? ""}
                onChange={(event) => setForm({ ...form, accountId: event.target.value })}
              />
            </label>
          )}
          {provider === "s3" && (
            <label>
              寻址方式
              <select
                value={form.addressing ?? "path"}
                disabled={busy || loading}
                onChange={(event) =>
                  setForm({ ...form, addressing: event.target.value as Config["addressing"] })
                }
              >
                <option value="auto">自动</option>
                <option value="virtual">虚拟主机</option>
                <option value="path">路径</option>
              </select>
            </label>
          )}
          {(
            [
              ["endpoint", "S3 端点"],
              ["region", "区域"],
              ["bucket", "桶名称"],
              ["publicBase", "公开读取地址（可选）"],
              ["accessKey", "存储 Access Key"],
              ["secretKey", "存储 Secret Key"],
            ] as const
          )
            .filter(
              ([key]) =>
                (key !== "endpoint" || provider === "s3") &&
                (key !== "region" || provider !== "r2"),
            )
            .map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  value={form[key]}
                  disabled={busy || loading}
                  type={
                    ["accessKey", "secretKey"].includes(key)
                      ? "password"
                      : ["endpoint", "publicBase"].includes(key)
                        ? "url"
                        : "text"
                  }
                  autoComplete="off"
                  required={["region", "bucket"].includes(key)}
                  onChange={(event) => setForm({ ...form, [key]: event.target.value })}
                />
              </label>
            ))}
          <small>
            公开地址留空时生成一小时有效的读取链接。同一存储不更换凭证时，两项密钥均留空。
          </small>
          {notice && <p role="alert">{notice}</p>}
        </div>
        <footer className="model-dialog-footer">
          <button type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button type="submit" disabled={busy || loading}>
            保存
          </button>
        </footer>
      </form>
    </ModelModal>
  );
}
