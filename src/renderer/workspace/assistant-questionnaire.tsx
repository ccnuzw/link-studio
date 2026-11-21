import {
  type CanvasAgentAnswers,
  type canvasAgentMediaModels,
  isCanvasAgentAnswerValue,
  isCanvasAgentQuestionnaire,
} from "@link-studio/core";
import { useId, useState } from "react";

export function AssistantQuestionnaire({
  payload,
  busy,
  models,
  onAnswer,
}: {
  payload: unknown;
  busy: boolean;
  models: ReturnType<typeof canvasAgentMediaModels>;
  onAnswer: (answers?: CanvasAgentAnswers) => void;
}) {
  const prefix = useId();
  type AnswerValue = CanvasAgentAnswers[number]["value"];
  const [draft, setDraft] = useState(new Map<string, AnswerValue>());
  if (!isCanvasAgentQuestionnaire(payload)) return null;
  const questions = payload.questions.map((question) => {
    const raw = draft.get(question.id) ?? "";
    const value = typeof raw === "string" ? raw.trim() : raw;
    const choices =
      question.kind === "model"
        ? models.filter(({ kind }) => kind === question.modelKind)
        : undefined;
    const valid =
      isCanvasAgentAnswerValue(question, value) &&
      (!choices || choices.some(({ provider }) => provider.id === value));
    const empty = value.length === 0;
    return { ...question, raw, value, valid, empty, choices };
  });
  const answers = questions.flatMap(({ id, value, valid }) => (valid ? [{ id, value }] : []));
  const ready = questions.every(
    ({ valid, empty, required }) => valid || (empty && required === false),
  );
  const edit = (id: string, value: AnswerValue) =>
    setDraft((current) => new Map(current).set(id, value));
  return (
    <form
      className="settings-confirm assistant-questionnaire"
      aria-label="小灵提问"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) onAnswer(answers);
      }}
    >
      <h3>小灵需要你确认</h3>
      <p>回答后，小灵会继续当前任务。跳过不会授权任何画布操作或生成任务。</p>
      {questions.map(
        ({ id, label, options, required, kind, multi, raw, valid, empty, choices }, index) => {
          const control = `${prefix}-${id}`;
          const caption = `${index + 1}. ${label}${required === false ? "（选填）" : ""}`;
          if (multi && options) {
            const picked = Array.isArray(raw) ? raw : [];
            return (
              <fieldset key={id} className="assistant-question-choices" disabled={busy}>
                <legend>{caption} · 可多选</legend>
                {options.map((option) => (
                  <label key={option}>
                    <input
                      type="checkbox"
                      checked={picked.includes(option)}
                      onChange={(event) =>
                        edit(
                          id,
                          options.filter((item) =>
                            item === option ? event.target.checked : picked.includes(item),
                          ),
                        )
                      }
                    />
                    <span>{option}</span>
                  </label>
                ))}
              </fieldset>
            );
          }
          const text = typeof raw === "string" ? raw : "";
          const invalid = !empty && !valid;
          return (
            <label key={id} htmlFor={control}>
              <span>{caption}</span>
              {choices ? (
                <select
                  id={control}
                  disabled={busy || !choices.length}
                  value={valid ? text : ""}
                  onChange={(event) => edit(id, event.target.value)}
                  required={required !== false}
                >
                  <option value="">
                    {choices.length ? "选择模型" : "暂无可用模型，请在设置中启用"}
                  </option>
                  {choices.map(({ provider }) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.config?.name ?? provider.model} · {provider.label}
                    </option>
                  ))}
                </select>
              ) : options ? (
                <select
                  id={control}
                  disabled={busy}
                  value={text}
                  onChange={(event) => edit(id, event.target.value)}
                  required={required !== false}
                >
                  <option value="" disabled={required !== false}>
                    选择一项
                  </option>
                  {options.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </select>
              ) : kind === "number" || kind === "url" ? (
                <>
                  <input
                    id={control}
                    type="text"
                    inputMode={kind === "number" ? "decimal" : "url"}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                    value={text}
                    onChange={(event) => edit(id, event.target.value)}
                    required={required !== false}
                    maxLength={2048}
                    aria-invalid={invalid}
                    aria-describedby={invalid ? `${control}-error` : undefined}
                  />
                  {invalid && (
                    <small id={`${control}-error`} role="alert">
                      {kind === "number"
                        ? "请输入有效数字。"
                        : "请输入不含登录凭据的 HTTP 或 HTTPS 链接。"}
                    </small>
                  )}
                </>
              ) : (
                <textarea
                  id={control}
                  disabled={busy}
                  value={text}
                  onChange={(event) => edit(id, event.target.value)}
                  rows={2}
                  maxLength={2048}
                  required={required !== false}
                />
              )}
            </label>
          );
        },
      )}
      <div className="settings-actions">
        <small>
          已答 {answers.length}/{questions.length}
        </small>
        <button type="button" disabled={busy} onClick={() => onAnswer()}>
          跳过提问
        </button>
        <button type="submit" className="settings-primary" disabled={busy || !ready}>
          提交回答
        </button>
      </div>
    </form>
  );
}
