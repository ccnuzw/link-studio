import type { DramaDocument, ProjectCanvasView } from "@link-studio/core";
import { Grid2x2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CanvasPromptEditor } from "./canvas-prompt-editor";
import { Autosaver, type AutosaveStatus } from "./drama-autosave";
import { useDramaFlush, useDramaSaveStatus } from "./drama-save-status";
import { studioAssetDragType, studioAssets } from "./drama-studio-assets";

type Segment = NonNullable<DramaDocument["segments"]>[number];

export function useSegmentPrompt(
  projectHandle: string,
  segment: Segment,
  episodeOrder: number,
  reload: () => Promise<void>,
  format?: "generic" | "h3",
) {
  const persisted = format ? (segment.adaptations?.[format]?.prompt ?? "") : segment.prompt;
  const [value, setValue] = useState(persisted);
  const [status, setStatus] = useState<AutosaveStatus>("saved");
  useDramaSaveStatus(status);
  const draft = useRef(value);
  const [saver] = useState(() => {
    const instance = new Autosaver({
      revision: segment.revision,
      isConflict: (error) => error === "AGENT_APPROVAL_STALE",
      onStatus: setStatus,
      save: async (prompt, revision) => {
        const result = await window.desktop.projects.drama({
          projectHandle,
          setSegmentPrompt: {
            segmentId: segment.id,
            episodeNo: segment.episode_no,
            episodeOrder,
            revision,
            prompt,
            ...(format && { format }),
          },
        });
        if (!result.ok) throw result.error.code;
        const saved = result.value?.segments?.find((item) => item.id === segment.id);
        if (!saved) throw Error("片段不存在");
        return saved.revision;
      },
      onSaved: () => void reload(),
    });
    instance.reset(persisted, segment.revision);
    return instance;
  });
  useEffect(() => {
    saver.advanceIfUnchanged(persisted, segment.revision);
    if (saver.getStatus() !== "saved" || segment.revision < saver.getRevision()) return;
    saver.reset(persisted, segment.revision);
    draft.current = persisted;
    setValue(persisted);
  }, [persisted, segment.revision, saver]);
  useEffect(() => {
    const save = () => void saver.flush();
    const hidden = () => {
      if (document.hidden) save();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("beforeunload", save);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("beforeunload", save);
      void saver.flush().finally(() => saver.dispose());
    };
  }, [saver]);
  useDramaFlush(async () => {
    await saver.flush();
    if (saver.getStatus() !== "saved") throw Error("分镜提示词尚未保存");
  });
  return {
    value,
    status,
    revision: () => saver.getRevision(),
    change: (next: string) => {
      draft.current = next;
      setValue(next);
      saver.update(next);
    },
    flush: async () => {
      await saver.flush();
      if (saver.getStatus() !== "saved") throw Error("原稿尚未保存");
      return draft.current;
    },
    restore: async () => {
      const result = await window.desktop.projects.drama({ projectHandle });
      const latest = result.ok && result.value?.segments?.find((item) => item.id === segment.id);
      if (!latest) throw Error("读取片段原稿失败");
      const text = format ? (latest.adaptations?.[format]?.prompt ?? "") : latest.prompt;
      saver.reset(text, latest.revision);
      draft.current = text;
      setValue(text);
      await reload();
    },
  };
}

export function SegmentPromptEditor({
  boardLine,
  graph,
  episodeNo,
  projectHandle,
  prompt,
  generate,
  report,
  adapted = false,
  disabled = false,
}: {
  boardLine?: string;
  graph?: ProjectCanvasView;
  episodeNo: number;
  projectHandle: string;
  prompt: ReturnType<typeof useSegmentPrompt>;
  generate: () => void;
  report: (message: string) => void;
  adapted?: boolean;
  disabled?: boolean;
}) {
  const sources = useMemo(() => {
    const entries = studioAssets(graph, episodeNo)
      .map(({ source, here }) => ({ source, linked: here }))
      .sort((a, b) => Number(b.linked) - Number(a.linked));
    const byId = new Map(entries.map(({ source }) => [source.id, source]));
    return { byId, linked: new Set(byId.keys()), entries };
  }, [episodeNo, graph]);
  const [over, setOver] = useState(false);
  const [expandedLine, setExpandedLine] = useState(false);
  return (
    <>
      <form
        className="drama-segment-prompt"
        data-over={over || undefined}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(studioAssetDragType)) {
            event.preventDefault();
            setOver(true);
          }
        }}
        onDropCapture={() => setOver(false)}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
        }}
        onSubmit={(event) => {
          event.preventDefault();
          generate();
        }}
      >
        {boardLine && (
          <button
            className="studio-board-line"
            type="button"
            aria-label="故事板说明"
            aria-expanded={expandedLine}
            title={expandedLine ? undefined : boardLine}
            onClick={() => setExpandedLine(!expandedLine)}
          >
            <Grid2x2 size={12} aria-hidden />
            <span>{boardLine}</span>
          </button>
        )}
        <CanvasPromptEditor
          studio
          editorLabel={adapted ? "片段转写稿" : "片段原稿"}
          acceptDrop={(data) => {
            const raw = data.getData(studioAssetDragType);
            if (!raw) return null;
            try {
              const hit = JSON.parse(raw);
              return sources.byId.get(hit?.id) ?? null;
            } catch {
              return null;
            }
          }}
          expanded
          disabled={disabled}
          value={prompt.value}
          change={prompt.change}
          link={() => {}}
          sources={sources}
          projectHandle={projectHandle}
          placeholder="描述这个片段的画面，输入 @ 引用角色、场景、道具，或从左侧拖入"
        />
      </form>
      {prompt.status === "conflict" && (
        <div role="alert">
          原稿版本已变化。
          <button
            type="button"
            onClick={() => void prompt.restore().catch(() => report("读取片段原稿失败"))}
          >
            载入最新原稿
          </button>
        </div>
      )}
      {prompt.status === "error" && (
        <div role="alert">
          原稿保存失败。
          <button
            type="button"
            onClick={() => void prompt.flush().catch(() => report("原稿保存失败"))}
          >
            重试保存
          </button>
        </div>
      )}
    </>
  );
}
