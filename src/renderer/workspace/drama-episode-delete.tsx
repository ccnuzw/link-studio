import { AlertDialog } from "@base-ui/react/alert-dialog";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Loader2, Trash2 } from "lucide-react";
import { type ReactElement, useState } from "react";

export interface EpisodeDeletion {
  no: number;
  title: string;
  segments: number;
  total: number;
  order: number;
}

export function EpisodeMenu({
  button,
  blocked,
  select,
}: {
  button: ReactElement;
  blocked: string;
  select: () => void;
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={button} />
      <ContextMenu.Portal>
        <ContextMenu.Positioner
          side="right"
          sideOffset={0}
          align="start"
          alignOffset={4}
          className="drama-episode-menu-position"
        >
          <ContextMenu.Popup className="drama-episode-menu">
            <ContextMenu.Item disabled={!!blocked} title={blocked || undefined} onClick={select}>
              <Trash2 size={16} />
              删除
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function EpisodeDeleteDialog({
  target,
  blocked,
  remove,
  close,
}: {
  target: EpisodeDeletion;
  blocked: string;
  remove: () => Promise<void>;
  close: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const { no, title, segments, total } = target;
  const description =
    "这一集的剧本会一起删除，不能撤销。" +
    (segments ? `它的 ${segments} 个片段也会删除，已生成的视频仍保留在素材里。` : "") +
    (no === total
      ? ""
      : no + 1 === total
        ? `第 ${total} 集会变成第 ${no} 集。`
        : `第 ${no + 1}–${total} 集会依次变成第 ${no}–${total - 1} 集。`);
  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <AlertDialog.Portal className="storyboard-layer drama-delete-layer">
        <AlertDialog.Backdrop className="shot-confirm-backdrop" />
        <AlertDialog.Popup className="shot-confirm drama-delete-confirm">
          <AlertDialog.Title
            render={<h3 />}
          >{`删除第 ${no} 集${title.trim() ? `「${title.trim()}」` : ""}？`}</AlertDialog.Title>
          <AlertDialog.Description>{description}</AlertDialog.Description>
          {(error || blocked) && <p role="alert">{blocked || error}</p>}
          <div>
            <AlertDialog.Close disabled={busy}>取消</AlertDialog.Close>
            <button type="button"
              data-destructive
              disabled={busy || !!blocked}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                setError("");
                try {
                  await remove();
                  close();
                } catch (failure) {
                  setError(failure instanceof Error ? failure.message : "删除失败，请稍后重试");
                  setBusy(false);
                }
              }}
            >
              {busy && <Loader2 size={16} aria-hidden="true" />}删除
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
