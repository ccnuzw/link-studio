import { type Editor, Node as EditorNode, type Range } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { UndoRedo } from "@tiptap/extensions";
import { Plugin } from "@tiptap/pm/state";
import {
  EditorContent,
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
} from "@tiptap/react";
import { Box, FileText, GalleryHorizontalEnd, Group, Lightbulb, UserRound } from "lucide-react";
import {
  type RefObject,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { documentDraft, draftDocument } from "./assistant-editor-doc";
import { type ModelMention, serializeModels } from "./assistant-model-mentions";
import {
  commitSelection,
  type SelectedReference,
  SelectionGhost,
  syncSelection,
} from "./assistant-selection-ghost";

type Kind = NonNullable<ModelMention["kind"]>;
type Option = { id: string; title: string; summary?: string; nodeKind?: string };
type Suggestion = { kind: "node" | "skill"; query: string; range: Range };
export type AssistantEditorHandle = {
  focus(): void;
  element(): HTMLElement | null;
  insert(kind: Kind, id: string, name: string): void;
};

function ChipView({ node }: NodeViewProps) {
  const { kind, name } = node.attrs;
  const nodeIcons = { group: Group, character: UserRound, storyboard: GalleryHorizontalEnd };
  const Icon =
    kind === "skill"
      ? Lightbulb
      : kind === "model"
        ? Box
        : (nodeIcons[node.attrs.nodeKind as keyof typeof nodeIcons] ?? FileText);
  return (
    <NodeViewWrapper as="span" className="agent-editor-atom">
      <span contentEditable={false} className="agent-editor-chip" data-kind={kind}>
        <Icon size={12} aria-hidden />
        <span>{name}</span>
      </span>
    </NodeViewWrapper>
  );
}

const Chip = EditorNode.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes: () => ({
    kind: { default: "node" },
    id: { default: "" },
    name: { default: "" },
    nodeKind: { default: null },
  }),
  renderHTML: ({ node }) => ["span", {}, String(node.attrs.name)],
  renderText: ({ node }) => `@${node.attrs.name}`,
  addNodeView: () => ReactNodeViewRenderer(ChipView),
  addProseMirrorPlugins: () => [
    new Plugin({
      filterTransaction(transaction) {
        if (!transaction.docChanged) return true;
        const { message, mentions } = documentDraft(transaction.doc.toJSON());
        return serializeModels(message, mentions).length <= 24000;
      },
    }),
  ],
});
const extensions = [Document, Paragraph, Text, HardBreak, UndoRedo, Chip, SelectionGhost];
const emptyMentions: ModelMention[] = [];

function suggestionAt(editor: Editor): Suggestion | null {
  const { $from, empty } = editor.state.selection;
  if (!empty) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "\ufffc");
  const match = /(@|\/)([^\s@/\ufffc]*)$/u.exec(before);
  if (!match || (match[1] === "/" && /[\w:/]/u.test(before[match.index - 1] ?? ""))) return null;
  return {
    kind: match[1] === "/" ? "skill" : "node",
    query: match[2] ?? "",
    range: { from: $from.pos - match[0].length, to: $from.pos },
  };
}

