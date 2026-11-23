import { maxAgentImages } from "@link-studio/core";
import { RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type ImageItem = {
  id: string;
  file: File;
  session: string;
  status: "pending" | "done" | "error";
  error?: string;
};

export function useAssistantImages(
  projectHandle: string,
  session: string,
  selected: number,
  notify: (text: string) => void,
) {
  const latest = useRef<ImageItem[]>([]);
  const [all, setAll] = useState<ImageItem[]>([]);
  const queue = useRef(Promise.resolve());
  const items = all.filter((item) => item.session === session);
  const commit = (next: ImageItem[]) => {
    latest.current = next;
    setAll(next);
  };
  useEffect(
    () => () => {
      latest.current = [];
    },
    [],
  );
  const upload = (item: ImageItem) => {
    queue.current = queue.current.then(async () => {
      if (!latest.current.some(({ id }) => id === item.id)) return;
      let error: string | undefined;
      try {
        if (item.file.size > 16 * 1024 * 1024) throw new Error("图片超过 16 MiB");
        const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[
          item.file.type
        ];
        if (!extension) throw new Error("请选择 PNG、JPEG 或 WebP 图片");
        const name = item.file.name || `图片.${extension}`;
        const bytes = new Uint8Array(await item.file.arrayBuffer());
        if (!latest.current.some(({ id }) => id === item.id)) return;
        const result = await window.desktop.projects.attachImage({
          projectHandle,
          operationId: item.id,
          name: /\.(png|jpe?g|webp)$/i.test(name) ? name : `${name}.${extension}`,
          bytes,
        });
        if (!result.ok) throw new Error(result.error.message ?? "图片导入失败");
      } catch (cause) {
        error = cause instanceof Error ? cause.message : "图片导入失败";
      }
      if (latest.current.some(({ id }) => id === item.id))
        commit(
          latest.current.map((entry) =>
            entry.id === item.id ? { ...entry, error, status: error ? "error" : "done" } : entry,
          ),
        );
    });
  };
  return {
    items,
    add(files: FileList | File[]) {
      const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
      if (!images.length) return false;
      const room = Math.max(
        0,
        maxAgentImages -
          selected -
          latest.current.filter((entry) => entry.session === session).length,
      );
      const added = images
        .slice(0, room)
        .map((file): ImageItem => ({ id: crypto.randomUUID(), session, file, status: "pending" }));
      if (added.length < images.length)
        notify(`一条消息最多 ${maxAgentImages} 张，多出的 ${images.length - added.length} 张没加`);
      else if (files.length > images.length) notify("只能添加图片，其他文件已忽略");
      commit([...latest.current, ...added]);
      for (const item of added) upload(item);
      return true;
    },
    retry(item: ImageItem) {
      if (!latest.current.some((entry) => entry.id === item.id && entry.status === "error")) return;
      commit(
        latest.current.map((entry) =>
          entry.id === item.id ? { ...entry, status: "pending", error: undefined } : entry,
        ),
      );
      upload(item);
    },
    remove(id: string) {
      commit(latest.current.filter((entry) => entry.id !== id));
      void window.desktop.projects.cancelMediaTool({ projectHandle, operationId: id });
    },
    clear(target: string) {
      commit(latest.current.filter((entry) => entry.session !== target));
    },
  };
}

function Thumbnail({ file }: { file: File }) {
  const [url, setURL] = useState("");
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setURL(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url && <img src={url} alt={file.name || "图片"} draggable={false} />;
}

export function AssistantImageTray({
  images,
  vision,
}: {
  images: ReturnType<typeof useAssistantImages>;
  vision: boolean;
}) {
  if (!images.items.length) return null;
  return (
    <section className="assistant-image-tray" aria-label="图片附件">
      <div className="assistant-image-strip">
        {images.items.map((item) => (
          <div
            className="assistant-image-tile"
            key={item.id}
            title={item.error ?? item.file.name}
            data-status={item.status}
            data-vision={vision}
          >
            <Thumbnail file={item.file} />
            {item.status === "pending" && <progress aria-label="正在导入图片" />}
            {item.status === "error" && (
              <button
                type="button"
                className="image-retry"
                aria-label="重试上传"
                onClick={() => images.retry(item)}
              >
                <RotateCw size={16} />
              </button>
            )}
            <button
              type="button"
              className="image-remove"
              aria-label={`移除 ${item.file.name || "图片"}`}
              onClick={() => images.remove(item.id)}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
      {!vision && <small>当前模型看不到图片，换一个能看图的模型或移除图片</small>}
    </section>
  );
}
