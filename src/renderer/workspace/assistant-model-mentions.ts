export type ModelMention = {
  start: number;
  end: number;
  id: string;
  name: string;
  kind?: "model" | "skill" | "node";
  nodeKind?: string;
};

export function rebaseMentions(
  mentions: ModelMention[],
  before: string,
  after: string,
  caret?: number,
) {
  if (!mentions.length || before === after) return mentions;
  let oldEnd = before.length,
    newEnd = after.length;
  if (caret !== undefined) {
    while (newEnd > caret && oldEnd > 0 && before[oldEnd - 1] === after[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
  }
  let start = 0;
  while (start < Math.min(oldEnd, newEnd, caret ?? newEnd) && before[start] === after[start])
    start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return mentions.flatMap((mention) =>
    mention.end <= start
      ? [mention]
      : mention.start >= oldEnd
        ? [
            {
              ...mention,
              start: mention.start + newEnd - oldEnd,
              end: mention.end + newEnd - oldEnd,
            },
          ]
        : [],
  );
}

export function serializeModels(message: string, mentions: ModelMention[]) {
  let result = "",
    offset = 0;
  for (const mention of mentions) {
    result +=
      message.slice(offset, mention.start) +
      `@[${mention.name.replace(/[[\]()]/g, "").trim() || "未命名"}](${mention.kind ?? "model"}:${mention.id})`;
    offset = mention.end;
  }
  return result + message.slice(offset);
}
