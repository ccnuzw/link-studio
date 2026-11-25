import { useEffect, useRef, useState } from "react";

export function TextFailureTask({ reference }: { reference: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(reference);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button
      type="button"
      className="canvas-text-task-id nodrag nowheel"
      title="点击复制任务 ID"
      aria-label={`任务 ID ${reference}，点击复制`}
      onClick={copy}
    >
      <span style={{ visibility: copied ? "hidden" : "visible" }}>任务 ID：{reference}</span>
      <span aria-hidden style={{ visibility: copied ? "visible" : "hidden" }}>
        已复制任务 ID
      </span>
    </button>
  );
}
