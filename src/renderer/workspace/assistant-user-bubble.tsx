import type { ReactNode } from "react";
import "./assistant-selection.css";

export function AssistantUserBubble({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(/@\[([^\]]*)\]\((node|model|skill|asset):([^)\s]+)\)/g)) {
    if (match.index > offset)
      parts.push(<span key={`text-${offset}`}>{text.slice(offset, match.index)}</span>);
    const [, name, type, id] = match;
    parts.push(
      <span
        key={`chip-${match.index}`}
        className="agent-message-ref"
        data-kind={type}
        title={`${type}:${id}`}
      >
        <span>{name}</span>
      </span>,
    );
    offset = match.index + match[0].length;
  }
  if (offset < text.length) parts.push(<span key={`text-${offset}`}>{text.slice(offset)}</span>);
  return <div className="agent-user-bubble">{parts}</div>;
}
