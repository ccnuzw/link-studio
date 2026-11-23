import type { Editor } from "@tiptap/core";
import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { Box, Camera, Shapes } from "lucide-react";
import { createContext, useContext } from "react";
import { MOTION_PRESETS, type PresetKind, STYLE_PRESETS, TEMPLATE_PRESETS } from "./media-presets";

const presets = { style: STYLE_PRESETS, motion: MOTION_PRESETS, tpl: TEMPLATE_PRESETS };
const icons = { style: Box, motion: Camera, tpl: Shapes };
type PickTarget = (kind: PresetKind, index: number, anchor: HTMLElement) => void;
export const PresetTarget = createContext<PickTarget | undefined>(undefined);

export function PresetChip({ node, getPos, editor }: NodeViewProps) {
  const kind = node.attrs.kind as PresetKind;
  const id = String(node.attrs.id);
  const item = presets[kind]?.find((entry) => entry.id === id);
  const label = item?.name ?? String(node.attrs.label);
  const choose = useContext(PresetTarget);
  const Icon = icons[kind] ?? Box;
  return (
    <NodeViewWrapper
      as="span"
      data-preset={`${kind}/${id}`}
      data-gone={!item}
      className="prompt-ref-chip prompt-preset-chip"
      title={
        item
          ? `「${label}」${item.prompt.slice(0, 80)}${item.prompt.length > 80 ? "…" : ""}${choose ? "（点击替换）" : ""}`
          : "这个预设已不存在，发送时按普通文字处理"
      }
      onClick={(event: React.MouseEvent<HTMLElement>) => {
        const pos = getPos();
        if (!choose || pos === undefined) return;
        let index = 0;
        editor.state.doc.nodesBetween(0, pos, (child) => {
          if (child.type.name === "preset") index++;
        });
        choose(kind, index, event.currentTarget);
      }}
    >
      <span className="preset-chip-icon">
        <Icon size={12} />
      </span>
      <span>{label}</span>
    </NodeViewWrapper>
  );
}

export function applyEditorPreset(
  editor: Editor,
  touched: boolean,
  kind: PresetKind,
  id: string,
  target?: number,
) {
  if (!editor.isEditable) return false;
  const { doc, tr, schema, selection } = editor.state;
  const found: { kind: string; id: string; pos: number; size: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "preset")
      found.push({ kind: node.attrs.kind, id: node.attrs.id, pos, size: node.nodeSize });
  });
  const same = found.findIndex((item) => item.kind === kind && item.id === id);
  if (target !== undefined && (!found[target] || (same >= 0 && same !== target))) return false;
  const existing =
    found[
      target ??
        (same >= 0 ? same : kind === "motion" ? -1 : found.findIndex((item) => item.kind === kind))
    ];
  const item = presets[kind].find((entry) => entry.id === id);
  if (!item || !schema.nodes.preset) return false;
  const chip = schema.nodes.preset.create({ kind, id, label: item.name });
  if (existing) {
    const end = existing.pos + existing.size;
    if (existing.id === id) {
      const spaced = doc.textBetween(end, Math.min(doc.content.size, end + 1)) === " ";
      tr.delete(existing.pos, end + Number(spaced));
    } else tr.replaceWith(existing.pos, end, chip);
  } else
    tr.insert(kind === "tpl" ? 1 : touched ? selection.to : doc.content.size - 1, [
      chip,
      schema.text(" "),
    ]);
  editor.view.dispatch(tr);
  return true;
}
