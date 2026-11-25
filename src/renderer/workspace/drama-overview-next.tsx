import type { DramaDocument } from "@link-studio/core";
import { requirePresent } from "@link-studio/core";
import { ArrowRight, Clapperboard, ScanSearch, ScrollText } from "lucide-react";
import { scriptNextStep } from "./drama-script-next";
import type { Stage } from "./drama-workspace-nav";
import "./drama-overview-next.css";

const kinds = {
  scripts: { icon: ScrollText, label: "去剧本" },
  breakdown: { icon: ScanSearch, label: "拆解" },
  shoot: { icon: Clapperboard, label: "进片场" },
};

function NextItem({
  kind,
  title,
  hint,
  blocked,
  activate,
}: {
  kind: keyof typeof kinds;
  title: string;
  hint: string;
  blocked?: string;
  activate: () => void;
}) {
  const { icon: Icon, label } = kinds[kind];
  return (
    <div className="drama-next-item" data-kind={kind}>
      <span>
        <Icon size={16} />
      </span>
      <p>
        {title}
        <small>{hint}</small>
      </p>
      <button type="button" disabled={!!blocked} title={blocked || undefined} onClick={activate}>
        {label}
      </button>
    </div>
  );
}

export function DramaOverviewNext({
  doc,
  go,
  openBreakdown,
}: {
  doc: DramaDocument;
  go: (stage: Stage, no: number) => void;
  openBreakdown: () => void;
}) {
  const step = scriptNextStep(doc),
    toShoot: number[] = [];
  const pending = new Set(
    doc.segments?.filter((segment) => !segment.chosen_task_id).map((segment) => segment.episode_no),
  );
  const segmented = new Set(doc.segments?.map((segment) => segment.episode_no));
  for (const ep of doc.episodes) {
    const no = ep.episode_no;
    if (ep.locked && (!segmented.has(no) || pending.has(no))) toShoot.push(no);
  }
  return (
    <section className="drama-overview-next" aria-label="下一步">
      <h2>下一步</h2>
      <div>
        {step.kind === "scripts" ? (
          <NextItem
            kind="scripts"
            title={`${step.episodes.length} 集还没有剧本`}
            hint={`第 ${step.episodes.join("、")} 集`}
            activate={() => go("script", requirePresent(step.episodes[0], "step.episodes[0]"))}
          />
        ) : (
          step.kind === "breakdown" && (
            <NextItem
              kind="breakdown"
              title={`${step.episodes.length} 集剧本已就绪`}
              hint="拆解资产后才能生成分镜；拆解后剧本会锁定"
              blocked={step.blocked}
              activate={openBreakdown}
            />
          )
        )}
        {toShoot.length > 0 && (
          <NextItem
            kind="shoot"
            title={`${toShoot.length} 集等着出片`}
            hint={`第 ${toShoot.join("、")} 集`}
            activate={() => go("studio", requirePresent(toShoot[0], "toShoot[0]"))}
          />
        )}
        {step.kind === "none" && !toShoot.length && (
          <p className="drama-next-empty">
            <ArrowRight size={14} />
            暂时没有待办
          </p>
        )}
      </div>
    </section>
  );
}
