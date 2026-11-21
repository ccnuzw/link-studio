import type { SkillItem, SkillResult } from "@link-studio/core";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { SkillDialog } from "./skill-dialog";
import { ScopeFields, SkillFiles } from "./skill-files";

export function SkillDetail({
  item,
  close,
  changed,
}: {
  item: SkillItem;
  close: () => void;
  changed: (item: SkillItem | null) => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [enabled, setEnabled] = useState(item.enabled);
  const [scopes, setScopes] = useState(item.scopes);
  const [selected, setSelected] = useState(item.activeVersion);
  const [pendingDelete, setPendingDelete] = useState<"skill" | number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const version =
    item.versions.find(({ version }) => version === selected) ??
    item.versions.find(({ version }) => version === item.activeVersion);
  const dirty =
    title !== item.title ||
    enabled !== item.enabled ||
    scopes.length !== item.scopes.length ||
    scopes.some((scope) => !item.scopes.includes(scope));

  async function run(action: () => Promise<SkillResult<SkillItem | null>>, message: string) {
    setBusy(true);
    setNotice("");
    setError("");
    const result = await action();
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    changed(result.value);
    setNotice(message);
    setPendingDelete(undefined);
  }

  return (
    <SkillDialog
      title="技能详情"
      close={close}
      busy={busy}
      footer={
        <>
          <button
            type="button"
            className="skill-back skill-danger"
            disabled={busy || !!pendingDelete}
            onClick={() => setPendingDelete("skill")}
          >
            <Trash2 size={16} />
            删除技能
          </button>
          <button type="button" disabled={busy} onClick={close}>
            关闭
          </button>
          <button
            type="button"
            className="skill-primary"
            disabled={busy || !dirty || !title.trim() || !!pendingDelete}
            onClick={() => {
              void run(async () => {
                const result = await window.desktop.skills.update({
                  name: item.name,
                  title,
                  enabled,
                  scopes,
                });
                if (result.ok) setTitle(result.value.title);
                return result;
              }, "设置已保存。");
            }}
          >
            保存设置
          </button>
        </>
      }
    >
      <div className="skill-review" aria-busy={busy}>
        <div className="skill-summary">
          <div>
            <h3>{item.title}</h3>
            <code>{item.name}</code>
          </div>
          <span className="skill-tag">生效版本 · v{item.activeVersion}</span>
        </div>
        {pendingDelete && (
          <div className="skill-confirm">
            <p>
              {pendingDelete === "skill"
                ? `删除「${item.title}」及其所有版本？`
                : `删除 v${pendingDelete}？`}{" "}
              此操作无法撤销。
            </p>
            <div className="skill-actions">
              <button type="button" disabled={busy} onClick={() => setPendingDelete(undefined)}>
                取消删除
              </button>
              <button
                type="button"
                disabled={busy}
                className="skill-danger"
                onClick={() => {
                  const action =
                    pendingDelete === "skill"
                      ? () => window.desktop.skills.remove({ name: item.name })
                      : () =>
                          window.desktop.skills.removeVersion({
                            name: item.name,
                            version: pendingDelete,
                          });
                  void run(action, "版本已删除。");
                }}
              >
                确认删除
              </button>
            </div>
          </div>
        )}
        <label className="skill-label">
          显示名称
          <input
            value={title}
            maxLength={128}
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <ScopeFields
          enabled={enabled}
          setEnabled={setEnabled}
          scopes={scopes}
          setScopes={setScopes}
          disabled={busy}
        />
        {version && (
          <>
            <div className="skill-version-bar">
              <label className="skill-label">
                版本{" "}
                <select
                  value={version.version}
                  disabled={busy || !!pendingDelete}
                  onChange={(event) => setSelected(Number(event.target.value))}
                >
                  {item.versions.map(({ version }) => (
                    <option key={version} value={version}>
                      v{version}
                      {version === item.activeVersion ? "（生效中）" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <span className="skill-note">{new Date(version.createdAt).toLocaleString()}</span>
              {version.version !== item.activeVersion && (
                <div className="skill-actions">
                  <button
                    type="button"
                    disabled={busy || !!pendingDelete}
                    onClick={() =>
                      void run(
                        () =>
                          window.desktop.skills.activate({
                            name: item.name,
                            version: version.version,
                          }),
                        `已切换到 v${version.version}。`,
                      )
                    }
                  >
                    设为生效版本
                  </button>
                  <button
                    type="button"
                    disabled={busy || !!pendingDelete}
                    onClick={() => setPendingDelete(version.version)}
                  >
                    删除此版本
                  </button>
                </div>
              )}
            </div>
            <p className="skill-note">{version.description}</p>
            <SkillFiles
              key={version.version}
              files={version.files}
              target={{ name: item.name, version: version.version }}
            />
          </>
        )}
        {error && (
          <p className="skill-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="skill-note" role="status">
            {notice}
          </p>
        )}
      </div>
    </SkillDialog>
  );
}
