import {
  type SkillFile,
  type SkillPreview,
  type SkillScope,
  type SkillsInput,
  skillScopes,
} from "@link-studio/core";
import { FileText } from "lucide-react";
import { useEffect, useState } from "react";

type PreviewTarget = { id: string } | { name: string; version: number };

export function SkillFiles({ files, target }: { files: SkillFile[]; target: PreviewTarget }) {
  const [selected, select] = useState(files[0]?.path);
  const [preview, setPreview] = useState<SkillPreview>();
  const [error, setError] = useState("");
  const { id, name, version } =
    "id" in target
      ? { id: target.id, name: undefined, version: undefined }
      : { id: undefined, name: target.name, version: target.version };
  useEffect(() => {
    if (!selected || (!id && (!name || version === undefined))) return;
    let ignore = false;
    const input: SkillsInput<"preview"> =
      name && version !== undefined
        ? { name, version, path: selected }
        : { id: id ?? "", path: selected };
    window.desktop.skills.preview(input).then((result) => {
      if (ignore) return;
      if (result.ok) setPreview(result.value);
      else setError(result.message);
    });
    return () => {
      ignore = true;
    };
  }, [id, name, version, selected]);
  return (
    <section className="skill-files" aria-label="包内文件">
      <div className="skill-file-list">
        <h3>
          包内文件 <span>{files.length}</span>
        </h3>
        {files.map(({ path }) => (
          <button
            type="button"
            key={path}
            aria-pressed={selected === path}
            title={path}
            onClick={() => {
              if (selected === path) return;
              setPreview(undefined);
              setError("");
              select(path);
            }}
          >
            <FileText size={15} />
            <span>{path}</span>
          </button>
        ))}
      </div>
      <div className="skill-file-preview">
        <h3>{selected}</h3>
        {error ? (
          <p role="alert">{error}</p>
        ) : preview ? (
          preview.text === null ? (
            <p>此文件不支持文本预览。</p>
          ) : (
            <>
              <pre>{preview.text || "（空文件）"}</pre>
              {preview.truncated && <p>仅显示文件开头的 1 MB。</p>}
            </>
          )
        ) : (
          <p role="status">正在读取…</p>
        )}
      </div>
    </section>
  );
}

export function ScopeFields({
  enabled,
  setEnabled,
  scopes,
  setScopes,
  disabled,
}: {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  scopes: SkillScope[];
  setScopes: (value: SkillScope[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="skill-scopes" disabled={disabled}>
      <legend>适用场景</legend>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        启用技能
      </label>
      <div>
        {(Object.keys(skillScopes) as SkillScope[]).map((scope) => (
          <label key={scope}>
            <input
              type="checkbox"
              checked={scopes.includes(scope)}
              onChange={(event) =>
                setScopes(
                  event.target.checked
                    ? [...scopes, scope]
                    : scopes.filter((current) => current !== scope),
                )
              }
            />
            {skillScopes[scope]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
