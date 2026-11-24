import { Loader2 } from "lucide-react";

export function DramaGenerateButton({
  reason,
  busy,
  again,
  credits,
  generate,
}: {
  reason?: string;
  busy?: boolean;
  again?: boolean;
  credits?: number;
  generate?: () => void;
}) {
  return (
    <button
      className="drama-studio-generate"
      type="button"
      disabled={!!reason}
      title={reason || "开始生成这个片段的视频（⌘↵）"}
      onClick={generate}
    >
      {busy && <Loader2 size={16} />}
      {again ? "再生成一次" : "立即生成"}
      {credits !== undefined && (
        <>
          <span aria-hidden="true">·</span>
          <b>{credits}</b>
        </>
      )}
    </button>
  );
}
