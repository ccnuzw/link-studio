import type { ModelConfig } from "@link-studio/core";
import { Star, X } from "lucide-react";
import { useState } from "react";

type Field = Extract<NonNullable<ModelConfig["customParams"]>[string], { type: "enum" }>;

export function CustomEnumEditor({
  field,
  change,
  presets = [],
}: {
  field: Field;
  change: (field: Field) => void;
  presets?: string[];
}) {
  const [draft, setDraft] = useState("");
  const setValues = (values: Field["values"]) => {
    change({
      ...field,
      values,
      default: values.includes(field.default) ? field.default : (values[0] ?? ""),
    });
  };
  const commit = () => {
    const text = draft.trim();
    setDraft("");
    if (!text || field.values.length >= 20) return;
    const numeric = Number(text);
    const value = /^-?\d+(\.\d+)?$/.test(text) && Number.isFinite(numeric) ? numeric : text;
    if (!field.values.some((item) => String(item) === String(value)))
      setValues([...field.values, value]);
  };
  return (
    <div className="model-enum-editor">
      <div className="model-chips">
        {field.values.map((option) => {
          const selected = option === field.default;
          return (
            <span key={String(option)} data-default={selected}>
              <button
                type="button"
                aria-pressed={selected}
                aria-label={selected ? `${option} 是默认值` : `设 ${option} 为默认值`}
                onClick={() => change({ ...field, default: option })}
              >
                <Star size={14} fill={selected ? "currentColor" : "none"} />
              </button>
              {String(option)}
              <button
                type="button"
                aria-label={`删除可选值 ${option}`}
                onClick={() => setValues(field.values.filter((item) => item !== option))}
              >
                <X size={14} />
              </button>
            </span>
          );
        })}
      </div>
      <div className="model-enum-inputs">
        <input
          aria-label="添加可选值"
          placeholder="输入可选值，回车添加"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            commit();
          }}
        />
        {presets
          .filter((option) => !field.values.some((value) => String(value) === option))
          .map((option) => (
            <button
              type="button"
              key={option}
              disabled={field.values.length >= 20}
              onClick={() => setValues([...field.values, option])}
            >
              + {option}
            </button>
          ))}
      </div>
    </div>
  );
}
