import type { JSONContent } from "@tiptap/core";
import type { ModelMention } from "./assistant-model-mentions";

export function draftDocument(message: string, mentions: ModelMention[]): JSONContent {
  const content: JSONContent[] = [];
  const addText = (text: string) => {
    text.split("\n").forEach((line, index) => {
      if (index) content.push({ type: "hardBreak" });
      if (line) content.push({ type: "text", text: line });
    });
  };
  let offset = 0;
  for (const mention of mentions) {
    addText(message.slice(offset, mention.start));
    content.push({
      type: "mention",
      attrs: {
        id: mention.id,
        name: mention.name,
        kind: mention.kind ?? "model",
        nodeKind: mention.nodeKind,
      },
    });
    offset = mention.end;
  }
  addText(message.slice(offset));
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

export function documentDraft(doc: JSONContent) {
  let message = "";
  const mentions: ModelMention[] = [];
  for (const [index, paragraph] of (doc.content ?? []).entries()) {
    if (index) message += "\n";
    for (const item of paragraph.content ?? []) {
      if (item.type === "mention" && item.attrs) {
        const { id, name, kind, nodeKind } = item.attrs;
        const start = message.length;
        message += `@${name}`;
        mentions.push({
          start,
          end: message.length,
          id,
          name,
          kind,
          ...(nodeKind && { nodeKind }),
        });
      } else message += item.type === "hardBreak" ? "\n" : (item.text ?? "");
    }
  }
  return { message, mentions };
}
