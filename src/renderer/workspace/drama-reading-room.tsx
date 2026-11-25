import { type DramaDocument, dramaStyles, requirePresent } from "@link-studio/core";
import {
  ArrowLeft,
  Check,
  CirclePause,
  CloudAlert,
  FileText,
  LayoutGrid,
  LoaderCircle,
  Moon,
  SlidersHorizontal,
  Sun,
  UserRound,
} from "lucide-react";
import { type ReactNode, useMemo, useState, useSyncExternalStore } from "react";
import { CanvasAccountPill } from "./canvas-account-pill";
import { CanvasTextMarkdown } from "./canvas-text-markdown";
import { DramaCommandMenu } from "./drama-command-menu";
import { EpisodePaper } from "./drama-episode-paper";
import type { FieldAccess } from "./drama-field-editor";
import { biographyPassages, cardDisplay, parseCharacters } from "./drama-parse-characters";
import { DramaProjectTitle } from "./drama-project-title";
import { DramaTaskPill, PlanningBar } from "./drama-task-pill";
import type { Stage } from "./drama-workspace-nav";

type Planning = NonNullable<DramaDocument["planning"]>;
export type PlanningAction = "resume" | "pause" | "retry-builtin";

function statusText(plan: Planning) {
  if (plan.phase === "done") return "规划完成";
  const step = plan.summary ? "分集规划" : "粗读全书";
  return `${step}${plan.phase === "paused" ? "已暂停" : "中"}`;
}

function subscribeTheme(change: () => void) {
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", change);
  return () => scheme.removeEventListener("change", change);
}

