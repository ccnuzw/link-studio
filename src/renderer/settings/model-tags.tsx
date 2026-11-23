import { X } from "lucide-react";
import { useState } from "react";

export function ModelTags({
  tags = [],
  change,
}: {
  tags?: string[];
  change: (tags?: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const text = draft.trim();
    setDraft("");
    if (text && text.length <= 12 && tags.length < 5 && !tags.includes(text))
      change([...tags, text]);
  };
  const remove = (text: string) => {
    const next = tags.filter((tag) => tag !== text);
    change(next.length ? next : undefined);
  };
  return (
    <div className="model-tag-editor">
      <label htmlFor="model-tag-input">展示标签</label>
      {tags.length > 0 && (
        <div className="model-tag-list">
          {tags.map((tag) => (
            <span key={tag}>
              {tag}
              <button type="button" aria-label={`删除标签 ${tag}`} onClick={() => remove(tag)}>
                <X aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div>
        <input
          id="model-tag-input"
          value={draft}
          maxLength={12}
          disabled={tags.length >= 5}
          placeholder={tags.length >= 5 ? "最多 5 个标签" : "输入后回车添加"}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (["Enter", ",", "，"].includes(event.key)) {
              event.preventDefault();
              commit();
            } else if (event.key === "Backspace" && !draft) {
              const last = tags.at(-1);
              if (last) remove(last);
            }
          }}
        />
        <small>{tags.length}/5</small>
      </div>
    </div>
  );
}
