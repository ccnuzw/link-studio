import {
  type SkillInspection,
  type SkillItem,
  type SkillPickKind,
  type SkillResult,
  type SkillScope,
  skillLimits,
} from "@link-studio/core";
import { ArrowLeft, CloudUpload, FileArchive, FileText, FolderOpen, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SkillDialog } from "./skill-dialog";
import { ScopeFields, SkillFiles } from "./skill-files";

const choices = [
  { kind: "zip", Icon: FileArchive, label: "选择压缩包" },
  { kind: "folder", Icon: FolderOpen, label: "选择文件夹" },
  { kind: "markdown", Icon: FileText, label: "选择 SKILL.md" },
] as const;

export function SkillImport({
  dropped,
  close,
  imported,
}: {
  dropped: File[] | null;
  close: () => void;
  imported: (item: SkillItem, version: number) => void;
}) {
  const [inspection, setInspection] = useState<SkillInspection>();
  const [activity, setActivity] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [scopes, setScopes] = useState<SkillScope[]>([]);
  const busy = useRef(false);
  const stage = useRef<string | null>(null);
  const initialDrop = useRef(dropped);

  const inspect = useCallback(
    async (action: () => Promise<SkillResult<SkillInspection | null>>) => {
      if (busy.current) return;
      busy.current = true;
      setActivity("正在选择或预检技能包…");
      setError("");
      try {
        const result = await action();
        if (!result.ok) setError(result.message);
        else if (result.value) {
          stage.current = result.value.id;
          setInspection(result.value);
        }
      } finally {
        busy.current = false;
        setActivity("");
      }
    },
    [],
  );

  const drop = useCallback(
    (files: File[]) => {
      const file = files[0];
      if (busy.current) return;
      if (files.length !== 1 || !file) {
        setError("一次只能拖入一个 ZIP、文件夹或 SKILL.md。");
        return;
      }
      void inspect(() => window.desktop.skills.drop(file));
    },
    [inspect],
  );

  useEffect(() => {
    const files = initialDrop.current;
    if (files) {
      initialDrop.current = null;
      drop(files);
    }
  }, [drop]);

  function discard() {
    if (stage.current) void window.desktop.skills.discard({ id: stage.current });
    stage.current = null;
  }

  function pick(kind: SkillPickKind) {
    void inspect(() => window.desktop.skills.pick({ kind }));
  }

  async function confirm() {
    if (!inspection?.id || !inspection.plan || busy.current) return;
    busy.current = true;
    setActivity("正在保存技能…");
    setError("");
    const result = await window.desktop.skills.confirm({ id: inspection.id, enabled, scopes });
    busy.current = false;
    setActivity("");
    if (result.ok) {
      stage.current = null;
      imported(result.value, inspection.plan.version);
    } else setError(result.message);
  }

  return (
    <SkillDialog
      title="导入技能"
      busy={!!activity}
      close={() => {
        discard();
        close();
      }}
      steps={
        <ol className="skill-steps" aria-label="导入步骤">
          <li aria-current={!inspection ? "step" : undefined}>
            <span>1</span>选择文件
          </li>
          <li aria-current={inspection ? "step" : undefined}>
            <span>2</span>检查并导入
          </li>
        </ol>
      }
      footer={
        <>
          {inspection && (
            <button
              className="skill-back"
              type="button"
              disabled={!!activity}
              onClick={() => {
                discard();
                setInspection(undefined);
                setError("");
                setEnabled(false);
                setScopes([]);
              }}
            >
              <ArrowLeft size={16} />
              重新选择
            </button>
          )}
          <button
            type="button"
            disabled={!!activity}
            onClick={() => {
              discard();
              close();
            }}
          >
            取消
          </button>
          {inspection && (
            <button
              type="button"
              className="skill-primary"
              disabled={!!activity || !inspection.plan}
              onClick={() => void confirm()}
            >
              <Upload size={16} />
              确认导入
            </button>
          )}
        </>
      }
    >
      {!inspection ? (
        <section
          className="skill-drop"
          data-dragging={dragging}
          aria-label="技能包拖放区"
          aria-busy={!!activity}
          onDragOver={(event) => {
            event.preventDefault();
            if (!activity) setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            drop(Array.from(event.dataTransfer.files));
          }}
        >
          <span className="skill-drop-icon">
            <CloudUpload size={27} />
          </span>
          <h3>拖入技能包</h3>
          <div className="skill-actions">
            {choices.map(({ kind, Icon, label }) => (
              <button key={kind} type="button" disabled={!!activity} onClick={() => pick(kind)}>
                <Icon size={17} />
                {label}
              </button>
            ))}
          </div>
          <ul className="skill-limits">
            <li>ZIP ≤ {skillLimits.zipMiB} MB</li>
            <li>展开后 ≤ {skillLimits.totalMiB} MB</li>
            <li>≤ {skillLimits.files} 个文件</li>
            <li>单文件 ≤ {skillLimits.fileMiB} MB</li>
          </ul>
          {activity && <p role="status">{activity}</p>}
          {error && (
            <p className="skill-error" role="alert">
              {error}
            </p>
          )}
        </section>
      ) : (
        <div className="skill-review" aria-busy={!!activity}>
          <div className="skill-summary">
            <div>
              <h3>{inspection.title}</h3>
              <code>{inspection.name}</code>
              <p>{inspection.description}</p>
            </div>
            {inspection.plan && (
              <span className="skill-tag">
                {inspection.plan.action === "create" ? "新技能" : "新版本"} · v
                {inspection.plan.version}
              </span>
            )}
          </div>
          {inspection.error && (
            <p role="alert" className="skill-error">
              {inspection.error}
            </p>
          )}
          {inspection.plan?.action === "new_version" && (
            <p className="skill-note">导入后可在技能详情中切换到 v{inspection.plan.version}。</p>
          )}
          {inspection.warnings.length > 0 && (
            <ul className="skill-warnings">
              {inspection.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          {inspection.plan?.action === "create" && (
            <ScopeFields
              enabled={enabled}
              setEnabled={setEnabled}
              scopes={scopes}
              setScopes={setScopes}
              disabled={!!activity}
            />
          )}
          {inspection.id && (
            <SkillFiles
              key={inspection.id}
              files={inspection.files}
              target={{ id: inspection.id }}
            />
          )}
          {activity && <p role="status">{activity}</p>}
          {error && (
            <p className="skill-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </SkillDialog>
  );
}
