import type { JSONContent } from "@tiptap/core";

export const BOARD_PLACEHOLDERS = ["格数", "列数", "行数", "比例", "画面"] as const;

export type BoardPlaceholder = (typeof BOARD_PLACEHOLDERS)[number];

export const formatPlaceholder = (name: string) => `{{${name}}}`;

export const BOARD_SHOTS_PLACEHOLDER = formatPlaceholder("画面");

const PLACEHOLDER_RE = /\{\{([^{}\n]*)\}\}/g;

const KNOWN = new Set<string>(BOARD_PLACEHOLDERS);

export const PLACEHOLDER_NODE = "placeholder";

function lineContent(line: string): JSONContent[] {
  const out: JSONContent[] = [];
  let last = 0;
  const pushText = (text: string) => {
    if (!text) return;
    const prev = out[out.length - 1];
    if (prev?.type === "text") prev.text += text;
    else out.push({ type: "text", text });
  };
  for (const match of line.matchAll(PLACEHOLDER_RE)) {
    if (!match[1] || !KNOWN.has(match[1])) continue;
    pushText(line.slice(last, match.index));
    out.push({ type: PLACEHOLDER_NODE, attrs: { name: match[1] } });
    last = match.index + match[0].length;
  }
  pushText(line.slice(last));
  return out;
}

export function textToDoc(text: string): JSONContent {
  return {
    type: "doc",
    content: text.split("\n").map((line) => {
      const content = lineContent(line);
      return content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };
    }),
  };
}

export function docToText(doc: JSONContent): string {
  const inline = (node: JSONContent): string => {
    if (node.type === "text") return node.text ?? "";
    if (node.type === "hardBreak") return "\n";
    if (node.type === PLACEHOLDER_NODE) return formatPlaceholder(String(node.attrs?.name ?? ""));
    return (node.content ?? []).map(inline).join("");
  };
  return (doc.content ?? []).map(inline).join("\n");
}
