import { ChevronLeft, ChevronRight, Download, ImageOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DocumentCard } from "./assistant-documents";
import "./assistant-gallery.css";

type Attachment = {
  id: string;
  name: string;
  document: boolean;
  localDocument: boolean;
  bytes: number;
};
type ImageEntry = Attachment & { url: string };

function ImageGallery({
  entries,
  active,
  select,
  close,
  projectHandle,
}: {
  entries: ImageEntry[];
  active: ImageEntry;
  select: (id: string) => void;
  close: () => void;
  projectHandle: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState({ id: "", width: 0, height: 0 });
  const index = entries.findIndex((entry) => entry.id === active.id);
  const many = entries.length > 1;
  const [saveNotice, setSaveNotice] = useState("");
  const step = (offset: number) => {
    const next = entries[index + offset];
    if (next) select(next.id);
  };
  useEffect(() => dialog.current?.showModal(), []);
  useEffect(() => {
    const current = strip.current?.querySelector(`[aria-current="true"]`);
    if (current?.getAttribute("data-id") === active.id)
      current.scrollIntoView({ inline: "center", block: "nearest" });
  }, [active.id]);
  const download = async () => {
    const result = await window.desktop.projects.saveAssetCopy({
      projectHandle,
      assetId: active.id,
    });
    setSaveNotice(
      result.ok ? (result.value.saved ? "已保存原文件" : "已取消保存") : "无法保存原文件",
    );
  };
  return (
    <dialog
      ref={dialog}
      aria-label="媒体预览"
      className="assistant-gallery"
      onClose={close}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          event.stopPropagation();
          step(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <button
        type="button"
        className="gallery-scrim"
        aria-label="关闭预览背景"
        tabIndex={-1}
        onClick={close}
      />
      <div className="gallery-stage">
        <img
          key={active.id}
          alt={active.name}
          src={active.url}
          draggable={false}
          style={{
            aspectRatio: natural.id === active.id ? natural.width / natural.height : undefined,
            width:
              natural.id === active.id
                ? `min(100%, calc((100dvh - 222px) * ${natural.width / natural.height}))`
                : undefined,
          }}
          onLoad={({ currentTarget }) =>
            setNatural({
              id: active.id,
              width: currentTarget.naturalWidth,
              height: currentTarget.naturalHeight,
            })
          }
        />
      </div>
      <header>
        {saveNotice && <span role="status">{saveNotice}</span>}
        <span aria-live="polite">
          {natural.id === active.id ? `${natural.width}×${natural.height}` : "加载原图…"}
        </span>
        <button type="button" aria-label="下载原文件" onClick={() => void download()}>
          <Download size={18} />
        </button>
        <button type="button" aria-label="关闭" onClick={close}>
          <X size={18} />
        </button>
      </header>
      {many && (
        <>
          <button
            type="button"
            className="gallery-prev"
            aria-label="上一个"
            disabled={index === 0}
            onClick={() => step(-1)}
          >
            <ChevronLeft size={20} />
          </button>
          <button
            type="button"
            className="gallery-next"
            aria-label="下一个"
            disabled={index === entries.length - 1}
            onClick={() => step(1)}
          >
            <ChevronRight size={20} />
          </button>
          <footer>
            <div>
              <span>
                本条消息 {index + 1} / {entries.length}
              </span>{" "}
              <span className="gallery-hint">←　→　切换</span>
            </div>
            <div ref={strip} className="gallery-strip">
              {entries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  data-id={entry.id}
                  aria-current={entry.id === active.id}
                  aria-label={entry.name}
                  onClick={() => select(entry.id)}
                >
                  <img src={entry.url} alt="" draggable={false} />
                </button>
              ))}
            </div>
          </footer>
        </>
      )}
    </dialog>
  );
}

export function MessageAttachments({
  items,
  projectHandle,
  openDocument,
}: {
  items: Record<string, unknown>[];
  projectHandle: string;
  openDocument: (id: string) => void;
}) {
  const attachments: Attachment[] = items.map((item) => ({
    id: String(item.asset_id),
    name: String(item.name),
    document: item.kind === "document",
    localDocument: String(item.url).startsWith("document:"),
    bytes: Number(item.byte_size) || 0,
  }));
  const imageIds = JSON.stringify(
    attachments.filter((item) => !item.document).map((item) => item.id),
  );
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [activeId, setActiveId] = useState("");
  useEffect(() => {
    let current = true;
    const ids: string[] = JSON.parse(imageIds);
    for (const assetId of ids) {
      void window.desktop.projects.getAssetPreview({ projectHandle, assetId }).then(
        (result) => {
          if (current)
            setUrls((previous) => ({ ...previous, [assetId]: result.ok ? result.value.url : "" }));
        },
        () => {
          if (current) setUrls((previous) => ({ ...previous, [assetId]: "" }));
        },
      );
    }
    return () => {
      current = false;
    };
  }, [projectHandle, imageIds]);
  const previews = attachments.flatMap((item) => {
    const url = urls[item.id];
    return url && !item.document ? [{ ...item, url }] : [];
  });
  const active = previews.find((entry) => entry.id === activeId);
  return (
    <div className="assistant-message-attachments">
      {attachments.map((item) => {
        if (item.document)
          return item.localDocument ? (
            <button
              className="assistant-history-document"
              key={item.id}
              type="button"
              aria-label={`打开文件：${item.name}`}
              onClick={() => openDocument(item.id)}
            >
              <DocumentCard name={item.name} size={item.bytes} />
            </button>
          ) : (
            <small key={item.id}>资料 {item.name}</small>
          );
        const url = urls[item.id];
        if (url === "")
          return (
            <span key={item.id} className="attachment-dead" title={item.name}>
              <ImageOff size={14} />
              图片已失效
            </span>
          );
        return (
          <button
            key={item.id}
            type="button"
            className="attachment-thumb"
            title={item.name}
            aria-label={`查看大图：${item.name}`}
            disabled={!url}
            onClick={() => setActiveId(item.id)}
          >
            {url && (
              <img
                src={url}
                alt={item.name}
                draggable={false}
                onError={() => setUrls((previous) => ({ ...previous, [item.id]: "" }))}
              />
            )}
          </button>
        );
      })}
      {active && (
        <ImageGallery
          projectHandle={projectHandle}
          entries={previews}
          active={active}
          select={setActiveId}
          close={() => setActiveId("")}
        />
      )}
    </div>
  );
}
