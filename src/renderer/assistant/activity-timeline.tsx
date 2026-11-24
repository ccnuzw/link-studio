import { agentContextWindow, type ProviderView, type SettingsEvent } from "@link-studio/core";
import {
  BookOpen,
  Camera,
  Check,
  ChevronRight,
  CircleStop,
  Clapperboard,
  Film,
  Globe,
  LayoutGrid,
  Lightbulb,
  ListChecks,
  ListTodo,
  Loader2,
  LocateFixed,
  MessageCircleQuestion,
  PencilLine,
  ScanEye,
  Search,
  Terminal,
  Trash2,
  WandSparkles,
  Wrench,
} from "lucide-react";
import { type ComponentProps, Fragment, type ReactNode, useMemo, useState } from "react";
import { feedbackStatuses } from "../../../packages/link-studio-core/src/agent-feedback";
import { activitySummary, formatSeconds, toolIcon } from "./activity-summary";
import { AssistantReply } from "./assistant-preferences";
import { CompactionDivider } from "./compaction-divider";
import { compactionHistory } from "./compaction-history";
import { RunFeedbackBar, type SaveFeedback } from "./run-feedback";
import { planSteps } from "./run-plan";
import { type ActivityGroupModel, toolHistory } from "./tool-history";

const icons = {
  read: BookOpen,
  frame: Camera,
  models: Clapperboard,
  video: Film,
  web: Globe,
  arrange: LayoutGrid,
  skill: Lightbulb,
  plan: ListChecks,
  task: ListTodo,
  ask: MessageCircleQuestion,
  edit: PencilLine,
  look: ScanEye,
  search: Search,
  script: Terminal,
  delete: Trash2,
  generate: WandSparkles,
  other: Wrench,
};
type LocateTool = (ids: string[]) => void;

