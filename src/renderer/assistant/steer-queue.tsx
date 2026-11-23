import type { SettingsEvent } from "@link-studio/core";
import { Clock, ImageIcon, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";

import { projectSteers, type Steer } from "./steer-history";

export function useSteers(events: SettingsEvent[]) {
  return useMemo(() => projectSteers(events), [events]);
}

export function SteerTray({ waiting }: { waiting: Steer[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!waiting.length) return null;
  return (
    <section className="agent-steer-tray" aria-label="等待读取的插话">
      {(expanded ? waiting : waiting.slice(0, 3)).map((item) => {
        const attachments = (item.event.payload as { attachments?: unknown })?.attachments;
        const images = Array.isArray(attachments) ? attachments.length : 0;
        const text = item.text
          .replace(/@\[([^\]]*)\]\((?:node|model|skill|asset):[^)\s]+\)/g, "$1")
          .replace(/\s+/g, " ")
          .trim();
        return (
          <div key={item.id} title={text}>
            <Clock size={12} aria-hidden />
            <span>{text}</span>
            {images > 0 && (
              <small>
                <ImageIcon size={12} aria-hidden />
                {images} 张图
              </small>
            )}
          </div>
        );
      })}
      {waiting.length > 3 && (
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起" : `还有 ${waiting.length - 3} 条`}
        </button>
      )}
    </section>
  );
}

export function MissedSteer({ resend }: { resend?: () => void }) {
  return (
    <small className="agent-missed-steer">
      <TriangleAlert size={12} aria-hidden />
      运行已结束，这条没有被读取
      {resend && (
        <>
          {" "}
          ·{" "}
          <button type="button" onClick={resend}>
            作为新消息发送
          </button>
        </>
      )}
    </small>
  );
}
