import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown } from "lucide-react";
import { useId, useRef, useState } from "react";
import { vendors } from "./model-logos/vendors";

const assets = import.meta.glob<string>("./model-logos/*.svg", {
  eager: true,
  import: "default",
  query: "?url",
});
function vendorKey(logo?: string): keyof typeof vendors | undefined {
  return logo && Object.hasOwn(vendors, logo) ? (logo as keyof typeof vendors) : undefined;
}

const gradients = [
  ["#ffb900", "#f54900"],
  ["#00bcff", "#155dfc"],
  ["#00d492", "#009689"],
  ["#a684ff", "#9810fa"],
  ["#ff637e", "#e60076"],
] as const;

export function ModelAvatar({ name, logo, seed }: { name: string; logo?: string; seed?: string }) {
  const vendor = vendorKey(logo);
  const image = vendor && assets[`./model-logos/${vendor}.svg`];
  const hash = Array.from(seed || name || "?").reduce(
    (sum, character) => sum + character.charCodeAt(0),
    0,
  );
  const colors = gradients[hash % gradients.length] ?? gradients[0];
  const initial =
    name
      .replace(/[（(].*$/, "")
      .trim()
      .slice(0, 1)
      .toUpperCase() || "?";
  return (
    <span
      className="model-avatar"
      data-vendor={image ? vendor : undefined}
      aria-hidden="true"
      style={
        image
          ? undefined
          : {
              background: `linear-gradient(to bottom right in oklab, ${colors.join(", ")})`,
              color: "white",
            }
      }
    >
      {image ? <img src={image} alt="" /> : initial}
    </span>
  );
}

export function ModelLogoPicker({
  name,
  seed,
  value,
  change,
}: {
  name: string;
  seed?: string;
  value?: string;
  change: (logo?: string) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = vendorKey(value);
  const keyword = query.trim().toLowerCase();
  const results = Object.entries(vendors).filter(
    ([key, label]) => key.includes(keyword) || label.toLowerCase().includes(keyword),
  );
  const toggle = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  const pick = (key?: string) => {
    change(key);
    setOpen(false);
  };
  return (
    <div className="model-logo-field">
      <label id={`${id}-label`} htmlFor={`${id}-trigger`}>
        模型 Logo
      </label>
      <Popover.Root open={open} onOpenChange={toggle}>
        <Popover.Trigger
          ref={trigger}
          id={`${id}-trigger`}
          type="button"
          className="model-logo-trigger"
          aria-labelledby={`${id}-label ${id}-value`}
        >
          <ModelAvatar name={name} logo={value} seed={seed} />
          <span id={`${id}-value`}>{current ? vendors[current] : "不选"}</span>
          <ChevronDown size={15} aria-hidden="true" />
        </Popover.Trigger>
        <Popover.Portal container={trigger.current?.closest("dialog")}>
          <Popover.Positioner
            align="start"
            sideOffset={4}
            collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
            className="model-logo-position"
          >
            <Popover.Popup
              initialFocus={search}
              finalFocus={trigger}
              className="model-logo-popover"
              aria-label="选择模型 Logo"
            >
              <input
                ref={search}
                type="text"
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
                    <ModelAvatar name={name} seed={seed} /> 不选
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
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
