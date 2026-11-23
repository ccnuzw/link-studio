import { Node as TiptapNode } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { UndoRedo } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import { Plus } from "lucide-react";
import { useEffect } from "react";

import {
  BOARD_PLACEHOLDERS,
  docToText,
  PLACEHOLDER_NODE,
  textToDoc,
} from "./drama-placeholder-doc";

const PlaceholderNode = TiptapNode.create({
  name: PLACEHOLDER_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { name: { default: "" } };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-placeholder]",
        getAttrs: (el) => ({ name: (el as HTMLElement).getAttribute("data-placeholder") ?? "" }),
      },
    ];
  },
  renderHTML({ node }) {
    return [
      "span",
      {
        "data-placeholder": String(node.attrs.name),
        contenteditable: "false",
        class:
          "bg-chrome ring-chrome-border mx-0.5 inline-flex items-center rounded-full px-2 py-px align-baseline font-sans text-[12.5px] font-medium ring-1 select-none [&.ProseMirror-selectednode]:ring-2 [&.ProseMirror-selectednode]:ring-ring",
      },
      String(node.attrs.name),
    ];
  },
});

const EXTENSIONS = [Document, Paragraph, Text, HardBreak, UndoRedo, PlaceholderNode];

export function PlaceholderEditor({
  value,
  onChange,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (text: string) => void;
  ariaLabel: string;
  className?: string;
}) {
  const editor = useEditor({
    extensions: EXTENSIONS,
    content: textToDoc(value),
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": ariaLabel,
        class: "min-h-full whitespace-pre-wrap break-words outline-none",
      },
    },
    onUpdate: ({ editor: self }) => onChange(docToText(self.getJSON())),
  });

  useEffect(() => {
    if (!editor || docToText(editor.getJSON()) === value) return;
    editor.commands.setContent(textToDoc(value), { emitUpdate: false });
  }, [editor, value]);

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-1.5" data-slot="placeholder-toolbar">
        {BOARD_PLACEHOLDERS.map((name) => (
          <button
            key={name}
            type="button"
            aria-label={`插入占位符 ${name}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() =>
              editor
                ?.chain()
                .focus()
                .insertContent({ type: PLACEHOLDER_NODE, attrs: { name } })
                .run()
            }
            className="bg-chrome-hover ring-chrome-border hover:bg-chrome focus-visible:ring-ring/50 inline-flex h-7 items-center gap-1 rounded-full px-3 text-[12.5px] ring-1 outline-none focus-visible:ring-2"
          >
            <Plus className="size-3" />
            {name}
          </button>
        ))}
      </div>
      <EditorContent
        editor={editor}
        className={className}
        onClick={() => editor?.commands.focus()}
      />
    </div>
  );
}
