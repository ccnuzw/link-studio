import type { DramaDocument } from "@link-studio/core";
import { Search } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BackdropDialog } from "./backdrop-dialog";
import { canvasModifier } from "./canvas-keys";
import { DramaEmptyState } from "./drama-studio-status";
import { type Stage, stages } from "./drama-workspace-nav";

export function DramaCommandMenu({
  doc,
  go,
  settings,
  breakdown,
  rewriteScripts,
  toggleTheme,
  assistant,
}: {
  doc: DramaDocument;
  go: (stage: Stage, episode?: number) => void;
  settings: () => void;
  breakdown: () => void;
  rewriteScripts?: () => void;
  toggleTheme?: () => void;
  assistant?: { open: boolean; toggle: () => void };
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useId();
  const open = useCallback(() => {
    setQuery("");
    setIndex(0);
    dialog.current?.showModal();
    search.current?.focus();
  }, []);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k" || event.isComposing)
        return;
      if (document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      open();
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [open]);
  const options = [
    ...Object.entries(stages).map(([stage, label]) => ({
      label,
      group: "工序",
      run: () => go(stage as Stage),
    })),
    { label: "项目设置", group: "操作", run: settings },
    { label: "资产拆解", group: "操作", run: breakdown },
    ...(rewriteScripts ? [{ label: "重新生成分集剧本", group: "操作", run: rewriteScripts }] : []),
    ...(toggleTheme ? [{ label: "切换明暗主题", group: "操作", run: toggleTheme }] : []),
    ...(assistant
      ? [{ label: assistant.open ? "收起小灵" : "打开小灵", group: "操作", run: assistant.toggle }]
      : []),
    ...doc.episodes.map((ep) => ({
      label: `第 ${ep.episode_no} 集 · ${ep.title}`,
      group: "分集",
      run: () =>
        go(
          ep.storyboard_status === "ready" || ep.storyboard_status === "generating"
            ? "studio"
            : "script",
          ep.episode_no,
        ),
    })),
  ].filter((option) =>
    (option.group + option.label)
      .replace(/\s/g, "")
      .toLowerCase()
      .includes(query.replace(/\s/g, "").toLowerCase()),
  );
  const active = Math.min(index, Math.max(0, options.length - 1));
  function choose(position: number) {
    if (!options[position]) return;
    dialog.current?.close();
    options[position].run();
  }
  useEffect(() => {
    document.getElementById(`${list}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, list, query]);
  return (
    <>
      <button type="button" aria-label="命令面板" title="命令面板（⌘/Ctrl K）" onClick={open}>
        <Search size={16} />
        <kbd>{canvasModifier}K</kbd>
      </button>
      <BackdropDialog
        ref={dialog}
        className="dp-dialog dp-commands"
        aria-label="命令面板"
        dismiss={() => dialog.current?.close()}
      >
        <input
          ref={search}
          role="combobox"
          aria-label="搜索命令"
          aria-expanded
          aria-controls={list}
          aria-autocomplete="list"
          aria-activedescendant={options.length ? `${list}-${active}` : undefined}
          placeholder="跳转到工序、分集，或执行操作…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              choose(active);
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setIndex(
                Math.max(
                  0,
                  Math.min(options.length - 1, active + (event.key === "ArrowDown" ? 1 : -1)),
                ),
              );
            }
          }}
        />
        <div role="listbox" id={list} aria-label="匹配的命令">
          {options.map((option, position) => (
            <button
              key={option.group + option.label}
              id={`${list}-${position}`}
              role="option"
              aria-selected={active === position}
              tabIndex={-1}
              type="button"
              onClick={() => choose(position)}
            >
              {option.label}
              <small>{option.group}</small>
            </button>
          ))}
        </div>
        {!options.length && (
          <DramaEmptyState
            compact
            icon={<Search size={18} />}
            title="没有找到匹配的内容"
            description="尝试搜索工序、分集或项目操作。"
          />
        )}
      </BackdropDialog>
    </>
  );
}
