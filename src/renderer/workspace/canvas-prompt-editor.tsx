import { requirePresent } from "@link-studio/core";
import { Node } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Mention from "@tiptap/extension-mention";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { UndoRedo } from "@tiptap/extensions";
import {
  EditorContent,
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
} from "@tiptap/react";
import type { SuggestionProps } from "@tiptap/suggestion";
import {
  Clapperboard,
  GalleryHorizontalEnd,
  Image as ImageIcon,
  Link2,
  Type,
  UserRound,
  Video,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  createContext,
  type Ref,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { TEMPLATE_PRESETS } from "./media-presets";
import { MediaThumbnail } from "./media-thumbnail";
import type { MentionSource, mentionSources } from "./mention-sources";
import { NodeAudioIcon } from "./node-audio-icon";
import { docToPrompt, parsePrompt, promptToDoc } from "./prompt-tokens";
import "./canvas-prompt-editor.css";
import { applyEditorPreset, PresetChip, PresetTarget } from "./editor-preset";
import type { PresetKind } from "./media-presets";
import { RefHighlight } from "./ref-highlight";
import { useRefPeek } from "./use-ref-peek";
export type CanvasPromptHandle = {
  applyPreset: (kind: PresetKind, id: string, target?: number) => boolean;
  focus: () => void;
};

type Sources = ReturnType<typeof mentionSources>;
const SourcesContext = createContext<{ sources: Sources; projectHandle?: string } | null>(null);
export function useThumbURL(source?: MentionSource, projectHandle?: string, library = false) {
  const context = useContext(SourcesContext);
  const handle = projectHandle ?? context?.projectHandle;
  const [preview, setPreview] = useState<{
    handle: string;
    library: boolean;
    assetId: string;
    url: string;
  }>();
  const assetId = source?.assetId;
  const kind = source?.kind;
  useEffect(() => {
    if (!handle || !assetId || !["image", "character", "video"].includes(kind ?? "")) return;
    let current = true;
    void window.desktop.projects
      .getAssetPreview({ projectHandle: handle, assetId, ...(library && { library: true }) })
      .then(
        (result) => {
          if (current && result.ok) setPreview({ handle, library, assetId, url: result.value.url });
        },
        () => {},
      );
    return () => {
      current = false;
    };
  }, [assetId, handle, kind, library]);
  return preview &&
    handle === preview.handle &&
    library === preview.library &&
    assetId === preview.assetId
    ? preview.url
    : undefined;
}
export function Thumb({
  source,
  url,
  projectHandle,
}: {
  source?: MentionSource;
  url?: string;
  projectHandle?: string;
}) {
  const context = useContext(SourcesContext);
  const handle = projectHandle ?? context?.projectHandle;
  const kind = source?.kind;
  const Icon =
    kind === "audio"
      ? NodeAudioIcon
      : kind === "video"
        ? Video
        : kind === "script"
          ? Type
          : kind === "character"
            ? UserRound
            : kind === "storyboard"
              ? GalleryHorizontalEnd
              : kind === "director"
                ? Clapperboard
                : ImageIcon;
  return (
    <span
      className="prompt-ref-thumb"
      data-kind={kind}
      data-backed={!!source?.assetId || undefined}
    >
      {kind === "video" && handle && source?.assetId ? (
        <MediaThumbnail
          key={`${handle}:${source.assetId}`}
          handle={handle}
          assetId={source.assetId}
          video
        />
      ) : url && kind !== "video" ? (
        <img alt="" src={url} draggable={false} />
      ) : (
        <Icon />
      )}
    </span>
  );
}
function MenuThumb({ source }: { source: MentionSource }) {
  const url = useThumbURL(source.kind === "video" ? undefined : source);
  return <Thumb source={source} url={url} />;
}
function RefChip({ node }: NodeViewProps) {
  const sources = useContext(SourcesContext)?.sources;
  const id = String(node.attrs.id);
  const source = sources?.byId.get(id);
  const gone = !source || !sources?.linked.has(id);
  const label = source?.label || String(node.attrs.label);
  const url = useThumbURL(source);
  const { bind, peek } = useRefPeek(
    {
      kind: source?.kind ?? "image",
      mediaType: source?.kind === "character" ? "image" : undefined,
      src: url,
      gone,
    },
    `${label} 的大图`,
  );
  const highlight = useContext(RefHighlight);
  return (
    <NodeViewWrapper
      as="span"
      data-ref={id}
      data-gone={gone}
      className="prompt-ref-chip"
      data-lit={highlight?.id === id || undefined}
      onMouseEnter={() => highlight?.set(id)}
      onMouseLeave={() => highlight?.set(null)}
      {...bind}
      title={gone ? "引用已断开：重新连线，或删掉这个引用" : `引用「${label}」`}
    >
      <Thumb source={source} url={url} />
      <span>{label}</span>
      {peek}
    </NodeViewWrapper>
  );
}
const preset = Node.create({
  addNodeView: () => ReactNodeViewRenderer(PresetChip, { as: "span" }),
  renderText: ({ node }) => String(node.attrs.label ?? ""),
  name: "preset",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes: () => ({
    id: { default: "" },
    kind: { default: "style" },
    label: { default: "" },
  }),
  renderHTML: ({ node }) => [
    "span",
    { class: "prompt-ref-chip", "data-preset": `${node.attrs.kind}/${node.attrs.id}` },
    String(node.attrs.label),
  ],
});
type Menu = Pick<SuggestionProps, "query" | "command"> & { rect: DOMRect | null };

export function CanvasPromptEditor({
  ref,
  openPreset,
  value,
  change,
  sources,
  projectHandle,
  link,
  disabled,
  expanded,
  placeholder,
  studio,
  editorLabel,
  acceptDrop,
}: {
  ref?: Ref<CanvasPromptHandle>;
  openPreset?: (kind: PresetKind, index: number, anchor: HTMLElement) => void;
  value: string;
  change: (value: string) => void;
  sources: Sources;
  projectHandle?: string;
  link: (id: string) => void;
  disabled: boolean;
  expanded: boolean;
  placeholder: string;
  studio?: boolean;
  editorLabel?: string;
  acceptDrop?: (data: DataTransfer) => { id: string; label: string } | null;
}) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const query = menu?.query ?? "";
  const normalizedQuery = query.toLowerCase();
  const entries = sources.entries.filter((entry) =>
    entry.source.label.toLowerCase().includes(normalizedQuery),
  );
  const selected = Math.min(active, Math.max(0, entries.length - 1));
  const pick = (entry: Sources["entries"][number] | undefined) => {
    if (!menu || !entry || disabled) return;
    menu.command({ id: entry.source.id, label: entry.source.label });
    if (!entry.linked) link(entry.source.id);
  };
  const [extensions] = useState(() => {
    const show = (props: SuggestionProps) => {
      setActive(0);
      setMenu({ query: props.query, command: props.command, rect: props.clientRect?.() ?? null });
    };
    return [
      Document,
      Paragraph,
      Text,
      HardBreak,
      UndoRedo,
      preset,
      Mention.extend({
        addNodeView: () => ReactNodeViewRenderer(RefChip, { as: "span" }),
      }).configure({
        deleteTriggerWithBackspace: true,
        renderText: ({ node }) => String(node.attrs.label ?? ""),
        suggestion: {
          char: "@",
          allowedPrefixes: null,
          allow: ({ editor }) => editor.view.hasFocus(),
          items: () => [],
          render: () => ({ onStart: show, onUpdate: show, onExit: () => setMenu(null) }),
        },
      }),
    ];
  });
  const [initial] = useState(() => promptToDoc(value));
  const touched = useRef(false);
  const editor = useEditor({
    extensions,
    content: initial,
    editable: !disabled,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": editorLabel ?? (studio ? "片段原稿" : "生成提示词"),
        "aria-multiline": "true",
        "data-node-prompt": "",
        class: "canvas-prompt-content nowheel nodrag nopan",
      },
      handleDrop: (view, event) => {
        const hit = !disabled && event.dataTransfer && acceptDrop?.(event.dataTransfer);
        if (!hit) return false;
        const at =
          view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ??
          view.state.selection.to;
        const { schema } = view.state;
        view.dispatch(
          view.state.tr.insert(at, [
            requirePresent(schema.nodes.mention, "schema.nodes.mention").create({
              id: hit.id,
              label: hit.label,
            }),
            schema.text(" "),
          ]),
        );
        view.focus();
        return true;
      },
      handleKeyDown: (view, event) => {
        if (event.isComposing || view.composing) return false;
        if (menu) {
          if (event.key === "Escape") {
            event.stopPropagation();
            return false;
          }
          if (!entries.length) return false;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            setActive(
              (selected + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length,
            );
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            pick(entries[selected]);
            return true;
          }
          return false;
        }
        if (
          event.key !== "Enter" ||
          event.shiftKey ||
          (expanded && !event.metaKey && !event.ctrlKey)
        )
          return false;
        if (event.repeat && studio) return true;
        view.dom.closest("form")?.requestSubmit();
        return true;
      },
    },
    onUpdate: ({ editor }) => change(docToPrompt(editor.getJSON())),
    onFocus: () => {
      touched.current = true;
    },
  });
  useImperativeHandle(
    ref,
    () => ({
      applyPreset: (kind, id, target) =>
        !!editor && applyEditorPreset(editor, touched.current, kind, id, target),
      focus: () => {
        editor?.commands.focus();
      },
    }),
    [editor],
  );
  useEffect(() => {
    if (editor && docToPrompt(editor.getJSON()) !== value)
      editor.commands.setContent(promptToDoc(value), { emitUpdate: false });
  }, [editor, value]);
  useEffect(() => {
    editor?.setEditable(!disabled, false);
  }, [editor, disabled]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const rect = menu?.rect;
  const segments = parsePrompt(value);
  const template = segments.find((segment) => segment.type === "preset" && segment.kind === "tpl");
  const templateHint =
    template?.type === "preset" &&
    !segments.some(
      (segment) => segment.type === "ref" || (segment.type === "text" && segment.text.trim()),
    )
      ? TEMPLATE_PRESETS.find((item) => item.id === template.id)?.usage
      : undefined;
  const width = Math.min(300, window.innerWidth - 16);
  const height = Math.min(
    360,
    window.innerHeight * 0.6,
    12 + Math.max(1, entries.length) * 40 + new Set(entries.map((entry) => entry.linked)).size * 28,
  );
  const up = rect && rect.bottom + 6 + height > window.innerHeight - 8 && rect.top - height - 6 > 8;
  const left = Math.min(Math.max(8, (rect?.left ?? 0) - 14), window.innerWidth - width - 8);
  return (
    <SourcesContext.Provider value={{ sources, projectHandle }}>
      <div
        ref={wrapper}
        className="canvas-prompt-wrap"
        data-expanded={expanded}
        style={
          templateHint
            ? ({
                "--tpl-hint": JSON.stringify(`${templateHint}。可以补充说明，也可以直接发送`),
              } as React.CSSProperties)
            : undefined
        }
      >
        <PresetTarget.Provider value={disabled || expanded ? undefined : openPreset}>
          <EditorContent editor={editor} />
        </PresetTarget.Provider>
        {!value && <span className="canvas-prompt-placeholder">{placeholder}</span>}
      </div>
      {createPortal(
        <AnimatePresence>
          {rect && (
            <motion.div
              ref={list}
              role="listbox"
              aria-label={studio ? "引用短剧资产" : "引用画布里的素材"}
              className="canvas-mention-list nowheel"
              onMouseDown={(event) => event.preventDefault()}
              initial={{ opacity: 0, scale: reduce ? 1 : 0.96, y: reduce ? 0 : up ? 4 : -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{
                opacity: 0,
                scale: reduce ? 1 : 0.96,
                y: reduce ? 0 : up ? 4 : -4,
                transition: { duration: 0.126, ease: [0.2, 0, 0, 1] },
              }}
              transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
              style={{
                left,
                width,
                maxHeight: height,
                transformOrigin: `${rect.left - left}px ${up ? "100%" : "0"}`,
                ...(up ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
              }}
            >
              {[true, false].map(
                (linked) =>
                  entries.some((entry) => entry.linked === linked) && (
                    <section key={String(linked)}>
                      <p>
                        {studio
                          ? linked
                            ? "本集资产"
                            : "其他集"
                          : linked
                            ? "已引用"
                            : "画布中 · 选中后自动连线"}
                      </p>
                      {entries.map(
                        (entry, index) =>
                          entry.linked === linked && (
                            <button
                              key={entry.source.id}
                              type="button"
                              role="option"
                              aria-selected={index === selected}
                              onMouseMove={() => setActive(index)}
                              onClick={() => pick(entry)}
                            >
                              <MenuThumb source={entry.source} />
                              <span>{entry.source.label}</span>
                              {!studio && !linked && (
                                <small>
                                  <Link2 size={12} />
                                  连线
                                </small>
                              )}
                            </button>
                          ),
                      )}
                    </section>
                  ),
              )}
              {!entries.length && (
                <p>
                  {query
                    ? `没有匹配「${menu.query}」的素材`
                    : studio
                      ? "还没有可引用的资产"
                      : "画布里还没有能引用的素材"}
                </p>
              )}
            </motion.div>
          )}
        </AnimatePresence>,
        wrapper.current?.closest("dialog") ?? document.body,
      )}
    </SourcesContext.Provider>
  );
}
