import type { SettingsInput, SettingsValues } from "@link-studio/core";
import {
  ChevronRight,
  Circle,
  CircleX,
  Diamond,
  Info,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { PluginCopy } from "./plugin-copy";
import { TrialFoldableCode } from "./trial-request-preview";

type Step = SettingsValues["modelTrial"]["trace"][number];
const duration = (ms?: number) =>
  ms === undefined || !Number.isFinite(ms)
    ? "-"
    : ms < 1000
      ? `${Math.round(ms)}ms`
      : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
export const trialStepFailed = (step: Step) => Boolean(step.error || (step.status ?? 0) >= 400);

function TraceBlock({ label, body }: { label: string; body: NonNullable<Step["responseBody"]> }) {
  let text = body.text;
  if (label === "请求头") {
    try {
      const headers: unknown = JSON.parse(text);
      if (headers && typeof headers === "object" && !Array.isArray(headers))
        text = Object.entries(headers)
          .map(([name, value]) => `${name}: ${value}`)
          .join("\n");
    } catch {
      /* Keep the redacted excerpt when truncated. */
    }
  }
  return (
    <section aria-label={label}>
      <strong>
        {label}
        {body.truncated && <span className="trial-trace-truncated">已截断</span>}
      </strong>
      <TrialFoldableCode text={text} limit={600} />
    </section>
  );
}

function TraceRow({ step, firstFailure, max }: { step: Step; firstFailure: boolean; max: number }) {
  const failed = trialStepFailed(step);
  const [open, setOpen] = useState(failed);
  const row = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (failed) setOpen(true);
    if (firstFailure) row.current?.scrollIntoView({ block: "nearest" });
  }, [failed, firstFailure]);
  let path = step.endpoint;
  if (path) {
    try {
      path = new URL(path).pathname;
    } catch {
      /* already redacted */
    }
  }
  const title =
    step.hook || `${step.method} ${step.phase === "finalizing" ? "下载试跑产物" : path}`;
  const Icon = failed ? CircleX : step.kind === "hook" ? Diamond : Circle;
  return (
    <li ref={row} data-failed={failed}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`trace-${step.id}`}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight size={12} className="trial-trace-arrow" /> <span>{step.seq}</span>
        <span className="trial-trace-kind" data-kind={step.kind}>
          <Icon size={12} />
          {step.kind}
          {failed && " · 失败"}
        </span>
        <code title={step.endpoint ?? title}>{title}</code>
        {step.status !== undefined ? (
          <span>{step.status}</span>
        ) : step.durationMs === undefined && step.kind === "http" ? (
          <span>等待响应</span>
        ) : null}
        {step.responseBody?.truncated && <span className="trial-trace-truncated">已截断</span>}
        <span className="trial-trace-duration">{duration(step.durationMs)}</span>
        <i aria-hidden="true">
          <b
            style={{
              width: `${step.durationMs && step.durationMs > 0 ? Math.max(2, Math.round((100 * step.durationMs) / max)) : 0}%`,
            }}
          />
        </i>
      </button>
      {open && (
        <div id={`trace-${step.id}`} className="trial-trace-detail">
          {step.error && <strong role="alert">{step.error}</strong>}
          {![
            step.error,
            step.hookInput,
            step.hookOutput,
            step.hookLogs,
            step.requestHeaders,
            step.requestBody,
            step.responseBody,
          ].some(Boolean) && <span>无记录内容</span>}
          {step.hookInput && <TraceBlock label="输入" body={step.hookInput} />}
          {step.hookOutput && <TraceBlock label="输出" body={step.hookOutput} />}
          {step.hookLogs && <TraceBlock label="插件日志" body={step.hookLogs} />}
          {step.requestHeaders && <TraceBlock label="请求头" body={step.requestHeaders} />}
          {step.requestBody && <TraceBlock label="请求体" body={step.requestBody} />}
          {step.responseBody && <TraceBlock label="响应体" body={step.responseBody} />}
        </div>
      )}
    </li>
  );
}

const emptySteps: Step[] = [];

export function useTrialTrace(
  query: SettingsInput<"modelTrialTrace"> | undefined,
  live = emptySteps,
) {
  const [snapshot, setSnapshot] = useState<{
    key: string;
    base: Step[];
    steps: Step[];
    status: "loading" | "ready" | "error";
  }>();
  const key = query ? JSON.stringify(query) : "";
  const readVersion = useRef(0);
  useEffect(
    () => () => {
      readVersion.current++;
    },
    [key],
  );
  const current = snapshot && snapshot.key === key && snapshot.base === live ? snapshot : undefined;
  const steps = current?.steps ?? live;
  const refresh = async () => {
    if (!query) return;
    const version = ++readVersion.current;
    setSnapshot({ key, base: live, steps, status: "loading" });
    try {
      const response = await window.desktop.settings.modelTrialTrace(query);
      if (version !== readVersion.current) return;
      if (!response.ok || !response.value) throw Error();
      setSnapshot({ key, base: live, steps: response.value, status: "ready" });
    } catch {
      if (version === readVersion.current)
        setSnapshot({ key, base: live, steps: emptySteps, status: "error" });
    }
  };
  return {
    steps,
    refresh,
    reading: current?.status === "loading",
    failed: current?.status === "error",
  };
}

export function ModelTrialTrace({
  trace,
  taskId,
  actions,
}: {
  trace: ReturnType<typeof useTrialTrace>;
  taskId: string;
  actions?: ReactNode;
}) {
  const { steps, refresh, reading } = trace;
  const [issue, setIssue] = useState("");
  const failed = steps.filter(trialStepFailed);
  const latest = steps.at(-1)?.seq ?? 0;
  const total = steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
  const max = Math.max(1, ...steps.map((step) => step.durationMs ?? 0));
  if (trace.failed)
    return (
      <div className="trial-trace-warning" role="status">
        <TriangleAlert size={16} />
        <strong>没能取到追踪</strong>
        <button type="button" className="trial-repair-copy" onClick={refresh}>
          刷新
        </button>
      </div>
    );
  return (
    <section className="trial-trace" aria-label="追踪时间线">
      <header>
        <h3>
          追踪 · 试跑 #{taskId}
          {steps.length > 0 && (
            <small>
              {" "}
              · 共 {latest} 步 · {duration(total)}
              {failed.length > 0 && <span> · {failed.length} 步失败</span>}
            </small>
          )}
        </h3>
        <div className="trial-trace-actions">
          <button type="button" disabled={reading} onClick={refresh}>
            {reading ? <Loader2 className="settings-spin" /> : <RefreshCw />}刷新
          </button>
          {actions}
          {steps.length > 0 && (
            <PluginCopy
              label="复制全部（JSON）"
              text={JSON.stringify(steps, null, 2)}
              onError={() => setIssue("复制失败，可展开步骤后手动复制。")}
            />
          )}
        </div>
      </header>
      {issue && <small role="alert">{issue}</small>}
      {latest > steps.length && (
        <small>保留首步与最近 {steps.length - 1} 步，耗时为所示步骤之和。</small>
      )}
      {steps.length ? (
        <ol>
          {steps.map((step) => (
            <TraceRow
              key={step.id}
              step={step}
              max={max}
              firstFailure={step.id === failed[0]?.id}
            />
          ))}
        </ol>
      ) : (
        <div className="trial-trace-empty" role="status">
          <Info size={16} />
          {reading ? "正在拉取追踪…" : "暂无追踪"}
        </div>
      )}
    </section>
  );
}
