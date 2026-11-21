import type { ChannelView } from "@link-studio/core";
import { ArrowDown, ArrowUp, ChevronRight, GripVertical } from "lucide-react";
import { useState } from "react";

export function ChannelCards({
  channels,
  selected,
  modelCounts,
  sortable,
  select,
  reorder,
}: {
  channels: ChannelView[];
  selected?: string;
  modelCounts: Map<string, number>;
  sortable: boolean;
  select: (id: string) => void;
  reorder: (source: string, target: string, after: boolean) => void;
}) {
  const [dragging, setDragging] = useState<string>();
  const [drop, setDrop] = useState<{ id: string; after: boolean }>();
  const [ordering, setOrdering] = useState<string>();
  const clearDrag = () => {
    setDragging(undefined);
    setDrop(undefined);
  };
  return (
    <nav className="channel-cards" aria-label="选择渠道">
      {channels.map((entry, index) => {
        const earlier = channels[index - 1];
        const later = channels[index + 1];
        const sorting = sortable && ordering === entry.id;
        return (
          <fieldset
            aria-label={`渠道 ${entry.name}`}
            key={entry.id}
            className="channel-card"
            data-current={entry.id === selected}
            data-dragging={entry.id === dragging}
            data-drop={drop?.id === entry.id ? (drop.after ? "after" : "before") : undefined}
            onDragOver={(event) => {
              if (!sortable || !dragging || dragging === entry.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const rect = event.currentTarget.getBoundingClientRect();
              setDrop({ id: entry.id, after: event.clientY >= rect.top + rect.height / 2 });
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDrop((current) => (current?.id === entry.id ? undefined : current));
              }
            }}
            onDrop={(event) => {
              if (!sortable || !dragging || dragging === entry.id) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              reorder(dragging, entry.id, event.clientY >= rect.top + rect.height / 2);
              clearDrag();
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setOrdering(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && sorting) {
                event.currentTarget.querySelector<HTMLButtonElement>(".channel-grip")?.focus();
                setOrdering(undefined);
              }
            }}
          >
            {channels.length > 1 && (
              <button
                type="button"
                className="channel-grip"
                draggable={sortable}
                disabled={!sortable}
                aria-expanded={sorting}
                aria-label={`排序 ${entry.name}`}
                title={sortable ? "拖动排序，或点击调整位置" : "清除筛选后可排序"}
                onClick={() => setOrdering(sorting ? undefined : entry.id)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", entry.name);
                  const card = event.currentTarget.parentElement;
                  if (card) event.dataTransfer.setDragImage(card, 14, 22);
                  setOrdering(undefined);
                  setDragging(entry.id);
                }}
                onDragEnd={clearDrag}
              >
                <GripVertical size={16} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="channel-item"
              aria-current={entry.id === selected ? "true" : undefined}
              onClick={() => {
                select(entry.id);
                setOrdering(undefined);
              }}
            >
              <span>
                <strong title={entry.name}>{entry.name}</strong>
                <small>
                  {modelCounts.get(entry.id) ?? 0} 个模型 ·{" "}
                  <span className="channel-card-status" data-enabled={entry.enabled}>
                    {entry.enabled ? "已启用" : "已停用"}
                  </span>
                </small>
              </span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
            {sorting && (
              <fieldset className="channel-order-actions" aria-label={`调整 ${entry.name} 的位置`}>
                <button
                  type="button"
                  disabled={!earlier}
                  onClick={() => {
                    if (earlier) reorder(entry.id, earlier.id, false);
                    setOrdering(undefined);
                  }}
                >
                  <ArrowUp size={14} /> 上移
                </button>
                <button
                  type="button"
                  disabled={!later}
                  onClick={() => {
                    if (later) reorder(entry.id, later.id, true);
                    setOrdering(undefined);
                  }}
                >
                  <ArrowDown size={14} /> 下移
                </button>
              </fieldset>
            )}
          </fieldset>
        );
      })}
    </nav>
  );
}
