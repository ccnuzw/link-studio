import type { DramaDocument } from "@link-studio/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import { Autosaver, type AutosaveStatus } from "./drama-autosave";
import { markdownExtensions, TextFormatBar } from "./text-editor-dialog";

export function EpisodePaper({
  projectHandle,
  episode,
  episodeOrder,
  registerFlush,
  saved,
  refresh,
  notify,
}: {
  projectHandle: string;
  episode: DramaDocument["episodes"][number];
  episodeOrder: number;
  registerFlush: React.RefObject<(() => Promise<void>) | null>;
  saved: (doc: DramaDocument) => void;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const { episode_no: no, script_md: value, revision = 1, locked = false } = episode;
  const [status, setStatus] = useState<AutosaveStatus>("saved");
  const lastSaved = useRef(value),
    callbacks = useRef({ saved, refresh, notify });
  callbacks.current = { saved, refresh, notify };
  const [saver] = useState(() => {
    const instance = new Autosaver({
      revision,
      onStatus: setStatus,
      isConflict: (error) => error === "AGENT_APPROVAL_STALE",
      save: async (markdown, expected) => {
        const result = await window.desktop.projects.drama({
          projectHandle,
          saveScript: { episode_no: no, revision: expected, episodeOrder, script_md: markdown },
        });
        if (!result.ok || !result.value) {
          const code = result.ok ? "短剧不存在" : result.error.code;
          if (code === "AGENT_APPROVAL_STALE") {
            callbacks.current.notify(`第 ${no} 集在别处被修改过，已加载最新内容，你的改动没有保存`);
            void callbacks.current.refresh();
          }
          throw code;
        }
        lastSaved.current = markdown;
        callbacks.current.saved(result.value);
        return result.value.episodes.find((item) => item.episode_no === no)!.revision!;
      },
    });
    instance.reset(value, revision);
    return instance;
  });
  const editor = useEditor({
    extensions: markdownExtensions,
    content: value,
    contentType: "markdown",
    editable: !locked,
    autofocus: false,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "分集剧本",
        "aria-multiline": "true",
        class: "drama-paper-prose",
      },
    },
    onUpdate: ({ editor: current }) => saver.update(current.getMarkdown()),
  });
  useEffect(() => {
    editor?.setEditable(!locked, false);
  }, [editor, locked]);
  useEffect(() => {
    if (!editor || saver.getRevision() > revision) return;
    if (
      !["saved", "conflict"].includes(saver.getStatus()) ||
      (saver.getStatus() === "conflict" && revision === saver.getRevision())
    )
      return;
    if (value !== lastSaved.current || saver.getStatus() === "conflict")
      editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
    lastSaved.current = value;
    saver.reset(value, revision);
  }, [editor, value, revision, saver, status]);
  useEffect(() => {
    registerFlush.current = async () => {
      await saver.flush();
      if (saver.getStatus() !== "saved") throw Error("当前剧本尚未保存，请先处理保存提示");
    };
    return () => {
      registerFlush.current = null;
    };
  }, [registerFlush, saver]);
  useEffect(() => {
    const flush = () => {
        void saver.flush();
      },
      hide = () => {
        if (document.hidden) flush();
      };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", hide);
      void saver.flush().finally(() => saver.dispose());
    };
  }, [saver]);
  return (
    <div className="drama-episode-paper">
      {locked && <p>这一集已经拆解资产，剧本已锁定。资产和分镜都以这一版为准。</p>}
      {editor && !locked && <TextFormatBar editor={editor} />}
      <EditorContent editor={editor} />
      {!locked && (
        <small aria-live="polite">
          {
            {
              saved: "已保存",
              dirty: "未保存",
              saving: "保存中",
              error: "保存失败",
              conflict: "保存冲突",
            }[status]
          }
          {status === "error" && (
            <button type="button" onClick={() => void saver.flush()}>
              重试保存
            </button>
          )}
        </small>
      )}
    </div>
  );
}
