import type { PluginView, SettingsValues } from "@link-studio/core";
import { CircleAlert, Loader2, Lock, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ModelModal } from "./model-editor";
import { reportPluginAction } from "./plugin-notice";
import { settingsError } from "./settings-page";
import { settingsRequests } from "./settings-request-log";

function deletionError(code: string, fallback: string) {
  return code === "PLUGIN_VERSION_MISSING"
    ? "插件不存在"
    : code === "PLUGIN_BUILTIN_LOCKED"
      ? "内置插件不能删除，只能停用"
      : code === "SETTINGS_ACTION_FAILED"
        ? fallback
        : settingsError(code);
}

export function PluginDelete({
  plugin,
  close,
  deleted,
  openModel,
}: {
  plugin: PluginView;
  close: () => void;
  deleted: () => void;
  openModel: (id: string, link: HTMLAnchorElement) => void;
}) {
  const [catalog, setCatalog] = useState<SettingsValues["pluginDeleteCheck"]>();
  const [checkError, setCheckError] = useState("");
  const read = useRef(0);
  const alive = useRef(false);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const check = useCallback(async () => {
    const current = ++read.current;
    setCheckError("");
    try {
      const result = await settingsRequests.pluginDeleteCheck({ key: plugin.key });
      if (current !== read.current) return;
      if (result.ok) setCatalog(result.value);
      else {
        const message = deletionError(result.code, "没能检查引用情况");
        setCheckError(message);
        reportPluginAction(message, "error");
      }
    } catch {
      if (current === read.current) setCheckError("没能检查引用情况");
    }
  }, [plugin.key]);
  useEffect(() => {
    alive.current = true;
    void check();
    return () => {
      alive.current = false;
      read.current++;
    };
  }, [check]);
  const { models = [], jobs = 0, builtin = false } = catalog ?? {};
  const blocked = Boolean(builtin || jobs || models.length);
  const remove = async () => {
    if (!catalog || blocked || busy || typed.trim() !== plugin.key) return;
    setBusy(true);
    setError("");
    try {
      const result = await settingsRequests.pluginRemove({ key: plugin.key, allVersions: true });
      if (!alive.current) return;
      if (result.ok) deleted();
      else {
        const message = result.issues?.[0]?.message ?? deletionError(result.code, "删除失败");
        setError(message);
        reportPluginAction(message, "error");
        void check();
      }
    } catch {
      if (alive.current) {
        setError("删除失败");
        reportPluginAction("删除失败", "error");
        void check();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <ModelModal
      variant="channel-delete"
      close={() => {
        if (!busy) close();
      }}
      headerIcon={
        <span className="channel-delete-icon" data-blocked={blocked}>
          {blocked ? <Lock size={16} /> : <Trash2 size={16} />}
        </span>
      }
      title={`${blocked ? "暂时不能删除" : "删除插件？"}「${plugin.name}」`}
      subtitle={blocked ? undefined : catalog ? "删除后不能撤销。" : "正在检查引用…"}
    >
      <div className="model-dialog-body reference-delete-body">
        {!catalog && !checkError && (
          <div className="delete-check-skeleton" role="status" aria-label="正在检查引用" />
        )}
        {checkError && (
          <div className="upload-error-heading" role="alert">
            <CircleAlert size={16} />
            <span>{checkError}</span>
            <button type="button" onClick={() => void check()}>
              重试
            </button>
          </div>
        )}
        {builtin && (
          <section className="channel-migration">
            <strong>
              <CircleAlert size={16} />
              内置插件不能删除，只能停用
            </strong>
          </section>
        )}
        {models.length > 0 && (
          <section className="channel-migration">
            <strong>
              <CircleAlert size={16} />
              {models.length} 个模型在用这个插件
            </strong>
            <div className="channel-migration-refs">
              {models.map((model) => (
                <a
                  key={model.id}
                  href={`#model=${encodeURIComponent(model.modelKey ?? model.id)}`}
                  onClick={(event) => {
                    event.preventDefault();
                    openModel(model.id, event.currentTarget);
                  }}
                >
                  {model.name}
                </a>
              ))}
            </div>
            <small>改用别的协议或删除这些模型后再删除插件</small>
          </section>
        )}
        {jobs > 0 && (
          <section className="channel-migration">
            <strong>
              <CircleAlert size={16} />
              {jobs} 个进行中的任务在用这个插件
            </strong>
          </section>
        )}
        {catalog && !blocked && (
          <>
            <div className="channel-delete-cascade">
              <div>
                <span>一起删除：</span>插件的全部版本代码
              </div>
              <div>
                <span>不受影响：</span>历史生成任务
              </div>
            </div>
            <label>
              <span>
                输入 <code>{plugin.key}</code> 确认
              </span>
              <input
                autoComplete="off"
                aria-label="输入名称确认删除"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
            </label>
          </>
        )}
        {error && (
          <div className="upload-error-heading" role="alert">
            <CircleAlert size={16} />
            <span>{error}</span>
          </div>
        )}
      </div>
      <footer className="model-dialog-footer">
        <button type="button" disabled={busy} onClick={close}>
          {blocked ? "关闭" : "取消"}
        </button>
        {!blocked && (
          <button
            type="button"
            className="model-danger"
            disabled={busy || !catalog || typed.trim() !== plugin.key}
            onClick={() => void remove()}
          >
            {busy ? <Loader2 className="settings-spin" size={16} /> : <Trash2 size={16} />}删除
          </button>
        )}
      </footer>
    </ModelModal>
  );
}
