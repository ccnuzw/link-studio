import type { DramaDocument } from "@link-studio/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import { Autosaver, type AutosaveStatus } from "./drama-autosave";
import { useDramaSaveStatus } from "./drama-save-status";
import { markdownExtensions, TextFormatBar } from "./text-editor-dialog";

export function EpisodePaper({
  projectHandle,
  episode,
  documentField,
  episodeOrder,
  registerFlush,
  saved,
  refresh,
  notify,
}: {
  projectHandle: string;
  episode?: DramaDocument["episodes"][number];
  documentField?: {
    field: "outline_md" | "characters_md";
    value: string;
    revision: number;
    label: string;
  };
  episodeOrder: number;
  registerFlush: React.RefObject<(() => Promise<void>) | null>;
  saved: (doc: DramaDocument) => void;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const no = episode?.episode_no;
  const value = documentField?.value ?? episode?.script_md ?? "";
  const revision = documentField?.revision ?? episode?.revision ?? 1;
  const locked = episode?.locked ?? false;
  const [status, setStatus] = useState<AutosaveStatus>("saved");
  useDramaSaveStatus(status);
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
          ...(documentField
            ? {
                editField: {
                  field: documentField.field,
                  previous: lastSaved.current,
                  value: markdown,
                },
              }
            : {
                saveScript: {
                  episode_no: no!,
                  revision: expected,
                  episodeOrder,
                  script_md: markdown,
                },
              }),
        });
        if (!result.ok || !result.value) {
          const code = result.ok ? "短剧不存在" : result.error.code;
          if (code === "AGENT_APPROVAL_STALE") {
            callbacks.current.notify(
              `${documentField?.label ?? `第 ${no} 集`}在别处被修改过，请复制草稿并重新载入。`,
            );
            void callbacks.current.refresh();
          }
          throw code;
        }
        lastSaved.current = markdown;
        callbacks.current.saved(result.value);
        return documentField
          ? result.value.revision
          : result.value.episodes.find((item) => item.episode_no === no)!.revision!;
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
        "aria-label": documentField?.label ?? "分集剧本",
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
    saver.advanceIfUnchanged(value, revision);
    if (saver.getStatus() !== "saved") return;
    if (value !== lastSaved.current)
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
          {status === "conflict" && (
            <button
              type="button"
              onClick={async () => {
                const result = await window.desktop.projects.drama({ projectHandle });
                if (!result.ok || !result.value) return;
                const latest = result.value.episodes.find((item) => item.episode_no === no);
                const markdown = documentField
                  ? result.value[documentField.field]
                  : latest?.script_md;
                if (markdown === undefined) return;
                editor?.commands.setContent(markdown, {
                  contentType: "markdown",
                  emitUpdate: false,
                });
                lastSaved.current = markdown;
                saver.reset(
                  markdown,
                  documentField ? result.value.revision : (latest!.revision ?? 1),
                );
                saved(result.value);
              }}
            >
              放弃草稿并载入最新版
            </button>
          )}
        </small>
      )}
    </div>
  );
}
