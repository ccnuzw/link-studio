import { X } from "lucide-react";

export function AssistantContextChips<Id extends string>({
  refs,
  remove,
  label = "页面上下文",
}: {
  refs: { id: Id; label: string; title?: string }[];
  remove?: (id: Id) => void;
  label?: string;
}) {
  if (!refs.length) return null;
  return (
    <fieldset
      data-ui-group
      aria-label={label}
      className="settings-context-chips"
      data-editable={!!remove}
    >
      {refs.map((ref) => (
        <span key={ref.id} title={ref.title}>
          <span>{ref.label}</span>
          {remove && (
            <button type="button" aria-label={`移除 ${ref.label}`} onClick={() => remove(ref.id)}>
              <X size={12} aria-hidden />
            </button>
          )}
        </span>
      ))}
    </fieldset>
  );
}