function ActivityGroup({ group, locate }: { group: ActivityGroupModel; locate?: LocateTool }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? group.running;
  const tools = [...group.tools.values()];
  const summary = activitySummary({
    tools,
    startedAt: group.startedAt,
    endedAt: group.endedAt,
    status: group.aborted ? "aborted" : group.running ? "running" : "done",
  });
  const fallback = summary.phrase;
  const HeadIcon = group.running ? Loader2 : group.aborted ? CircleStop : icons[summary.icon];
  const label = group.running
    ? "处理中"
    : group.aborted
      ? `已中止 · ${fallback}`
      : (group.summary ?? fallback);
  const failures = tools.filter((tool) => tool.failed).length;
  return (
    <section className="assistant-tool-group" data-running={group.running}>
      <button
        type="button"
        aria-label={label}
        title={group.running ? undefined : label}
        aria-expanded={open}
        onClick={() => setManual(!open)}
      >
        <HeadIcon size={14} aria-hidden />
        <span>{label}</span>
        {!group.running && failures > 0 && <small>· {failures} 项失败</small>}
        {!group.running && summary.seconds !== null && (
          <small>{formatSeconds(summary.seconds)}</small>
        )}
        <ChevronRight size={14} aria-hidden />
      </button>
      {open && (
        <ul>
          {tools.map((tool) => {
            const pending = !tool.ended && group.running;
            const aborted = !tool.ended && !group.running;
            const Icon = pending ? Loader2 : icons[toolIcon(tool)];
            return (
              <li key={tool.id}>
                <button
                  type="button"
                  className="assistant-tool-row"
                  disabled={!locate || !tool.nodeIds.length}
                  onClick={() => locate?.(tool.nodeIds)}
                  data-pending={pending}
                  data-failed={tool.failed}
                  data-aborted={aborted}
                >
                  <Icon size={14} aria-hidden /> <strong>{tool.label}</strong>
                  {tool.detail && <span className="assistant-tool-detail">{tool.detail}</span>}
                  {tool.failed ? (
                    <small>失败</small>
                  ) : aborted ? (
                    <small>已中止</small>
                  ) : (
                    locate &&
                    tool.nodeIds.length > 0 && (
                      <LocateFixed size={14} aria-hidden className="assistant-tool-locate" />
                    )
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function AssistantTimeline({
  events,
  composerPlan = false,
  partial,
  model,
  render,
  saveFeedback,
  renderDiagnostics,
  renderFooter,
  locate,
}: {
  events: SettingsEvent[];
  composerPlan?: boolean;
  partial?: { runId: string; text: string; hasThinking?: boolean };
  model?: ProviderView;
  render: (event: SettingsEvent, copyInFooter?: boolean) => ReactNode;
  saveFeedback?: SaveFeedback;
  renderDiagnostics?: (event: SettingsEvent) => ReactNode;
  renderFooter?: (props: ComponentProps<typeof RunFeedbackBar>) => ReactNode;
  locate?: LocateTool;
}) {
  const items = useMemo(() => toolHistory(events, composerPlan), [events, composerPlan]);
  const dividers = useMemo(() => compactionHistory(events), [events]);
  const footers = useMemo(() => {
    const ended = new Map<string, number>();
    const replies = new Map<string, { seq: number; text: string }>();
    const replyKeys = new Map<number, string>();
    const previousReplies = new Map<string, number>();
    for (const event of events) {
      const data = event.payload as { status?: string; text?: string } | null;
      if (event.type === "run.status") {
        if (feedbackStatuses.has(data?.status ?? "")) ended.set(event.runId, event.seq);
        else ended.delete(event.runId);
      }
      if (event.type === "message.user") replies.delete(event.runId);
      if (event.type === "message.done") {
        replyKeys.set(
          event.seq,
          `reply-${event.runId}-${previousReplies.get(event.runId) ?? "first"}`,
        );
        previousReplies.set(event.runId, event.seq);
      }
      if (event.type === "message.done" && data?.text)
        replies.set(event.runId, { seq: event.seq, text: data.text });
    }
    return { ended, replies, replyKeys, previousReplies };
  }, [events]);
  const rows = items.map((item) => {
    if ("tools" in item) return <ActivityGroup group={item} locate={locate} key={item.key} />;
    if (composerPlan && item.type === "plan.updated")
      return (
        <p key={item.seq} className="assistant-plan-done">
          <Check size={14} aria-hidden />
          计划已完成（{planSteps(item.payload).length} 步）
        </p>
      );
    const divider = dividers.get(item.seq);
    if (saveFeedback && footers.ended.get(item.runId) === item.seq) {
      const props = {
        runId: item.runId,
        value: item.feedback,
        text: footers.replies.get(item.runId)?.text,
        quiet: item.runId !== events.at(-1)?.runId,
        save: saveFeedback,
        leading: renderDiagnostics?.(item),
      };
      return (
        <Fragment key={item.seq}>
          {render(item)}
          {renderFooter?.(props) ?? <RunFeedbackBar {...props} />}
        </Fragment>
      );
    }
    const copyInFooter =
      !!saveFeedback &&
      footers.ended.has(item.runId) &&
      footers.replies.get(item.runId)?.seq === item.seq;
    if (item.type === "message.done") {
      const data = item.payload as { text?: string; thinking?: string };
      return (
        <AssistantReply
          key={footers.replyKeys.get(item.seq)}
          text={data.text ?? ""}
          thinking={data.thinking}
          copyInFooter={copyInFooter}
        />
      );
    }
    return divider ? (
      <CompactionDivider key={item.seq} item={divider} limit={agentContextWindow(model)} />
    ) : (
      render(item, copyInFooter)
    );
  });
  if (partial)
    rows.push(
      <AssistantReply
        key={`reply-${partial.runId}-${footers.previousReplies.get(partial.runId) ?? "first"}`}
        streaming
        text={partial.text}
        thinking={partial.hasThinking}
      />,
    );
  return rows;
}
