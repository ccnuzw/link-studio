import { motion } from "motion/react";
import { type Stage, stages } from "./drama-workspace-nav";

export function DramaStageTabs({
  stage,
  hints,
  go,
}: {
  stage: Stage;
  hints: Partial<Record<Stage, "run" | "todo">>;
  go: (stage: Stage) => void;
}) {
  return (
    <div role="tablist" aria-label="制作工序" className="drama-stage-tabs">
      {(Object.keys(stages) as Stage[]).map((key, index) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={stage === key}
          aria-label={stages[key]}
          title={`${stages[key]}（${index + 1}）`}
          onClick={() => go(key)}
        >
          {stage === key && (
            <motion.i
              layoutId="drama-stage-active"
              transition={{ type: "spring", stiffness: 500, damping: 38, mass: 0.8 }}
            />
          )}
          <span>{stages[key]}</span>
          {hints[key] && <b aria-hidden="true" data-hint={hints[key]} />}
        </button>
      ))}
    </div>
  );
}
