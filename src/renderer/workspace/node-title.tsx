import type { GroupHue } from "@link-studio/core";
import { useStore } from "@xyflow/react";
import {
  Clapperboard,
  GalleryHorizontalEnd,
  Image,
  LayoutGrid,
  Type,
  UserRound,
  Video,
} from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { focusOnMount } from "../focus-on-mount";
import type { LinkKind } from "./link-rules";
import { NodeAudioIcon } from "./node-audio-icon";
import { normalizeNodeLabel } from "./node-label";

export const RenameTitle = createContext<{ id?: string; start: (id: string | undefined) => void }>({
  start: () => undefined,
});

type TitleProps = {
  id: string;
  label: string;
  disabled?: boolean;
  commit: (label: string) => void;
};

export function GroupTitle({ labelColor, ...props }: TitleProps & { labelColor?: GroupHue }) {
  const rename = useContext(RenameTitle);
  const scale = useStore(
    (state) => Math.round(Math.min(4, Math.max(1, 1 / state.transform[2])) * 10) / 10,
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Double-clicking the icon or text is a pointer shortcut for the nested keyboard rename button.
    <div
      className="canvas-group-name"
      onDoubleClick={() => {
        if (!props.disabled) rename.start(props.id);
      }}
      style={{
        transform: scale === 1 ? undefined : `scale(${scale})`,
        maxWidth: `${100 / scale}%`,
        color: labelColor && `var(--group-${labelColor})`,
      }}
    >
      <LayoutGrid size={18} />
      <GroupName {...props} />
    </div>
  );
}

const titleIcons = {
  script: Type,
  image: Image,
  video: Video,
  audio: NodeAudioIcon,
  director: Clapperboard,
  storyboard: GalleryHorizontalEnd,
  character: UserRound,
};

export function CardHeading({
  kind,
  label,
  disabled,
  commit,
  status,
}: Omit<TitleProps, "id"> & { kind: LinkKind; status?: ReactNode }) {
  const Icon = titleIcons[kind];
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <header className="canvas-card-heading">
      <Icon size={16} />
      {draft !== null && !disabled ? (
        <input
          className="nodrag nopan"
          aria-label="节点名称"
          ref={focusOnMount}
          value={draft}
          maxLength={80}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.stopPropagation();
              setDraft(null);
            }
          }}
          onBlur={() => {
            const next = normalizeNodeLabel(draft, label);
            setDraft(null);
            if (next !== label) commit(next);
          }}
        />
      ) : disabled ? (
        <strong>{label}</strong>
      ) : (
        <strong>
          <button
            type="button"
            className="canvas-card-rename nopan"
            aria-label={`重命名节点：${label}`}
            title="双击重命名"
            onClick={(event) => {
              if (event.detail !== 0) return;
              event.stopPropagation();
              setDraft(label);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              setDraft(label);
            }}
          >
            {label}
          </button>
        </strong>
      )}
      {(status || ["script", "image", "audio", "video"].includes(kind)) && (
        <span className="canvas-heading-status">{status}</span>
      )}
    </header>
  );
}

function GroupName({ id, label, disabled, commit }: TitleProps) {
  const rename = useContext(RenameTitle);
  const editing = rename.id === id && !disabled;
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    if (!editing) return;
    finished.current = false;
    input.current?.focus();
    input.current?.select();
  }, [editing]);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const value = normalizeNodeLabel(input.current?.value ?? "", label);
    if (save && value && value !== label) commit(value);
    rename.start(undefined);
  };
  if (editing)
    return (
      <input
        ref={input}
        defaultValue={label}
        maxLength={40}
        aria-label="组名"
        className="canvas-title-input nodrag nopan"
        onPointerDown={(event) => event.stopPropagation()}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" || event.key === "Escape") {
            event.preventDefault();
            finish(event.key === "Enter");
          }
        }}
      />
    );
  return (
    <span>
      <button
        className="group-title-keyboard"
        type="button"
        disabled={disabled}
        aria-label={`重命名 ${label}`}
        onClick={(event) => {
          if (event.detail === 0) rename.start(id);
        }}
      >
        {label}
      </button>
    </span>
  );
}
