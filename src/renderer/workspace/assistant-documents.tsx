import {
  type CanvasAgentValues,
  maxAgentDocumentBytes,
  maxAgentDocuments,
} from "@link-studio/core";
import { RotateCw, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

type DraftDocument = {
  key: string;
  session: string;
  file: File;
  documentId?: string;
  failed?: boolean;
};

export function useAssistantDocuments(
  projectHandle: string,
  session: string,
  notify: (message: string) => void,
) {
  const [all, setAll] = useState<DraftDocument[]>([]);
  const latest = useRef(all);
  const commit = (items: DraftDocument[]) => {
    latest.current = items;
    setAll(items);
  };
  const upload = async (item: DraftDocument) => {
    let documentId: string | undefined;
    try {
      const result = await window.desktop.projects.canvasAgent({
        projectHandle,
        action: {
          method: "attachDocument",
          name: item.file.name,
          bytes: new Uint8Array(await item.file.arrayBuffer()),
        },
      });
      if (result.ok && "documentId" in result.value) documentId = result.value.documentId;
    } catch {}
    if (latest.current.some((entry) => entry.key === item.key))
      commit(
        latest.current.map((entry) =>
          entry.key === item.key ? { ...entry, documentId, failed: !documentId } : entry,
        ),
      );
  };
  useEffect(
    () => () => {
      latest.current = [];
    },
    [],
  );
  return {
    items: all.filter((item) => item.session === session),
    add(files: FileList) {
      const next: DraftDocument[] = [];
      const messages = new Set<string>();
      const room =
        maxAgentDocuments - latest.current.filter((entry) => entry.session === session).length;
      for (const file of Array.from(files)) {
        if (!/\.(txt|md|markdown)$/i.test(file.name)) messages.add("只支持 .txt 和 .md");
        else if (file.size > maxAgentDocumentBytes)
          messages.add("文件太大了，请控制在 20 万字节以内");
        else if (!file.size) messages.add("这个文件是空的");
        else if (next.length >= room) messages.add("一条消息最多 3 个文档");
        else next.push({ session, file, key: crypto.randomUUID() });
      }
      notify([...messages].join("。"));
      commit([...latest.current, ...next]);
      for (const item of next) void upload(item);
    },
    retry(item: DraftDocument) {
      commit(
        latest.current.map((entry) =>
          entry.key === item.key ? { ...entry, failed: false } : entry,
        ),
      );
      void upload(item);
    },
    remove(key: string) {
      commit(latest.current.filter((entry) => entry.key !== key));
    },
    clear(target: string) {
      commit(latest.current.filter((entry) => entry.session !== target));
    },
  };
}

export function DocumentCard({
  name,
  size,
  children,
}: {
  name: string;
  size: number;
  children?: ReactNode;
}) {
  const kind = /\.(md|markdown)$/i.test(name) ? "MD" : "TXT";
  return (
    <span className="assistant-document-card" title={name}>
      <b aria-hidden="true">{kind}</b>
      <span>
        <strong>{name}</strong>
        <small>
          {kind} · {size < 1024 ? `${size}B` : `${(size / 1024).toFixed(2)}KB`}
        </small>
      </span>
      {children}
    </span>
  );
}

export function DocumentTray({
  documents,
}: {
  documents: ReturnType<typeof useAssistantDocuments>;
}) {
  if (!documents.items.length) return null;
  return (
    <section className="assistant-document-strip" aria-label="文档附件">
      {documents.items.map((item) => (
        <DocumentCard key={item.key} name={item.file.name} size={item.file.size}>
          <button
            className="document-remove"
            type="button"
            aria-label={`移除 ${item.file.name}`}
            onClick={() => documents.remove(item.key)}
          >
            <X size={14} />
          </button>
          {item.failed ? (
            <button
              className="document-retry"
              type="button"
              aria-label={`重试上传 ${item.file.name}`}
              onClick={() => documents.retry(item)}
            >
              <RotateCw size={14} />
            </button>
          ) : (
            !item.documentId && <progress aria-label="正在导入文档" />
          )}
        </DocumentCard>
      ))}
    </section>
  );
}

export function DocumentPreview({
  document,
  close,
}: {
  document: CanvasAgentValues["readDocument"];
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  return (
    <dialog
      ref={ref}
      className="assistant-document-preview"
      aria-label={document.name}
      onClose={close}
    >
      <header>
        <strong>{document.name}</strong>
        <button type="button" onClick={() => ref.current?.close()}>
          关闭
        </button>
      </header>
      <pre>{document.text}</pre>
    </dialog>
  );
}