export function DramaWorkspaceHeader({
  doc,
  model,
  returnLabel,
  back,
  settings,
  progress,
  go,
  children,
  controls,
}: {
  doc: DramaDocument;
  model?: string;
  returnLabel: string;
  back: () => void;
  settings: () => void;
  progress: () => void;
  go: (stage: Stage, episode?: number) => void;
  children: ReactNode;
  controls?: {
    access: FieldAccess;
    projectId: string;
    saveLabel: string;
    breakdown: () => void;
    rewriteScripts?: () => void;
    toggleTheme?: () => void;
    tasks: import("./drama-task-pill").TaskControls;
  };
}) {
  const dark = useSyncExternalStore(
    subscribeTheme,
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const themeLabel = dark ? "切换到浅色" : "切换到深色";
  const style =
    dramaStyles.styles.find((item) => item.key === doc.style_key)?.name ?? doc.style_custom;
  const details = [style, doc.ratio, model].filter(Boolean).join(" · ");
  const saveProblem = controls?.saveLabel === "保存冲突" || controls?.saveLabel === "保存失败";
  return (
    <header className="drama-workbar">
      <div className="drama-project-name">
        <button type="button" onClick={back} title={returnLabel} aria-label={returnLabel}>
          <ArrowLeft size={16} />
        </button>
        <h1 title={doc.title}>
          {controls ? <DramaProjectTitle title={doc.title} access={controls.access} /> : doc.title}
        </h1>
        {controls && controls.saveLabel !== "已保存" && (
          <span
            className="dp-save-indicator"
            role="status"
            aria-label={controls.saveLabel}
            title={controls.saveLabel}
            data-problem={saveProblem}
          >
            {saveProblem ? (
              <CloudAlert size={14} />
            ) : (
              <LoaderCircle className="drama-reading-spinner" size={14} />
            )}
            <span>{controls.saveLabel}</span>
          </span>
        )}
        <DramaTaskPill
          key={controls?.projectId}
          doc={doc}
          go={go}
          openPlanning={progress}
          controls={controls?.tasks}
          projectId={controls?.projectId}
        />
      </div>
      {children}
      <div className="drama-work-tools">
        <button
          type="button"
          onClick={settings}
          aria-label="项目设置"
          title={`项目设置${details ? ` · ${details}` : ""}`}
        >
          <SlidersHorizontal size={15} />
          <span className="drama-settings-summary">{details || "项目设置"}</span>
        </button>
        {controls && (
          <DramaCommandMenu
            doc={doc}
            go={go}
            settings={settings}
            breakdown={controls.breakdown}
            rewriteScripts={controls.rewriteScripts}
            toggleTheme={controls.toggleTheme}
          />
        )}
        {controls?.toggleTheme && (
          <button
            type="button"
            className="drama-theme-button"
            aria-label={themeLabel}
            title={themeLabel}
            onClick={controls.toggleTheme}
          >
            {dark ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        )}
        {controls && <CanvasAccountPill creditsOnly />}
      </div>
    </header>
  );
}

export function DramaReadingRoom({
  access,
  registerFlush,
  refresh,
  notify,
  doc,
  page,
  busy,
  act,
  settings,
}: {
  access: FieldAccess;
  registerFlush: React.RefObject<(() => Promise<void>) | null>;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
  doc: DramaDocument;
  page: "outline" | "characters";
  busy: boolean;
  act: (action: PlanningAction) => void;
  settings: () => void;
}) {
  const plan = doc.planning;
  const text = page === "outline" ? doc.outline_md : doc.characters_md;
  const title = page === "outline" ? "故事大纲" : "人物传记";
  const active = plan?.summary ? 1 : 0;
  const paused = plan?.phase === "paused";
  const pending = plan?.pending;
  const remaining =
    pending?.expected_seconds &&
    Math.ceil(pending.expected_seconds - (Date.now() - Date.parse(pending.created_at)) / 1000);
  const cards = useMemo(() => (page === "characters" ? parseCharacters(text) : []), [page, text]);
  const [raw, setRaw] = useState(false);
  const groups = useMemo(() => {
    const ordered = new Map<string, typeof cards>();
    for (const card of cards) {
      if (!ordered.has(card.group)) ordered.set(card.group, []);
      requirePresent(ordered.get(card.group), "ordered.get(card.group)").push(card);
    }
    return [...ordered];
  }, [cards]);
  return (
    <section className="drama-reading-room" aria-label={title}>
      <header className="dp-paper-head">
        <h2>{title}</h2>
        <div className="dp-tools">
          {!!cards.length && (
            <fieldset data-ui-group className="dp-view-switch" aria-label="人物视图">
              {[false, true].map((next) => (
                <button
                  key={String(next)}
                  type="button"
                  aria-pressed={raw === next}
                  title={next ? "编辑原文" : "查看人物卡"}
                  aria-label={next ? "编辑原文" : "查看人物卡"}
                  onClick={async () => {
                    if (next === raw) return;
                    try {
                      await registerFlush.current?.();
                      setRaw(next);
                    } catch {
                      notify("请先处理保存提示");
                    }
                  }}
                >
                  {next ? <FileText size={16} /> : <LayoutGrid size={16} />}
                </button>
              ))}
            </fieldset>
          )}
        </div>
      </header>
      {plan && plan.phase !== "done" && (
        <section className="drama-reading-progress" aria-label="小说规划">
          <h3 role="status">{statusText(plan)}</h3>
          {plan.phase === "running" && <PlanningBar plan={plan} />}
          <ol>
            {["粗读全书", "分集规划"].map((label, index) => (
              <li key={label} aria-current={active === index ? "step" : undefined}>
                <span className="drama-step-icon">
                  {index < active ? (
                    <Check size={14} />
                  ) : (
                    index === active &&
                    (paused ? (
                      <CirclePause size={15} />
                    ) : (
                      <LoaderCircle className="drama-reading-spinner" size={15} />
                    ))
                  )}
                </span>
                <div>
                  <strong>{label}</strong>
                  {index === active && !paused && remaining !== undefined && (
                    <small>
                      {" "}
                      ·{" "}
                      {remaining > 0
                        ? `预计还需约 ${Math.ceil(remaining / 60)} 分钟`
                        : "已超过历史用时，仍在处理"}
                    </small>
                  )}
                  <p>
                    {index === 0
                      ? "抽样阅读开篇与后文，整理人物和故事大纲"
                      : `按批生成分集目录 · 已处理 ${plan.cursor} / ${plan.end} 个原文单元`}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          {paused && (
            <p className="drama-pause-reason" role="status">
              {plan.pause_reason}
            </p>
          )}
          <div className="drama-reading-actions">
            <button type="button" disabled={busy} onClick={() => act(paused ? "resume" : "pause")}>
              {paused ? "恢复规划" : "暂停规划"}
            </button>
            {paused && plan.pause_code === "context" && (
              <button type="button" onClick={settings}>
                更换模型
              </button>
            )}
            {paused && plan.pause_code === "custom_prompt" && (
              <button type="button" disabled={busy} onClick={() => act("retry-builtin")}>
                改用内置重试
              </button>
            )}
          </div>
          {!text && !paused && (
            <div className="drama-reading-skeleton" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
          )}
        </section>
      )}
      {cards.length && !raw ? (
        <div className="dp-characters">
          {groups.map(([group, members]) => (
            <section key={group}>
              {group && <h3 className="dp-cast-group">{group}</h3>}
              <div className="dp-cast-grid">
                {members.map((card, index) => {
                  const display = cardDisplay(card);
                  const occurrence = members
                    .slice(0, index)
                    .filter((item) => item.name === card.name).length;
                  return (
                    <article key={`${card.name}:${occurrence}`}>
                      <header>
                        <span className="dp-cast-icon">
                          <UserRound size={20} />
                        </span>
                        <div>
                          <h4>{display.name}</h4>
                          {display.subtitle && <small>{display.subtitle}</small>}
                        </div>
                      </header>
                      {!!display.fields.length && (
                        <dl>
                          {display.fields.map((field, position, fields) => (
                            <div
                              key={`${field.label}:${fields.slice(0, position).filter((item) => item.label === field.label).length}`}
                            >
                              <dt>{field.label}</dt>
                              <dd>{field.value}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      {card.notes.flatMap(biographyPassages).map((passage, position, passages) => (
                        <p
                          key={`${passage.text}:${passages.slice(0, position).filter((item) => item.text === passage.text).length}`}
                        >
                          {passage.periods.length > 0 && (
                            <span className="dp-periods">{passage.periods.join(" · ")}</span>
                          )}
                          {passage.text}
                        </p>
                      ))}
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : !plan || plan.phase === "done" ? (
        <EpisodePaper
          {...access}
          registerFlush={registerFlush}
          refresh={refresh}
          notify={notify}
          episodeOrder={doc.episode_order ?? 0}
          documentField={{
            field: page === "outline" ? "outline_md" : "characters_md",
            value: text,
            revision: doc.revision,
            label: title,
          }}
        />
      ) : text ? (
        <div className="drama-reading-paper">
          <CanvasTextMarkdown text={text} />
        </div>
      ) : null}
    </section>
  );
}
