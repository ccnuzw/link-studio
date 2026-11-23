import { type Editor, Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export type SelectedReference = { id: string; label: string; kind: string };
type GhostState = {
  position: number | null;
  selection: SelectedReference[];
  committed: Set<string>;
  dismissed: Set<string>;
};

const GHOST_ICON = {
  node: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  group:
    '<path d="M3 7V5c0-1.1.9-2 2-2h2"/><path d="M17 3h2c1.1 0 2 .9 2 2v2"/><path d="M21 17v2c0 1.1-.9 2-2 2h-2"/><path d="M7 21H5c-1.1 0-2-.9-2-2v-2"/><rect width="7" height="5" x="7" y="7" rx="1"/><rect width="7" height="5" x="10" y="12" rx="1"/>',
  character: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
} as const;

function ghostDom(ref: SelectedReference) {
  const el = document.createElement("span");
  el.contentEditable = "false";
  el.className = "agent-editor-ghost";
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.innerHTML = GHOST_ICON[ref.kind === "group" || ref.kind === "character" ? ref.kind : "node"];
  const label = document.createElement("span");
  el.dataset.nodeId = ref.id;
  label.textContent = ref.label;
  el.append(icon, label);
  return el;
}

const key = new PluginKey<GhostState>("assistantSelectionGhost");

function committedIds(doc: Node) {
  const ids = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === "mention" && node.attrs.kind === "node") ids.add(node.attrs.id);
  });
  return ids;
}

function pending(state: GhostState) {
  return state.selection.filter(
    (ref) => !state.committed.has(ref.id) && !state.dismissed.has(ref.id),
  );
}

function position(state: EditorState, remembered: number | null) {
  const end = state.doc.content.size - 1;
  return Math.max(1, Math.min(remembered ?? end, end));
}

export function syncSelection(editor: Editor, selection: SelectedReference[]) {
  const previous = key.getState(editor.state)?.selection;
  if (
    previous &&
    previous.length === selection.length &&
    selection.every((ref, index) => {
      const other = previous[index];
      return ref.id === other?.id && ref.kind === other.kind && ref.label === other.label;
    })
  )
    return;
  editor.view.dispatch(editor.state.tr.setMeta(key, { selection }).setMeta("addToHistory", false));
}

export function commitSelection(editor: Editor) {
  const ghost = key.getState(editor.state);
  if (!ghost || !editor.isEditable) return;
  const refs = pending(ghost);
  if (!refs.length) return;
  editor.commands.insertContentAt(position(editor.state, ghost.position), [
    ...refs.map((ref) => ({
      type: "mention",
      attrs: { kind: "node", id: ref.id, name: ref.label, nodeKind: ref.kind },
    })),
    { type: "text", text: " " },
  ]);
}

export const SelectionGhost = Extension.create({
  name: "selectionGhost",
  addProseMirrorPlugins: () => [
    new Plugin<GhostState>({
      key,
      state: {
        init: (_, state) => ({
          position: null,
          selection: [],
          committed: committedIds(state.doc),
          dismissed: new Set(),
        }),
        apply(transaction, previous) {
          const meta = transaction.getMeta(key) as Partial<GhostState> | undefined;
          if (!meta && !transaction.docChanged) return previous;
          const selection = meta?.selection ?? previous.selection;
          const selected = new Set(selection.map((ref) => ref.id));
          const committed = transaction.docChanged
            ? committedIds(transaction.doc)
            : previous.committed;
          const dismissed = new Set(
            [
              ...previous.dismissed,
              ...[...previous.committed].filter((id) => !committed.has(id)),
            ].filter((id) => selected.has(id)),
          );
          const position =
            meta?.position ??
            (previous.position === null ? null : transaction.mapping.map(previous.position));
          return { selection, position, dismissed, committed };
        },
      },
      props: {
        decorations(state) {
          const ghost = key.getState(state);
          if (!ghost) return null;
          const at = position(state, ghost.position);
          return DecorationSet.create(
            state.doc,
            pending(ghost).map((ref, index) =>
              Decoration.widget(at, () => ghostDom(ref), {
                key: JSON.stringify([ref.id, ref.kind, ref.label]),
                side: index + 1,
                ignoreSelection: true,
                stopEvent: () => true,
              }),
            ),
          );
        },
        handleDOMEvents: {
          blur(view) {
            view.dispatch(
              view.state.tr
                .setMeta(key, { position: view.state.selection.from })
                .setMeta("addToHistory", false),
            );
            return false;
          },
        },
      },
    }),
  ],
});
