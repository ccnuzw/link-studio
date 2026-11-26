import { Sparkles, SquarePen } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { AssistantHeading } from "../assistant/assistant-panel";
import { AssistantFrame } from "./assistant-frame";

export function AssistantLauncher({
  children,
  iconSize = 16,
  ...button
}: Omit<ComponentProps<"button">, "type"> & { iconSize?: number }) {
  return (
    <button type="button" {...button}>
      <Sparkles size={iconSize} aria-hidden="true" />
      {children}
    </button>
  );
}

export function WorkspaceAssistantHeading({
  title,
  newConversation,
  disabled,
  children,
}: {
  title: ReactNode;
  newConversation: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <AssistantHeading title={title}>
      <button
        type="button"
        aria-label="新对话"
        title="新对话"
        disabled={disabled}
        onClick={newConversation}
      >
        <SquarePen size={16} aria-hidden="true" />
      </button>
      {children}
    </AssistantHeading>
  );
}

export function WorkspaceAssistant({
  label,
  complementary,
  onStop,
  children,
  ...frame
}: Omit<ComponentProps<typeof AssistantFrame>, "children"> & {
  label: string;
  complementary?: boolean;
  onStop?: () => void;
  children: ComponentProps<typeof AssistantFrame>["children"];
}) {
  const Panel = complementary ? "aside" : "section";
  return (
    <AssistantFrame {...frame}>
      {(controls) => (
        <Panel
          className="assistant-surface canvas-assistant"
          aria-label={label}
          hidden={!frame.visible}
          onKeyDown={(event) => {
            if (
              !onStop ||
              event.key !== "Escape" ||
              event.defaultPrevented ||
              event.nativeEvent.isComposing ||
              event.repeat ||
              !event.currentTarget.contains(event.target as Node) ||
              document.querySelector(":popover-open,dialog[open],select:open")
            )
              return;
            event.preventDefault();
            onStop();
          }}
        >
          {children(controls)}
        </Panel>
      )}
    </AssistantFrame>
  );
}

export function WorkspaceAssistantComposer({
  send,
  children,
}: {
  send: () => void;
  children: ReactNode;
}) {
  return (
    <form
      className="assistant-composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      {children}
    </form>
  );
}
