import type { SkillItem } from "@link-studio/core";
import {
  boardTemplate,
  type DramaPromptEntry,
  dramaPromptNames,
  dramaPromptProblem,
  type PromptPicks,
  type PromptSnapshots,
  type PromptStep,
  promptSteps,
  type SettingsInput,
} from "@link-studio/core";
import { ArrowLeft, Check, ChevronDown, Pencil, Plus, Trash2 } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import assets from "../../../packages/provider-runtime/runner/dramaoutput/prompts/asset_prompts_draft.md?raw";
import breakdown from "../../../packages/provider-runtime/runner/dramaoutput/prompts/breakdown_draft.md?raw";
import planning from "../../../packages/provider-runtime/runner/dramaoutput/prompts/plan_draft.md?raw";
import scripts from "../../../packages/provider-runtime/runner/dramaoutput/prompts/scripts_draft.md?raw";
import video from "../../../packages/provider-runtime/runner/dramaoutput/prompts/storyboard_draft.md?raw";
import { PlaceholderEditor } from "./drama-placeholder-editor";
import { FieldMenu } from "./drama-start-style";

function stageSkills(skills: SkillItem[], step: string) {
  return skills.flatMap((item) => {
    if (!item.scopes.some((scope) => scope === step)) return [];
    const version = item.versions.find((version) => version.version === item.activeVersion);
    return version
      ? [{ id: `skill:${item.name}`, title: item.title, description: version.description }]
      : [];
  });
}

function editableSection(template: string) {
  return template.match(/^## 提示词正文\n([\s\S]*?)\n## /m)?.[1]?.trim() ?? "";
}
const builtin = {
  plan: editableSection(planning),
  scripts: editableSection(scripts),
  assets: editableSection(breakdown),
  asset_prompts: editableSection(assets),
  video: editableSection(video),
  board: boardTemplate,
};
type Draft = { step: PromptStep; item?: DramaPromptEntry };
const errors: Record<string, string> = {
  SETTINGS_PROMPT_CONFLICT: "这条提示词在别处被修改过，请返回后重新打开",
  SETTINGS_PROMPT_DUPLICATE: "这个环节里已有同名提示词",
  SETTINGS_PROMPT_INVALID: "提示词正文或名称不符合要求",
};

export function useStartPrompts(open: boolean, projectPicks?: PromptPicks) {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [entries, setEntries] = useState<DramaPromptEntry[]>([]),
    [picks, setPicks] = useState<PromptPicks>(projectPicks ?? {});
  const [draft, setDraft] = useState<Draft>(),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false);
  function choose(step: PromptStep, id?: string) {
    setPicks((previous) => {
      const next = { ...previous };
      if (id) next[step] = id;
      else delete next[step];
      return next;
    });
  }
  useEffect(() => {
    if (!open) {
      setDraft(undefined);
      setReady(false);
      setError("");
      return;
    }
    let live = true;
    void Promise.all([
      window.desktop.settings.dramaPromptLibrary({ action: "list" }),
      window.desktop.skills.list({}),
    ])
      .then(([result, catalog]) => {
        if (!live) return;
        if (!result.ok || !catalog.ok) {
          setError("提示词库加载失败，请关闭后重试");
          return;
        }
        setSkills(catalog.value);
        setEntries(result.value.entries);
        setReady(true);
        if (!projectPicks)
          setPicks((previous) =>
            Object.fromEntries(
              Object.entries(previous).filter(
                ([step, id]) =>
                  result.value.entries.some((entry) => entry.step === step && entry.id === id) ||
                  stageSkills(catalog.value, step).some((skill) => skill.id === id),
              ),
            ),
          );
      })
      .catch(() => {
        if (live) setError("提示词库加载失败，请关闭后重试");
      });
    return () => {
      live = false;
    };
  }, [open, projectPicks]);
  async function mutate(input: SettingsInput<"dramaPromptLibrary">) {
    const result = await window.desktop.settings.dramaPromptLibrary(input);
    if (!result.ok) throw Error(errors[result.code] ?? "保存失败，请稍后重试");
    setEntries(result.value.entries);
    return result.value.saved;
  }
  return {
    entries,
    skills,
    picks,
    setPicks,
    choose,
    draft,
    setDraft,
    error,
    setError,
    ready,
    mutate,
  };
}
type Library = ReturnType<typeof useStartPrompts>;

