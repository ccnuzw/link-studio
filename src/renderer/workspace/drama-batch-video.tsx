import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { DramaDocument } from "@link-studio/core";
import { useEffect, useRef, useState } from "react";
import { DramaChoiceContent } from "./drama-choice-content";

type Segment = NonNullable<DramaDocument["segments"]>[number];
type Pick = "adapt" | "source" | "ready" | "continue";
type Question = {
  title: string;
  description?: string;
  stats?: { label: string; value: number }[];
  note?: string;
  options: { key: Pick; label: string; count?: number }[];
};

export function DramaBatchVideo({
  format,
  adapted,
  disabled,
  targets,
  hash,
  rewrite,
  plan,
  refresh,
  report,
}: {
  format: "h3" | "generic" | "seedance";
  adapted: boolean;
  disabled: boolean;
  targets: () => Promise<Segment[]>;
  hash: (text: string) => Promise<string>;
  rewrite: (item: Segment) => Promise<Segment>;
  plan: (item: Segment, prompt: string) => Promise<{ dead: string[]; submit: () => Promise<void> }>;
  refresh: () => Promise<void>;
  report: (message: string) => void;
}) {
  const [question, setQuestion] = useState<Question>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const live = useRef(false);
  const resolve = useRef<(pick?: Pick) => void>(undefined);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      resolve.current?.();
    };
  }, []);
  function decide(pick?: Pick) {
    resolve.current?.(pick);
    resolve.current = undefined;
    setQuestion(undefined);
  }
  function ask(view: Question) {
    if (!live.current) return Promise.resolve(undefined);
    setQuestion(view);
    return new Promise<Pick | undefined>((done) => {
      resolve.current = done;
    });
  }
  async function run() {
    if (disabled || pending.current) return;
    pending.current = true;
    setBusy(true);
    report("");
    const messages: string[] = [];
    try {
      const all = await targets();
      if (!all.length) {
        report("没有待生成的片段");
        return;
      }
      const prompts = new Map<string, string>();
      const current = new Map(all.map((item) => [item.id, item]));
      if (!adapted || format === "seedance") {
        for (const item of all) prompts.set(item.id, item.prompt);
      } else {
        const missing: Segment[] = [],
          stale: Segment[] = [];
        for (const item of all) {
          const text = item.adaptations?.[format];
          if (!text) missing.push(item);
          else if (text.source_hash !== (await hash(item.prompt))) stale.push(item);
          else prompts.set(item.id, text.prompt);
        }
        const queue = [...missing, ...stale];
        if (queue.length) {
          const options: Question["options"] = [
            { key: "adapt", label: "转写后生成", count: all.length },
            { key: "source", label: "原稿生成", count: all.length },
          ];
          if (prompts.size)
            options.push({ key: "ready", label: "只生成已转写的", count: prompts.size });
          const edited = stale.filter((item) => item.adaptations?.[format]?.edited).length;
          const stats = [
            { label: "已就绪", value: prompts.size },
            { label: "未转写", value: missing.length },
            { label: "已过期", value: stale.length },
          ].filter((item) => item.value > 0);
          const pick = await ask({
            title: `${queue.length} 个片段还没转写为 ${format === "h3" ? "H3" : "通用"}`,
            stats,
            options,
            note: edited ? `${edited} 个转写稿被手改过，重新转写会覆盖` : undefined,
          });
          if (!pick) return;
          if (pick === "source") for (const item of queue) prompts.set(item.id, item.prompt);
          if (pick === "adapt") {
            const failed: number[] = [];
            const worker = async () => {
              while (live.current && queue.length) {
                const item = queue.shift()!;
                try {
                  const saved = await rewrite(item);
                  current.set(item.id, saved);
                  prompts.set(item.id, saved.adaptations![format]!.prompt);
                } catch {
                  failed.push(item.seq + 1);
                }
              }
            };
            await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
            if (failed.length)
              messages.push(
                `${failed.length} 个片段转写失败，已跳过：片段 ${failed
                  .sort((first, second) => first - second)
                  .map((no) => String(no).padStart(2, "0"))
                  .join("、")}`,
              );
          }
        }
      }
      if (!live.current) return;
      const prepared = await Promise.allSettled(
        all
          .filter((item) => prompts.has(item.id))
          .map((item) => plan(current.get(item.id)!, prompts.get(item.id)!)),
      );
      const plans = prepared.flatMap((entry) =>
        entry.status === "fulfilled" ? [entry.value] : [],
      );
      const dead = [...new Set(plans.flatMap((entry) => entry.dead))];
      if (
        dead.length &&
        !(await ask({
          title: "有引用已失效",
          description: `「${dead.join("」「")}」对应的资产已被删除，这部分只会按文字提交。要继续批量生成吗？`,
          options: [{ key: "continue", label: "继续生成" }],
        }))
      )
        return;
      if (!live.current) return;
      const submitted = await Promise.allSettled(plans.map((entry) => entry.submit()));
      for (const entry of [...prepared, ...submitted])
        if (entry.status === "rejected")
          messages.push(entry.reason instanceof Error ? entry.reason.message : "生成请求失败");
      await refresh();
    } catch (error) {
      messages.push(error instanceof Error ? error.message : "生成请求失败");
    } finally {
      pending.current = false;
      if (live.current) {
        setBusy(false);
        if (messages.length) report([...new Set(messages)].join("；"));
      }
    }
  }
  return (
    <>
      <button
        className="studio-batch-video"
        type="button"
        disabled={disabled || busy}
        onClick={() => void run()}
      >
        批量生成分镜视频
      </button>
      {question && (
        <AlertDialog.Root
          open
          onOpenChange={(open) => {
            if (!open) decide();
          }}
        >
          <AlertDialog.Portal className="storyboard-layer drama-delete-layer">
            <AlertDialog.Backdrop className="shot-confirm-backdrop" />
            <AlertDialog.Popup
              className="shot-confirm drama-delete-confirm"
              data-batch-choice={question.stats ? true : undefined}
            >
              {question.stats ? (
                <DramaChoiceContent {...question} select={decide} cancel={() => decide()} />
              ) : (
                <>
                  <AlertDialog.Title>{question.title}</AlertDialog.Title>
                  <AlertDialog.Description>{question.description}</AlertDialog.Description>
                  <div>
                    <button type="button" onClick={() => decide()}>
                      取消
                    </button>
                    <button type="button" data-primary onClick={() => decide("continue")}>
                      继续生成
                    </button>
                  </div>
                </>
              )}
            </AlertDialog.Popup>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      )}
    </>
  );
}
