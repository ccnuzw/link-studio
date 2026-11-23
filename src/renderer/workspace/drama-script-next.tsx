import { type DramaDocument, dramaBusyReason } from "@link-studio/core";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

export function scriptNextStep(doc: DramaDocument) {
  const missing: number[] = [],
    ready: number[] = [];
  for (const ep of doc.episodes) {
    const status = ep.script_status ?? (ep.script_md.trim() ? "ready" : "empty");
    if (status === "empty" || status === "failed") missing.push(ep.episode_no);
    if (status === "ready" && !ep.locked) ready.push(ep.episode_no);
  }
  const blocked = dramaBusyReason(doc);
  return missing.length
    ? { kind: "scripts" as const, episodes: missing, blocked }
    : ready.length
      ? { kind: "breakdown" as const, episodes: ready, blocked }
      : { kind: "none" as const, episodes: [], blocked };
}

export function DramaScriptNext({
  step,
  projectHandle,
  order,
  open,
}: {
  step: ReturnType<typeof scriptNextStep>;
  projectHandle: string;
  order: number;
  open: (kind: "scripts" | "breakdown") => void;
}) {
  const numbers = step.kind === "scripts" ? JSON.stringify(step.episodes.slice(0, 200)) : "";
  const key = JSON.stringify([projectHandle, order, numbers]);
  const [quote, setQuote] = useState<{ key: string; credits: number }>();
  useEffect(() => {
    if (!numbers) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const result = await window.desktop.projects.estimateDramaScripts({
          projectHandle,
          episodes: JSON.parse(numbers),
        });
        if (live && result.ok) setQuote({ key, credits: result.value });
      } catch {
        if (live) setQuote(undefined);
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
      setQuote(undefined);
    };
  }, [numbers, projectHandle, key]);
  return (
    <AnimatePresence>
      {step.kind !== "none" && (
        <motion.div
          key={step.kind}
          className="drama-script-next"
          data-step={step.kind}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8, transition: { duration: 0.126 } }}
          transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
        >
          {step.kind === "scripts" ? (
            <>
              <span>{step.episodes.length} 集还没有剧本</span>
              {quote?.key === key && (
                <small>
                  {step.episodes.length > 200 && "前 200 集 "}约 <em>{quote.credits}</em> 积分
                </small>
              )}
            </>
          ) : (
            <span>剧本整理完毕，下一步拆解角色和场景</span>
          )}
          <button
            type="button"
            disabled={!!step.blocked}
            title={step.blocked || undefined}
            onClick={() => open(step.kind)}
          >
            {step.kind === "scripts" ? "生成分集剧本" : "资产拆解"}
          </button>
          {step.blocked && <small className="drama-script-blocked">{step.blocked}</small>}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
