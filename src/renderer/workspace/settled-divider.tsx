import { Sparkles } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import "./settled-divider.css";

export function SettledDivider({
  steer,
  receiptOnly,
  children,
}: {
  steer: boolean;
  receiptOnly?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const text = receiptOnly
    ? "生成全部结束 · 已停止跟进"
    : steer
      ? "生成全部结束 · 插进这一轮"
      : "生成全部结束 · Agent 自动继续";
  return (
    <>
      <div className="settled-row">
        {/* biome-ignore lint/a11y/useSemanticElements: This divider contains the visible status pill, which a void hr cannot contain. */}
        <div role="separator" aria-label={text} className="settled-divider">
          <i aria-hidden="true" />
          <span className="settled-pill">
            <Sparkles size={12} aria-hidden="true" />
            {text}
          </span>
          <i aria-hidden="true" />
        </div>
        {children && (
          <button
            type="button"
            className="settled-toggle"
            aria-label="查看生成结果详情"
            title="查看生成结果详情"
            aria-expanded={open}
            aria-controls={open ? detailsId : undefined}
            onClick={() => setOpen(!open)}
          />
        )}
      </div>
      {children && open && (
        <section id={detailsId} className="assistant-message" aria-label="生成结果详情">
          {children}
        </section>
      )}
    </>
  );
}
