import type { PluginView, SettingsValues } from "@link-studio/core";
import { CircleAlert, Loader2 } from "lucide-react";
import { useState } from "react";
import { compareCore } from "./catalog-version-order";
import { ModelModal } from "./model-editor";
import { reportPluginAction } from "./plugin-notice";
import { settingsError } from "./settings-page";
import { settingsRequests } from "./settings-request-log";

export function upgradeSnapshot(
  latest: PluginView,
  options: SettingsValues["pluginUpgradeOptions"],
) {
  const targets = options.filter((entry) => compareCore(entry.version, latest.version) < 0);
  if (targets.length) return { latest, targets };
}

type UpgradeReport = SettingsValues["pluginUpgradeAll"];

export function PluginUpgrade({
  plan: { latest, targets },
  close,
  refresh,
}: {
  plan: NonNullable<ReturnType<typeof upgradeSnapshot>>;
  close: () => void;
  refresh: () => Promise<SettingsValues["list"] | undefined>;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UpgradeReport>();
  const [upgradedTotal, setUpgradedTotal] = useState(0);
  const [error, setError] = useState("");
  const failed = result?.failed ?? [];
  const retry = failed.length > 0;
  async function run() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await settingsRequests.pluginUpgradeAll({ key: latest.key, approve: true });
      if (!response.ok) {
        const message =
          response.code === "PLUGIN_DISABLED"
            ? "插件已停用"
            : response.code === "PLUGIN_VERSION_MISSING"
              ? "插件不存在"
              : settingsError(response.code);
        setError(message);
        reportPluginAction(message, "error");
        return;
      }
      const next = response.value;
      setResult(next);
      setUpgradedTotal((total) => total + next.upgraded);
      if (next.upgraded) {
        reportPluginAction(`${next.upgraded} 个模型已升级到 v${next.toVersion}`);
        await refresh();
      }
      if (!next.failed.length) close();
    } catch {
      setError("升级失败");
      reportPluginAction("升级失败", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <ModelModal
      variant="plugin-upgrade"
      title={
        retry
          ? `${failed.length} 个模型升级失败`
          : `把 ${targets.length} 个模型升级到 v${latest.version}？`
      }
      subtitle={
        retry
          ? `已升级 ${upgradedTotal} 个，失败项保持原样`
          : "进行中的任务按旧版本跑完；新版本未声明的协议设置项会被丢弃。"
      }
      close={() => {
        if (!busy) close();
      }}
    >
      <ul className="plugin-upgrade-list" aria-label={retry ? "升级失败的模型" : "要升级的模型"}>
        {retry
          ? failed.map((item) => (
              <li key={item.id}>
                <strong>{targets.find(({ id }) => id === item.id)?.name || item.model}</strong>
                <small>{item.reason ?? settingsError(item.code)}</small>
              </li>
            ))
          : targets.map((item) => (
              <li key={item.id}>
                <strong>{item.name}</strong>
                <span>{item.channel}</span>
                <code>
                  v{item.version} → v{latest.version}
                </code>
              </li>
            ))}
      </ul>
      {error && (
        <div role="alert" className="upload-error-heading">
          <CircleAlert size={16} />
          <span>{error}</span>
        </div>
      )}
      <footer className="model-dialog-footer">
        <button type="button" disabled={busy} onClick={close}>
          取消
        </button>
        <button
          type="button"
          className="settings-primary"
          disabled={busy}
          onClick={() => void run()}
        >
          {busy && <Loader2 size={16} className="settings-spin" />}
          {retry ? "重试失败项" : "全部升级"}
        </button>
      </footer>
    </ModelModal>
  );
}
