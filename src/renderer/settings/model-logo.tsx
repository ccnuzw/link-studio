import { Check, ChevronDown } from "lucide-react";
import { useId, useRef, useState } from "react";
import { vendors } from "./model-logos/vendors";

const assets = import.meta.glob<string>("./model-logos/*.svg", {
  eager: true,
  import: "default",
  query: "?url",
});
const aliases: Record<string, keyof typeof vendors> = {
  anthropic: "claude",
  google: "gemini",
  xai: "grok",
};

function vendorKey(logo?: string): keyof typeof vendors | undefined {
  const key = logo?.trim().toLowerCase();
  if (!key) return undefined;
  if (Object.hasOwn(vendors, key)) return key as keyof typeof vendors;
  return Object.hasOwn(aliases, key) ? aliases[key] : undefined;
}

export function ModelAvatar({ name, logo }: { name: string; logo?: string }) {
  const vendor = vendorKey(logo);
  const image = vendor && assets[`./model-logos/${vendor}.svg`];
  return (
    <span className="model-avatar" data-vendor={image ? vendor : undefined} aria-hidden="true">
      {image ? <img src={image} alt="" /> : (Array.from(name.trim())[0]?.toUpperCase() ?? "模")}
    </span>
  );
}

export function ModelLogoPicker({
  name,
  value,
  change,
}: {
  name: string;
  value?: string;
  change: (logo?: string) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLFieldSetElement>(null);
  const [query, setQuery] = useState("");
  const current = vendorKey(value);
  const keyword = query.trim().toLowerCase();
  const results = Object.entries(vendors).filter(([key, label]) =>
    [
      key,
      label.toLowerCase(),
      ...Object.keys(aliases).filter((alias) => aliases[alias] === key),
    ].some((term) => term.includes(keyword)),
  );
  const pick = (key?: string) => {
    change(key);
    panel.current?.hidePopover();
    trigger.current?.focus();
  };
  return (
    <div className="model-logo-field">
      <label id={`${id}-label`} htmlFor={`${id}-trigger`}>
        模型 Logo
      </label>
      <button
        ref={trigger}
        id={`${id}-trigger`}
        type="button"
        className="model-logo-trigger"
        aria-labelledby={`${id}-label ${id}-value`}
        popoverTarget={id}
      >
        <ModelAvatar name={name} logo={value} />
        <span id={`${id}-value`}>{current ? vendors[current] : "不选"}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      <fieldset
        ref={panel}
        id={id}
        popover="auto"
        className="model-logo-popover"
        aria-label="选择模型 Logo"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            panel.current?.hidePopover();
            trigger.current?.focus();
          }
        }}
        onToggle={(event) => {
          setQuery("");
          if (event.newState === "open") event.currentTarget.querySelector("input")?.focus();
        }}
      >
        <input
          type="search"
          aria-label="搜索厂商"
          placeholder="搜索厂商"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="model-logo-options">
          {!keyword && (
            <button
              type="button"
              className="model-logo-clear"
              aria-pressed={!current}
              onClick={() => pick()}
            >
              <ModelAvatar name={name} /> 不选
              {!current && <Check size={15} aria-hidden="true" />}
            </button>
          )}
          <div className="model-logo-grid">
            {results.map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={key === current}
                title={label}
                onClick={() => pick(key)}
              >
                <ModelAvatar name={label} logo={key} />
                <span>{label}</span>
              </button>
            ))}
          </div>
          {!results.length && <p role="status">没有匹配的厂商</p>}
        </div>
      </fieldset>
    </div>
  );
}
