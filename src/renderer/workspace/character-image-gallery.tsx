import type { ProjectAsset } from "@link-studio/core";
import { FolderOpen, Loader2, Plus, Upload, UserRound, UsersRound, X } from "lucide-react";
import { motion } from "motion/react";
import { useRef, useState } from "react";
import { useLocalPreview } from "./character-card-body";
import { ShotImagePreview } from "./shot-image-preview";
import "./character-image-gallery.css";

type Slot = "main" | "extra";

function ImageButton({
  handle,
  id,
  alt,
  label,
  open,
}: {
  handle: string;
  id: string;
  alt: string;
  label: string;
  open: (element: HTMLButtonElement) => void;
}) {
  const url = useLocalPreview(handle, id);
  return (
    <button
      className="character-zoom-button"
      type="button"
      aria-label={label}
      title={alt ? "放大预览" : undefined}
      onClick={(event) => open(event.currentTarget)}
    >
      {url && <img src={url} alt={alt} draggable={false} />}
    </button>
  );
}

export function CharacterImageGallery({
  handle,
  primary,
  extras,
  name,
  assets,
  library,
  human,
  remove,
  upload,
  download,
}: {
  handle: string;
  primary: string;
  extras: string[];
  name: string;
  assets: ProjectAsset[];
  library: (slot: Slot) => void;
  human: () => void;
  remove: (id: string) => void;
  upload: (slot: Slot, file: File) => Promise<void>;
  download: (id: string) => void;
}) {
  const [zoom, setZoom] = useState<{ id: string; origin?: { x: number; y: number } }>();
  const [uploading, setUploading] = useState<Slot>();
  const input = useRef<HTMLInputElement>(null);
  const purpose = useRef<Slot>("main");
  const pick = (slot: Slot) => {
    purpose.current = slot;
    input.current?.click();
  };
  const open = (id: string, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setZoom({ id, origin: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } });
  };
  const items = [
    ...(primary ? [{ id: "main", assetId: primary, label: name }] : []),
    ...extras.map((assetId, index) => ({
      id: assetId,
      assetId,
      label: `${name} 补充图 ${index + 1}`,
    })),
  ].map((item) => {
    const asset = assets.find((entry) => entry.assetId === item.assetId);
    return { ...item, bytes: asset?.sizeBytes, fileName: asset?.displayName };
  });
  return (
    <div className="character-image-gallery">
      <input
        hidden
        type="file"
        ref={input}
        accept="image/*"
        onChange={async (event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file || uploading) return;
          const slot = purpose.current;
          setUploading(slot);
          try {
            await upload(slot, file);
          } finally {
            setUploading(undefined);
          }
        }}
      />
      <div className="character-image-main">
        {primary ? (
          <ImageButton
            handle={handle}
            id={primary}
            alt={name}
            label="放大预览形象图"
            open={(element) => open("main", element)}
          />
        ) : (
          <>
            <div className="character-image-empty">
              {uploading === "main" ? (
                <Loader2 size={24} />
              ) : (
                <UserRound size={28} strokeWidth={1.5} />
              )}
              {uploading === "main" ? "上传中…" : "还没有形象"}
            </div>
            {!uploading && (
              <div className="character-image-actions">
                <button type="button" onClick={() => pick("main")}>
                  <Upload />
                  上传
                </button>
                <span aria-hidden="true" />
                <button type="button" aria-label="从资产库选主图" onClick={() => library("main")}>
                  <FolderOpen />
                  资产库
                </button>
                <span aria-hidden="true" />
                <button type="button" onClick={human}>
                  <UsersRound />
                  真人库
                </button>
              </div>
            )}
          </>
        )}
      </div>
      <div className="character-image-tools">
        <span>补充图</span>
        <small>{extras.length}/4</small>
        <motion.button
          type="button"
          whileTap={{ scale: 0.96 }}
          aria-label="从真人库引入"
          title="从真人库引入（替换主图和补充图）"
          onClick={human}
        >
          <UsersRound />
        </motion.button>
        <motion.button
          type="button"
          whileTap={!primary || extras.length >= 4 ? undefined : { scale: 0.96 }}
          aria-label="从资产库选补充图"
          title={!primary ? "先放一张主图" : extras.length >= 4 ? "补充图最多 4 张" : "从资产库选"}
          disabled={!primary || extras.length >= 4}
          onClick={() => library("extra")}
        >
          <FolderOpen />
        </motion.button>
      </div>
      <div className="character-image-extras">
        {[0, 1, 2, 3].map((index) => {
          const id = extras[index],
            next = index === extras.length;
          return id ? (
            <div key={id} className="character-image-extra">
              <ImageButton
                handle={handle}
                id={id}
                alt=""
                label={`放大预览补充图 ${index + 1}`}
                open={(element) => open(id, element)}
              />
              <button
                className="character-image-remove"
                type="button"
                aria-label="移除补充图"
                onClick={() => remove(id)}
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <button
              key={`slot-${index}`}
              className="character-image-slot"
              type="button"
              aria-label="上传补充图"
              disabled={!next || !primary || !!uploading}
              title={next && !primary ? "先放一张主图" : undefined}
              onClick={() => pick("extra")}
            >
              {next && (uploading === "extra" ? <Loader2 size={16} /> : <Plus size={16} />)}
            </button>
          );
        })}
      </div>
      {zoom && (
        <ShotImagePreview
          items={items}
          activeId={zoom.id}
          origin={zoom.origin}
          select={(id) => setZoom({ id })}
          projectHandle={handle}
          close={() => setZoom(undefined)}
          countLabel="形象图"
          download={download}
        />
      )}
    </div>
  );
}
