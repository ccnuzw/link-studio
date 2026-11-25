import { Dialog } from "@base-ui/react/dialog";
import { EditorContent, useEditor } from "@tiptap/react";
import { X } from "lucide-react";
import { useEffect } from "react";
import { markdownExtensions, TextFormatBar } from "./text-editor-format";

export default function TextEditorDialog({
  title,
  text,
  editable,
  close,
  save,
}: {
  title: string;
  text: string;
  editable: boolean;
  close: () => void;
  save: (draft: string, clipped: boolean) => void;
}) {
  const editor = useEditor({
    extensions: markdownExtensions,
    content: text,
    contentType: "markdown",
    editable,
    autofocus: false,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "文本内容",
        "aria-multiline": "true",
        class: "text-draft nowheel",
      },
    },
  });
  useEffect(() => {
    editor?.setEditable(editable, false);
  }, [editable, editor]);
  if (!editor) return null;
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (next) return;
        if (editor && editable) {
          const chars = [...editor.getMarkdown()];
          const draft = chars.slice(0, 20000).join("");
          if (draft !== text) save(draft, chars.length > 20000);
        }
        close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="text-dialog-backdrop" />
        <Dialog.Popup
          className="text-editor-dialog"
          initialFocus={() => {
            if (!editable || editor.isDestroyed) return false;
            editor.commands.focus("end", { scrollIntoView: false });
            return editor.view.dom;
          }}
        >
          <Dialog.Title>{title}</Dialog.Title>
          {editable && editor && <TextFormatBar editor={editor} />}
          <EditorContent editor={editor} />
          <Dialog.Close aria-label="关闭" className="text-dialog-close">
            <X />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
