import {
  type CanvasAgentAnswers,
  type canvasAgentMediaModels,
  isCanvasAgentAnswerValue,
  type ProviderView,
  readWorkspaceQuestions,
} from "@link-studio/core";
import { CornerDownRight, createLucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { ChoiceButton } from "../choice-button";
import { focusOnMount } from "../focus-on-mount";
import { keyedItems } from "../occurrence-keys";

const customChoice = "\u0000custom";
const MessageCircleQuestion = createLucideIcon("message-circle-question-mark", [
  [
    "path",
    {
      d: "M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719",
      key: "bubble",
    },
  ],
  ["path", { d: "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3", key: "question" }],
  ["path", { d: "M12 17h.01", key: "dot" }],
]);

function fields(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function QuestionRecord({
  payload,
  providers,
}: {
  payload: Record<string, unknown>;
  providers: ProviderView[];
}) {
  const decision = fields(payload.decision);
  const request = fields(payload.payload);
  const questions = Array.isArray(request.questions) ? request.questions.map(fields) : [];
  const answers = new Map(
    (Array.isArray(decision.answers) ? decision.answers : [])
      .map(fields)
      .map((answer) => [answer.id, answer]),
  );
  const skipped = payload.status === "rejected";
  const entries =
    skipped && questions.length > 1
      ? [{ label: "", answer: `跳过了 ${questions.length} 个问题` }]
      : questions.map((question) => {
          const saved = answers.get(question.id);
          const value = saved?.value;
          const model =
            question.kind === "model"
              ? providers.find((provider) => provider.id === value)
              : undefined;
          const reply =
            saved?.answer ??
            (Array.isArray(question.models)
              ? question.models.map(fields).find((entry) => entry.key === value)?.name
              : undefined) ??
            model?.config?.name ??
            model?.model ??
            (Array.isArray(value) ? value.join("、") : value);
          return {
            label: String(question.question ?? question.label ?? ""),
            answer: skipped ? "跳过了这个问题" : String(reply ?? ""),
          };
        });
  if (!entries.length)
    entries.push({
      label: String(request.question ?? ""),
      answer: String(decision.answer || (skipped ? "跳过了这个问题" : "")),
    });
  return (
    <section className="agent-question-record" aria-label="小灵提问记录">
      {keyedItems(entries, (entry) => entry.label).map(({ item: { label, answer }, key }) => (
        <section
          key={key}
          className="agent-question-record-row"
          aria-label={skipped ? answer : `你的回答：${answer || "没回答"}`}
        >
          <CornerDownRight size={14} aria-hidden />
          {label && <span title={label}>{label}</span>}
          <strong
            data-answer-state={skipped ? "skipped" : answer ? "answered" : "empty"}
            title={answer || "没回答"}
          >
            {answer || "没回答"}
          </strong>
        </section>
      ))}
    </section>
  );
}

export function AssistantQuestionnaire({
  payload,
  busy,
  models,
  onAnswer,
  quickChoices = false,
}: {
  payload: unknown;
  busy: boolean;
  models: ReturnType<typeof canvasAgentMediaModels>;
  onAnswer: (answers?: CanvasAgentAnswers) => void;
  quickChoices?: boolean;
}) {
  const prefix = useId();
  type AnswerValue = CanvasAgentAnswers[number]["value"];
  const [draft, setDraft] = useState(new Map<string, AnswerValue>());
  const [detailsByChoice, setDetailsByChoice] = useState(new Map<string, string>());
  const parsed = readWorkspaceQuestions(payload);
  if (!parsed) return null;
  const questions = parsed.questions.map((question) => {
    const raw = draft.get(question.id) ?? "";
    const readChoice = (selected: string) => {
      const detail = detailsByChoice.get(JSON.stringify([question.id, selected]))?.trim();
      if (selected === customChoice) return detail || "";
      if (question.follow?.some((option) => option.label === selected))
        return detail ? `${selected}：${detail}` : "";
      return selected.trim();
    };
    const value = Array.isArray(raw) ? raw.map(readChoice) : readChoice(raw);
    const choices =
      question.kind === "model"
        ? (question.models?.map((model) => ({
            value: model.key,
            label: model.name,
            hint: model.hint ?? "",
          })) ??
          models
            .filter(({ kind }) => kind === question.modelKind)
            .map(({ provider }) => ({
              value: provider.id,
              label: provider.config?.name ?? provider.model,
              hint: provider.label,
            })))
        : undefined;
    const valid =
      isCanvasAgentAnswerValue(question, value) &&
      (!choices || choices.some((choice) => choice.value === value));
    const empty = value.length === 0;
    return { ...question, raw, value, valid, empty, choices };
  });
  const answers = questions.flatMap(({ id, value, valid }) => (valid ? [{ id, value }] : []));
  const ready = questions.every(
    ({ valid, empty, required }) => valid || (empty && required === false),
  );
  const edit = (id: string, value: AnswerValue) =>
    setDraft((current) => new Map(current).set(id, value));
  const single = questions.length === 1 ? questions[0] : undefined;
  if (
    quickChoices &&
    single &&
    !single.multi &&
    !single.follow?.length &&
    (single.choices || single.options)
  ) {
    const options =
      single.choices ?? (single.options ?? []).map((value) => ({ value, label: value, hint: "" }));
    return (
      <QuickQuestion
        label={single.label}
        options={options}
        busy={busy}
        allowCustom={single.allowCustom}
        answer={(value) => onAnswer([{ id: single.id, value }])}
      />
    );
  }
  return (
    <form
      className="agent-ask-form"
      aria-label="小灵提问"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) onAnswer(answers);
      }}
    >
      <h3>
        <MessageCircleQuestion size={16} aria-hidden />
        {questions.length === 1 ? questions[0]?.label : `还差 ${questions.length} 件事要你定`}
      </h3>
      {questions.map(
        (
          {
            id,
            label,
            kind,
            choices,
            multi,
            options,
            raw,
            empty,
            valid,
            required,
            follow,
            allowCustom,
            placeholder,
          },
          index,
        ) => {
          const control = `${prefix}-${id}`;
          const items =
            choices?.slice() ??
            options?.map((option) => ({ value: option, label: option, hint: "" }));
          const picked = Array.isArray(raw) ? raw : [raw];
          if (allowCustom) items?.push({ value: customChoice, label: "其他，我来说", hint: "" });
          return (
            <fieldset className="agent-ask-question" key={id} data-ui-group aria-label={label}>
              <div className="agent-ask-label">
                <span aria-hidden>{index + 1}</span>
                <label htmlFor={items ? undefined : control}>{label}</label>
                {required === false && <small>选填</small>}
              </div>
              {items ? (
                <fieldset
                  data-ui-group
                  className="agent-ask-options"
                  {...(multi ? {} : { role: "radiogroup" })}
                  aria-label={label}
                >
                  {items.map((item, optionIndex) => (
                    <Fragment key={item.value}>
                      <ChoiceButton
                        type="button"
                        key={item.value}
                        value={item.value}
                        role={multi ? "checkbox" : "radio"}
                        aria-checked={picked.includes(item.value)}
                        disabled={busy}
                        onClick={() =>
                          edit(
                            id,
                            multi
                              ? picked.includes(item.value)
                                ? picked.filter((value) => value !== item.value)
                                : [...picked.filter(Boolean), item.value]
                              : item.value,
                          )
                        }
                      >
                        <span aria-hidden>{String.fromCharCode(65 + optionIndex)}</span>
                        {item.label}
                        {item.hint && <small>{item.hint}</small>}
                      </ChoiceButton>
                      {picked.includes(item.value) &&
                        (item.value === customChoice ||
                          follow?.some((entry) => entry.label === item.value)) && (
                          <input
                            aria-label={`${item.label}：补充`}
                            placeholder={
                              follow?.find((entry) => entry.label === item.value)?.placeholder ??
                              "自己写"
                            }
                            ref={focusOnMount}
                            maxLength={2000}
                            disabled={busy}
                            value={detailsByChoice.get(JSON.stringify([id, item.value])) ?? ""}
                            onChange={(event) => {
                              const text = event.target.value;
                              setDetailsByChoice((previous) =>
                                new Map(previous).set(JSON.stringify([id, item.value]), text),
                              );
                            }}
                          />
                        )}
                    </Fragment>
                  ))}
                  {!items.length && <small>暂无可用模型，请在设置中启用</small>}
                </fieldset>
              ) : (
                <input
                  id={control}
                  type="text"
                  placeholder={placeholder}
                  inputMode={kind === "number" ? "decimal" : kind === "url" ? "url" : "text"}
                  autoComplete="off"
                  disabled={busy}
                  value={typeof raw === "string" ? raw : ""}
                  required={required !== false}
                  maxLength={2048}
                  aria-invalid={!empty && !valid}
                  aria-describedby={!empty && !valid ? `${control}-error` : undefined}
                  onChange={(event) => edit(id, event.target.value)}
                />
              )}
              {!empty && !valid && !items && (
                <small id={`${control}-error`} role="alert">
                  {kind === "number"
                    ? "请输入有效数字。"
                    : "请输入不含登录凭据的 HTTP 或 HTTPS 链接。"}
                </small>
              )}
            </fieldset>
          );
        },
      )}
      <div className="agent-ask-actions">
        <small role="status" aria-label="进度">
          {answers.length} / {questions.length}
        </small>
        {!quickChoices && (
          <button type="button" disabled={busy} onClick={() => onAnswer()}>
            跳过提问
          </button>
        )}
        <button type="submit" disabled={busy || !ready} aria-label="提交回答">
          提交
        </button>
      </div>
    </form>
  );
}

