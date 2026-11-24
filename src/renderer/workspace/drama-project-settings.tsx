import {
  boardTemplateError,
  type DramaDocument,
  dramaAgentModels,
  type PromptChanges,
  type PromptPicks,
  type ProviderView,
  promptSteps,
} from "@link-studio/core";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DramaStartModel } from "./drama-start-model";
import { legacyBoardPick, PromptEditor, PromptRows, useStartPrompts } from "./drama-start-prompts";

export function DramaProjectSettings({
  projectHandle,
  document,
  models,
  onSaved,
  onClose,
}: {
  projectHandle: string;
  document: DramaDocument;
  models: ProviderView[];
  onSaved: (doc: DramaDocument) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [revision] = useState(document.board_settings_revision ?? 1);
  const initial = document.board_settings;
  const [agents, setAgents] = useState<ProviderView[]>([]);
  const [textModel, setTextModel] = useState(initial?.textModel ?? "");
  const [characterModel, setCharacterModel] = useState(initial?.characterModel ?? "");
  const [sceneModel, setSceneModel] = useState(initial?.sceneModel ?? "");
  const [propModel, setPropModel] = useState(initial?.propModel ?? "");
  const [boardModel, setBoardModel] = useState(initial?.boardModel ?? "");
  const [original] = useState<PromptPicks>(() => {
    const picks: PromptPicks = {};
    for (const step of promptSteps) picks[step] = document.prompt_snapshots?.[step]?.id;
    if (!picks.board && initial?.template) picks.board = legacyBoardPick;
    return picks;
  });
  const library = useStartPrompts(true, original);
  const legacy = library.picks.board === legacyBoardPick;
  const [template, setTemplate] = useState(initial?.template ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const problem = legacy ? boardTemplateError(template) : undefined;
  useEffect(() => {
    dialog.current?.showModal();
    let live = true;
    void window.desktop.settings
      .list({})
      .then((result) => {
        if (!live) return;
        if (result.ok) setAgents(dramaAgentModels(result.value.providers));
        else setError(`无法读取模型列表（${result.code}）`);
      })
      .catch(() => {
        if (live) setError("无法读取模型列表");
      });
    return () => {
      live = false;
    };
  }, []);
  async function save() {
    if (saving || problem) return;
    const prompts: PromptChanges = {};
    for (const step of promptSteps) {
      if (library.picks[step] !== original[step]) prompts[step] = library.picks[step] ?? null;
    }
    if (
      textModel === (initial?.textModel ?? "") &&
      characterModel === (initial?.characterModel ?? "") &&
      sceneModel === (initial?.sceneModel ?? "") &&
      propModel === (initial?.propModel ?? "") &&
      boardModel === (initial?.boardModel ?? "") &&
      !Object.keys(prompts).length &&
      (!legacy || template === initial?.template)
    ) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const result = await window.desktop.projects.drama({
        projectHandle,
        boardSettings: {
          revision,
          prompts,
          settings: {
            textModel,
            characterModel,
            sceneModel,
            propModel,
            boardModel,
            ...(legacy && { template }),
          },
        },
      });
      if (!result.ok || !result.value)
        throw Error(result.ok ? "无法读取项目设置" : result.error.message);
      onSaved(result.value);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "项目设置保存失败");
    } finally {
      setSaving(false);
    }
  }
  const imageFields = [
    ["人物", characterModel, setCharacterModel],
    ["场景", sceneModel, setSceneModel],
    ["物品", propModel, setPropModel],
  ] as const;
  return (
    <dialog
      className="drama-start-dialog drama-project-settings"
      ref={dialog}
      aria-label="项目设置"
      onCancel={(event) => {
        event.preventDefault();
        if (library.draft) library.setDraft(undefined);
        else if (!saving) onClose();
      }}
    >
      <form
        hidden={!!library.draft}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className="project-settings-heading">
          <h2>项目设置</h2>
          <button type="button" aria-label="关闭项目设置" disabled={saving} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="project-settings-scroll">
          <p className="project-settings-note">
            修改只影响之后发起的任务，还没生成的资产会换成新的图片模型
          </p>
          <section className="project-model-section" aria-label="Agent 模型设置">
            <h3>Agent 模型</h3>
            <DramaStartModel
              container={dialog}
              label="Agent 模型"
              kind="文本"
              models={agents}
              plugins={[]}
              loading={false}
              value={textModel}
              change={setTextModel}
            />
          </section>
          <section className="project-model-section" aria-label="资产图片">
            <h3>资产图片</h3>
            {imageFields.map(([prefix, value, change]) => (
              <DramaStartModel
                key={prefix}
                container={dialog}
                kind="图片"
                prefix={prefix}
                models={models}
                plugins={[]}
                loading={false}
                value={value}
                change={change}
              />
            ))}
          </section>
          <section className="project-model-section" aria-label="故事板">
            <h3>故事板</h3>
            <DramaStartModel
              container={dialog}
              kind="图片"
              prefix="故事板"
              models={models}
              plugins={[]}
              loading={false}
              value={boardModel}
              change={setBoardModel}
              defaultLabel="跟随场景图片"
              fallback={models.find((model) => model.id === sceneModel)}
            />
          </section>
          <PromptRows
            library={library}
            container={dialog}
            saved={document.prompt_snapshots}
            script={!document.planning}
          />
          {legacy && (
            <label>
              故事板模板
              <textarea
                rows={8}
                maxLength={24000}
                value={template}
                onChange={(event) => setTemplate(event.currentTarget.value)}
              />
            </label>
          )}
          {(problem || error) && <p role="alert">{problem || error}</p>}
        </div>
        <footer>
          <button type="button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button disabled={saving || !!problem} type="submit">
            完成
          </button>
        </footer>
      </form>
      {library.draft && <PromptEditor draft={library.draft} library={library} />}
    </dialog>
  );
}
