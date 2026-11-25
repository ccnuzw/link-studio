import { Popover } from "@base-ui/react/popover";
import { FileText, Image as ImageIcon, Plus } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { CanvasControlTip } from "./canvas-control-tip";

export function AssistantAttachMenu({
  disabled,
  running,
  onImages,
  onDocuments,
  children,
}: {
  disabled: boolean;
  running: boolean;
  onImages: (files: FileList) => void;
  onDocuments: (files: FileList) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const image = useRef<HTMLInputElement>(null);
  const document = useRef<HTMLInputElement>(null);
  const picked = (input: HTMLInputElement, add: (files: FileList) => void) => {
    if (input.files?.length) add(input.files);
    input.value = "";
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <CanvasControlTip label="添加附件">
        <Popover.Trigger
          type="button"
          className="composer-tool"
          aria-label="添加附件"
          disabled={disabled}
        >
          <Plus size={17} aria-hidden />
        </Popover.Trigger>
      </CanvasControlTip>
      <Popover.Portal>
        <Popover.Positioner
          className="assistant-model-position"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
        >
          <Popover.Popup
            className="assistant-model-menu assistant-attach-menu"
            aria-label="添加附件"
          >
            <button className="attach-action" type="button" onClick={() => image.current?.click()}>
              <ImageIcon size={16} aria-hidden />
              <span>
                上传图片<small>作为图片附件发送，也可以直接粘贴或拖进输入框</small>
              </span>
            </button>
            <button
              className="attach-action"
              type="button"
              disabled={running}
              onClick={() => document.current?.click()}
            >
              <FileText size={16} aria-hidden />
              <span>
                上传故事或剧本<small>选一个 .txt 或 .md 文件，作为附件发给 Agent</small>
              </span>
            </button>
            <input
              hidden
              ref={image}
              type="file"
              aria-label="上传图片"
              multiple
              accept="image/png,image/jpeg,image/webp"
              onChange={({ currentTarget }) => picked(currentTarget, onImages)}
            />
            <input
              hidden
              ref={document}
              type="file"
              aria-label="上传故事或剧本"
              multiple
              disabled={running}
              accept=".txt,.md,.markdown,text/plain,text/markdown"
              onChange={({ currentTarget }) => picked(currentTarget, onDocuments)}
            />
            <details className="attach-more">
              <summary>更多资料</summary>
              <div>{children}</div>
            </details>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
