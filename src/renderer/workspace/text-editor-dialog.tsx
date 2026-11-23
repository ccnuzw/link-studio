import { Button } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import { Markdown } from "@tiptap/markdown";
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Strikethrough,
  Undo2,
  X,
} from "lucide-react";
import { type ReactNode, useEffect } from "react";

export const markdownExtensions = [
  StarterKit.configure({ link: false, underline: false }),
  Markdown,
];
type ToolbarItem = {
  label: string;
  icon: ReactNode;
  run: (editor: Editor) => void;
  active?: (editor: Editor) => boolean;
  enabled?: (editor: Editor) => boolean;
};

const TOOLBAR_GROUPS: ToolbarItem[][] = [
  [
    {
      label: "一级标题",
      icon: <Heading1 />,
      run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
      active: (editor) => editor.isActive("heading", { level: 1 }),
    },
    {
      label: "二级标题",
      icon: <Heading2 />,
      run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
      active: (editor) => editor.isActive("heading", { level: 2 }),
    },
    {
      label: "三级标题",
      icon: <Heading3 />,
      run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
      active: (editor) => editor.isActive("heading", { level: 3 }),
    },
  ],
  [
    {
      label: "加粗",
      icon: <Bold />,
      run: (editor) => editor.chain().focus().toggleBold().run(),
      active: (editor) => editor.isActive("bold"),
    },
    {
      label: "斜体",
      icon: <Italic />,
      run: (editor) => editor.chain().focus().toggleItalic().run(),
      active: (editor) => editor.isActive("italic"),
    },
    {
      label: "删除线",
      icon: <Strikethrough />,
      run: (editor) => editor.chain().focus().toggleStrike().run(),
      active: (editor) => editor.isActive("strike"),
    },
    {
      label: "行内代码",
      icon: <Code />,
      run: (editor) => editor.chain().focus().toggleCode().run(),
      active: (editor) => editor.isActive("code"),
    },
  ],
  [
    {
      label: "无序列表",
      icon: <List />,
      run: (editor) => editor.chain().focus().toggleBulletList().run(),
      active: (editor) => editor.isActive("bulletList"),
    },
    {
      label: "有序列表",
      icon: <ListOrdered />,
      run: (editor) => editor.chain().focus().toggleOrderedList().run(),
      active: (editor) => editor.isActive("orderedList"),
    },
    {
      label: "引用",
      icon: <Quote />,
      run: (editor) => editor.chain().focus().toggleBlockquote().run(),
      active: (editor) => editor.isActive("blockquote"),
    },
    {
      label: "分隔线",
      icon: <Minus />,
      run: (editor) => editor.chain().focus().setHorizontalRule().run(),
    },
  ],
  [
    {
      label: "撤销",
      icon: <Undo2 />,
      run: (editor) => editor.chain().focus().undo().run(),
      enabled: (editor) => editor.can().undo(),
    },
    {
      label: "重做",
      icon: <Redo2 />,
      run: (editor) => editor.chain().focus().redo().run(),
      enabled: (editor) => editor.can().redo(),
    },
  ],
];

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

export function TextFormatBar({ editor }: { editor: Editor }) {
  return (
    <div role="toolbar" aria-label="文本格式" className="text-format-bar">
      {TOOLBAR_GROUPS.map((group) => (
        <div key={group[0]?.label}>
          {group.map((item) => (
            <Button
              key={item.label}
              type="button"
              aria-label={item.label}
              title={item.label}
              aria-pressed={item.active?.(editor)}
              disabled={item.enabled && !item.enabled(editor)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => item.run(editor)}
            >
              {item.icon}
            </Button>
          ))}
        </div>
      ))}
    </div>
  );
}
