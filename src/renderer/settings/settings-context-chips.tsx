import { X } from "lucide-react";
import type {
  SettingsRef,
  SettingsRefId,
} from "../../../packages/link-studio-core/src/settings-page-context";

export function SettingsContextChips({
  refs,
  remove,
}: {
  refs: SettingsRef[];
  remove?: (id: SettingsRefId) => void;
}) {
  if (!refs.length) return null;
  return (
    <fieldset
      data-ui-group
      aria-label="页面上下文"
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