export const legacyBoardPick = "project-template";
export function PromptRows({
  library,
  container,
  saved,
  script = true,
}: {
  library: Library;
  container: RefObject<HTMLDialogElement | null>;
  saved?: PromptSnapshots;
  script?: boolean;
}) {
  return (
    <div className="drama-prompts">
      <span>提示词</span>
      <div>
        {promptSteps.map((step) => {
          const label = dramaPromptNames[step];
          if (script && (step === "plan" || step === "scripts"))
            return (
              <div className="drama-prompt-row" key={step}>
                <span>{label}</span>
                <button
                  type="button"
                  className="drama-field-trigger"
                  disabled
                  title="剧本直接导入，不改编"
                >
                  剧本直接导入
                  <ChevronDown size={16} />
                </button>
              </div>
            );
          const entries = library.entries.filter((entry) => entry.step === step),
            selected = entries.find((entry) => entry.id === library.picks[step]);
          const pick = library.picks[step];
          const snapshot = saved?.[step];
          const skills = stageSkills(library.skills, step);
          const skill = skills.find((item) => item.id === pick);
          const displayName =
            snapshot && pick === snapshot.id ? snapshot.name : (selected?.name ?? skill?.title);
          const missing = !!displayName && library.ready && !selected && !skill;
          const value = displayName
            ? `${pick?.startsWith("skill:") ? "技能" : "我的"} · ${displayName}`
            : pick === legacyBoardPick
              ? "项目模板"
              : "内置";
          return (
            <div className="drama-prompt-row" key={step} data-missing={missing || undefined}>
              <span>{label}</span>
              <FieldMenu
                container={container}
                kind="prompt"
                label={label}
                value={value}
                title={missing ? "来源已被删除或停用，已建的任务照常使用快照" : undefined}
              >
                {(close) => (
                  <>
                    <button
                      type="button"
                      className="drama-menu-row"
                      aria-pressed={!pick}
                      onClick={() => {
                        library.choose(step);
                        close();
                      }}
                    >
                      内置 <small>推荐</small>
                      {!pick && <Check size={16} />}
                    </button>
                    <small>我的提示词</small>
                    {entries.map((entry) => (
                      <div className="drama-prompt-choice" key={entry.id}>
                        <button
                          type="button"
                          className="drama-menu-row"
                          aria-pressed={entry.id === selected?.id}
                          onClick={() => {
                            library.choose(step, entry.id);
                            close();
                          }}
                        >
                          {entry.name}
                          {entry.id === selected?.id && <Check size={16} />}
                        </button>
                        <button
                          type="button"
                          aria-label={`编辑 ${entry.name}`}
                          onClick={() => {
                            close();
                            library.setDraft({ step, item: entry });
                          }}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          aria-label={`删除 ${entry.name}`}
                          onClick={async () => {
                            try {
                              await library.mutate({
                                action: "delete",
                                id: entry.id,
                                revision: entry.revision,
                              });
                              if (selected?.id === entry.id) library.choose(step);
                            } catch (error) {
                              library.setError(String(error));
                            }
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      disabled={!library.ready}
                      className="drama-menu-row"
                      onClick={() => {
                        close();
                        library.setDraft({ step });
                      }}
                    >
                      <Plus size={16} />
                      新建
                    </button>
                    <small>技能</small>
                    {skills.length ? (
                      skills.map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          className="drama-menu-row drama-skill-choice"
                          aria-pressed={pick === item.id}
                          onClick={() => {
                            library.choose(step, item.id);
                            close();
                          }}
                        >
                          <span>
                            <span>{item.title}</span>
                            <small>{item.description}</small>
                          </span>
                          {pick === item.id && <Check size={16} />}
                        </button>
                      ))
                    ) : (
                      <button
                        type="button"
                        className="drama-menu-row"
                        disabled
                        title="后台还没有给技能标这个环节"
                      >
                        暂无适用技能
                      </button>
                    )}
                  </>
                )}
              </FieldMenu>
            </div>
          );
        })}
      </div>
      {library.error && <p role="alert">{library.error}</p>}
    </div>
  );
}

export function PromptEditor({ draft, library }: { draft: Draft; library: Library }) {
  const { step, item } = draft;
  const [name, setName] = useState(item?.name ?? ""),
    [body, setBody] = useState(item?.body ?? builtin[step]),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  async function save() {
    const problem = dramaPromptProblem(step, name, body);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    try {
      const id = await library.mutate({
        action: "save",
        ...(item && { id: item.id }),
        revision: item?.revision ?? 0,
        step,
        name: name.trim(),
        body,
      });
      library.choose(step, id);
      library.setDraft(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "保存失败");
      setSaving(false);
    }
  }
  return (
    <div className="drama-prompt-editor">
      <header>
        <button
          type="button"
          disabled={saving}
          aria-label="返回"
          onClick={() => library.setDraft(undefined)}
        >
          <ArrowLeft size={16} />
        </button>
        <strong>
          {dramaPromptNames[step]} · {item ? "编辑" : "新建"}
        </strong>
      </header>
      <input
        autoFocus
        aria-label="名称"
        placeholder="名称"
        maxLength={40}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <div>
        {step === "board" ? (
          <PlaceholderEditor
            ariaLabel="提示词正文"
            value={body}
            onChange={setBody}
            className="drama-prompt-body"
          />
        ) : (
          <textarea
            aria-label="提示词正文"
            className="drama-prompt-body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        )}
        <small>{body.length.toLocaleString("en-US")} / 20,000</small>
      </div>
      {error && <p role="alert">{error}</p>}
      <footer>
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            setBody(builtin[step]);
            setError("");
          }}
        >
          恢复内置
        </button>
        <button type="button" disabled={saving} onClick={() => void save()}>
          保存
        </button>
      </footer>
    </div>
  );
}