export function AssistantEditor({
  editor: handle,
  message,
  mentions = emptyMentions,
  busy,
  running,
  nodes,
  skills,
  selection,
  onText,
  onImages,
  settings = false,
}: {
  editor: RefObject<AssistantEditorHandle | null>;
  message: string;
  mentions?: ModelMention[];
  busy: boolean;
  running: boolean;
  nodes?: Option[];
  skills?: Option[];
  settings?: boolean;
  selection?: SelectedReference[];
  onText: (message: string, mentions: ModelMention[]) => void;
  onImages?: (files: FileList) => boolean;
}) {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();
  const popup = useRef<HTMLDivElement>(null);
  const items = suggestion?.kind === "node" ? nodes : skills;
  const options = (items ?? []).filter((item) =>
    (suggestion?.kind === "node" ? item.title : `${item.title} ${item.id} ${item.summary ?? ""}`)
      .toLowerCase()
      .includes(suggestion?.query.toLowerCase() ?? ""),
  );
  if (suggestion?.kind === "node") options.splice(8);
  const showMenu = !!suggestion && !busy && (options.length > 0 || suggestion.kind === "skill");
  const live = useRef({ onText, onImages, suggestion, options, active, showMenu, busy, running });
  live.current = { onText, onImages, suggestion, options, active, showMenu, busy, running };
  function refresh(current: Editor) {
    if (settings) return;
    const next = suggestionAt(current);
    setSuggestion(next?.kind === "skill" && live.current.running ? null : next);
    setActive(0);
  }
  function insert(
    current: Editor,
    kind: Kind,
    id: string,
    name: string,
    range: Range = current.state.selection,
  ) {
    const chain = current.chain().insertContentAt({ from: range.from, to: range.to }, [
      {
        type: "mention",
        attrs: {
          kind,
          id,
          name,
          nodeKind:
            kind === "node"
              ? live.current.options.find((option) => option.id === id)?.nodeKind
              : undefined,
        },
      },
      { type: "text", text: " " },
    ]);
    chain.run();
    setSuggestion(null);
  }
  const editor: Editor | null = useEditor({
    extensions,
    content: draftDocument(message, mentions),
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": settings ? "消息" : "画布消息",
        "aria-multiline": "true",
        class: "agent-rich-input",
      },
      handlePaste: (_view, event) =>
        !!(event.clipboardData && live.current.onImages?.(event.clipboardData.files)),
      handleDOMEvents: {
        keydown: (_view, event) => {
          if (event.key !== "Enter" || !event.isComposing) return false;
          return true;
        },
        dragover: (_view, event) => {
          if (
            !live.current.onImages ||
            !Array.from(event.dataTransfer?.items ?? []).some((item) =>
              item.type.startsWith("image/"),
            )
          )
            return false;
          event.preventDefault();
          return true;
        },
        drop: (_view, event) => {
          if (!event.dataTransfer || !live.current.onImages?.(event.dataTransfer.files))
            return false;
          event.preventDefault();
          event.stopPropagation();
          return true;
        },
      },
      handleKeyDown: (view, event) => {
        if (view.composing || event.isComposing || event.keyCode === 229) return false;
        const state = live.current;
        if (state.showMenu && state.suggestion) {
          if (event.key === "Escape") {
            setSuggestion(null);
            return true;
          }
          if (state.options.length && ["ArrowDown", "ArrowUp"].includes(event.key)) {
            const index =
              (state.active + (event.key === "ArrowUp" ? -1 : 1) + state.options.length) %
              state.options.length;
            setActive(index);
            document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: "nearest" });
            return true;
          }
          const option = state.options[state.active];
          if (editor && option && ["Enter", "Tab"].includes(event.key)) {
            insert(editor, state.suggestion.kind, option.id, option.title, state.suggestion.range);
            return true;
          }
        }
        if (
          event.key !== "Enter" ||
          event.shiftKey ||
          event.altKey ||
          event.metaKey ||
          event.ctrlKey
        )
          return false;
        if (!state.busy && !event.repeat) view.dom.closest("form")?.requestSubmit();
        return true;
      },
    },
    onUpdate: ({ editor: current }) => {
      const draft = documentDraft(current.getJSON());
      live.current.onText(draft.message, draft.mentions);
      refresh(current);
    },
    onSelectionUpdate: ({ editor: current }) => refresh(current),
    onFocus: ({ editor: current }) =>
      requestAnimationFrame(() => {
        if (!current.isDestroyed && current.isFocused) commitSelection(current);
      }),
    onBlur: () => setSuggestion(null),
  });
  useImperativeHandle(
    handle,
    () => ({
      focus: () => editor?.view.focus(),
      element: () => editor?.view.dom ?? null,
      insert: (kind, id, name) => {
        if (editor) insert(editor, kind, id, name);
      },
    }),
    [editor],
  );
  useLayoutEffect(() => {
    if (!editor) return;
    const draft = documentDraft(editor.getJSON());
    if (
      draft.message !== message ||
      serializeModels(draft.message, draft.mentions) !== serializeModels(message, mentions)
    ) {
      editor.commands.setContent(draftDocument(message, mentions), { emitUpdate: false });
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    }
  }, [editor, message, mentions]);
  useLayoutEffect(() => {
    editor?.setEditable(!busy, false);
  }, [busy, editor]);
  useLayoutEffect(() => {
    if (editor && selection) syncSelection(editor, selection);
  }, [editor, selection]);
  useLayoutEffect(() => {
    if (!editor) return;
    const input = editor.view.dom;
    if (showMenu && options.length) {
      input.setAttribute("aria-controls", listId);
      input.setAttribute("aria-activedescendant", `${listId}-${active}`);
    } else {
      input.removeAttribute("aria-controls");
      input.removeAttribute("aria-activedescendant");
    }
  }, [editor, showMenu, options.length, listId, active]);
  useLayoutEffect(() => {
    const menu = popup.current;
    if (!menu || !editor || !suggestion || !showMenu) return;
    menu.showPopover();
    const place = () => {
      const point = editor.view.coordsAtPos(
        Math.min(suggestion.range.from, editor.state.doc.content.size),
      );
      menu.style.left = `${Math.max(8, Math.min(point.left, innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.bottom = `${innerHeight - point.top + 6}px`;
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node && menu.contains(event.target))) place();
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(editor.view.dom);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", scroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [editor, suggestion, showMenu]);
  const placeholder = running
    ? "补充要求，Agent 会在下一步看到"
    : settings
      ? "描述要调整的配置"
      : "描述你的想法，@ 引用节点，/ 插入技能";
  return (
    <div className="assistant-inline-editor">
      {!message && (
        <span className="agent-editor-placeholder" aria-hidden>
          {placeholder}
        </span>
      )}
      <EditorContent editor={editor} />
      {showMenu && suggestion && (
        <div
          ref={popup}
          popover="manual"
          className="assistant-inline-menu"
          data-kind={suggestion.kind === "node" ? "@" : "/"}
        >
          {options.length ? (
            <div
              role="listbox"
              id={listId}
              aria-label={suggestion.kind === "node" ? "引用节点" : "插入技能"}
            >
              {options.map((option, index) => (
                <button
                  key={option.id}
                  id={`${listId}-${index}`}
                  type="button"
                  tabIndex={-1}
                  role="option"
                  aria-selected={index === active}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => {
                    if (editor)
                      insert(editor, suggestion.kind, option.id, option.title, suggestion.range);
                  }}
                >
                  {option.title}
                  {option.summary && <small>{option.summary}</small>}
                </button>
              ))}
            </div>
          ) : (
            <p role="status">{skills?.length ? "没有找到匹配的技能" : "还没有启用的技能"}</p>
          )}
        </div>
      )}
    </div>
  );
}
