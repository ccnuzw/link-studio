import { Popover } from "@base-ui/react/popover";
import { PenLine, Search } from "lucide-react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { AssistantEditorHandle } from "./assistant-editor";
import { AssistantInsertPopup } from "./assistant-insert-popup";

type CanvasSkill = { id: string; title: string; summary: string };

export function useCanvasSkills(visible: boolean) {
  const [skills, setSkills] = useState<CanvasSkill[]>([]);
  const [status, setStatus] = useState<"ready" | "loading" | "error">("loading");
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const request = ++latest.current;
    setStatus((current) => (current === "ready" ? current : "loading"));
    try {
      const result = await window.desktop.skills.list({});
      if (latest.current !== request) return;
      if (!result.ok) throw new Error(result.message);
      setSkills(
        result.value
          .filter(
            (skill) => skill.enabled && skill.activeVersion > 0 && skill.scopes.includes("agent"),
          )
          .map((skill) => ({
            id: `${skill.name}@${skill.activeVersion}`,
            title: skill.title,
            summary:
              skill.versions.find((item) => item.version === skill.activeVersion)?.description ??
              "",
          })),
      );
      setStatus("ready");
    } catch {
      if (latest.current === request) {
        setStatus((current) => (current === "ready" ? current : "error"));
      }
    }
  }, []);
  useEffect(() => {
    if (visible) void reload();
    return () => {
      latest.current++;
    };
  }, [visible, reload]);
  return { skills, status, reload };
}

export function AssistantSkillMenu({
  catalog,
  disabled,
  editor,
  pick,
}: {
  catalog: ReturnType<typeof useCanvasSkills>;
  disabled: boolean;
  editor: RefObject<AssistantEditorHandle | HTMLTextAreaElement | null>;
  pick: (skill: CanvasSkill) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const picked = useRef(false);
  const filtered = catalog.skills.filter((skill) =>
    `${skill.title} ${skill.id} ${skill.summary}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <Popover.Root
      open={open && !disabled}
      onOpenChange={(next) => {
        if (next) {
          picked.current = false;
          void catalog.reload();
        }
        setOpen(next);
      }}
    >
      <Popover.Trigger
        type="button"
        className="composer-tool"
        disabled={disabled}
        aria-label="插入技能"
        title="插入技能"
      >
        <PenLine size={17} aria-hidden="true" />
      </Popover.Trigger>
      <AssistantInsertPopup
        className="assistant-skill-menu"
        aria-label="插入技能"
        finalFocus={() => {
          const target = editor.current;
          return picked.current && target
            ? "element" in target
              ? (target.element() ?? true)
              : target
            : true;
        }}
      >
        <div role="tablist" aria-label="技能分类">
          {["全部", "收藏", "我的"].map((tab, index) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={index === 0}
              aria-disabled={index !== 0}
              title={index ? "二期开放" : tab}
            >
              {tab}
            </button>
          ))}
        </div>
        <label className="assistant-skill-search">
          <Search size={14} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="搜索技能"
            placeholder="搜索技能"
          />
        </label>
        {catalog.status === "loading" ? (
          <div
            role="status"
            className="assistant-skill-skeleton"
            aria-busy="true"
            aria-label="正在加载技能"
          >
            <i />
            <i />
            <i />
            <i />
          </div>
        ) : catalog.status === "error" ? (
          <p role="status">
            技能加载失败，
            <button type="button" onClick={catalog.reload}>
              重试
            </button>
          </p>
        ) : !filtered.length ? (
          <p role="status">{catalog.skills.length ? "没有找到匹配的技能" : "还没有启用的技能"}</p>
        ) : (
          <ul>
            {filtered.map((skill) => (
              <li key={skill.id}>
                <button
                  type="button"
                  onClick={() => {
                    pick(skill);
                    picked.current = true;
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  <strong>{skill.title}</strong>
                  <small>{skill.summary}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </AssistantInsertPopup>
    </Popover.Root>
  );
}