function QuickQuestion({
  label,
  options,
  busy,
  answer,
  allowCustom,
}: {
  label: string;
  options: { value: string; label: string; hint: string }[];
  busy: boolean;
  allowCustom?: boolean;
  answer: (value: string) => void;
}) {
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState(false);
  const [customText, setCustomText] = useState("");
  const highlightId = useId();
  const entries = allowCustom
    ? [...options, { value: customChoice, label: "其他…", hint: "" }]
    : options;
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (document.activeElement === document.body)
      buttons.current[0]?.focus({ preventScroll: true });
  }, []);
  return (
    <fieldset
      data-ui-group
      aria-label={label}
      className="agent-ask-form agent-quick-question"
      onKeyDown={(event) => {
        if (editing || busy || event.nativeEvent.isComposing || !entries.length) return;
        if (/^[1-9]$/.test(event.key) && Number(event.key) <= entries.length) {
          event.preventDefault();
          buttons.current[Number(event.key) - 1]?.click();
        } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          const step = event.key === "ArrowUp" ? -1 : 1;
          buttons.current[(active + step + entries.length) % entries.length]?.focus();
        }
      }}
    >
      <h3>
        <MessageCircleQuestion size={16} aria-hidden />
        <span>{label}</span>
      </h3>
      <div className="change-decision-options" role="listbox" aria-label="你的决定">
        {entries.map((item, index) =>
          editing && item.value === customChoice ? (
            <form
              key={item.value}
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy && customText.trim()) answer(customText.trim());
              }}
            >
              <span className="choice-number">{index + 1}</span>
              <input
                ref={focusOnMount}
                aria-label="其他…"
                placeholder="自己写"
                maxLength={2000}
                disabled={busy}
                value={customText}
                onChange={(event) => setCustomText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                    event.stopPropagation();
                    setEditing(false);
                    requestAnimationFrame(() => buttons.current[index]?.focus());
                  }
                }}
              />
            </form>
          ) : (
            <button
              type="button"
              role="option"
              value={item.value}
              key={item.value}
              aria-selected={index === active}
              ref={(button) => {
                buttons.current[index] = button;
              }}
              disabled={busy}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onClick={() => (item.value === customChoice ? setEditing(true) : answer(item.value))}
            >
              {index === active && (
                <motion.span
                  className="question-choice-highlight"
                  aria-hidden
                  layoutId={highlightId}
                  transition={{ type: "spring", stiffness: 500, damping: 38, mass: 0.8 }}
                />
              )}
              <span className="choice-number">{index + 1}</span>
              <span>{item.label}</span>
              {item.hint && <small>{item.hint}</small>}
            </button>
          ),
        )}
        {!options.length && <small>暂无可用模型，请在设置中启用</small>}
      </div>
    </fieldset>
  );
}
