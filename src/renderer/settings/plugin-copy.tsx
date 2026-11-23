import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { copySettingsText } from "./copy-settings-text";

export function PluginCopy({
  text,
  label,
  iconOnly = false,
  className,
  onError,
  onCopied,
}: {
  text: string;
  label: string;
  iconOnly?: boolean;
  className?: string;
  onError?: () => void;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(0);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(0), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={className}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
      onClick={async () => {
        try {
          await copySettingsText(text);
          setCopied((previous) => previous + 1);
          onCopied?.();
        } catch {
          onError?.();
        }
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />} {!iconOnly && (copied ? "已复制" : label)}
    </button>
  );
}
