import { Tooltip } from "@base-ui/react/tooltip";
import {
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Download,
  ImageOff,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CanvasControlTip } from "./canvas-control-tip";
import { previewBytes } from "./canvas-preview-items";
import { useLocalPreviewResult } from "./character-card-body";
import { LightboxVideo } from "./lightbox-video";
import { LocalVideoPoster } from "./local-video-poster";
import { MediaThumbnail } from "./media-thumbnail";
import "./shot-image-preview.css";

export type ShotPreviewItem = {
  id: string;
  assetId: string;
  label: string;
  nodeId?: string;
  kind?: "image" | "video";
  bytes?: number;
  fileName?: string;
};

function ShotTab({
  item,
  projectHandle,
  active,
  select,
}: {
  item: ShotPreviewItem;
  projectHandle: string;
  active: boolean;
  select: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    if (active)
      button.current?.scrollIntoView({
        block: "nearest",
        inline: "center",
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
  }, [active]);
  return (
    <button
      type="button"
      ref={button}
      aria-label={item.label}
      aria-current={active}
      onClick={select}
    >
      {item.kind === "video" ? (
        <>
          <LocalVideoPoster assetId={item.assetId} projectHandle={projectHandle} />
          <i>
            <Play />
          </i>
        </>
      ) : (
        <MediaThumbnail
          key={JSON.stringify([projectHandle, item.assetId])}
          handle={projectHandle}
          assetId={item.assetId}
          video={false}
        />
      )}
      {active && (
        <motion.b
          aria-hidden
          className="lightbox-active-thumb"
          layoutId="lightbox-active-thumb"
          transition={
            reduce ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 38, mass: 0.8 }
          }
        />
      )}
    </button>
  );
}

function PreviewStage({
  item,
  url,
  poster,
  readRatio,
  readSize,
  retry,
}: {
  item: ShotPreviewItem;
  url?: string;
  poster?: string | null;
  readRatio: (width: number, height: number) => void;
  readSize: (width: number, height: number) => void;
  retry: () => void;
}) {
  const [failed, setFailed] = useState(false);
  if (!url || failed)
    return (
      <div
        className="lightbox-failed"
        role={item.kind === "video" ? "alert" : "img"}
        aria-label={item.kind === "video" ? undefined : "原图加载失败"}
      >
        <ImageOff />
        {item.kind === "video" ? "视频无法播放" : "原图加载失败"}
        <button type="button" onClick={retry}>
          <RotateCcw />
          重试
        </button>
      </div>
    );
  if (item.kind === "video")
    return (
      <div className="lightbox-video-stage">
        {poster && (
          <img
            src={poster}
            alt=""
            draggable={false}
            onLoad={({ currentTarget }) =>
              readRatio(currentTarget.naturalWidth, currentTarget.naturalHeight)
            }
          />
        )}
        <LightboxVideo src={url} onSize={readSize} onError={() => setFailed(true)} />
      </div>
    );
  return (
    <img
      src={url}
      alt={item.label}
      draggable={false}
      onError={() => setFailed(true)}
      onLoad={({ currentTarget }) =>
        readSize(currentTarget.naturalWidth, currentTarget.naturalHeight)
      }
    />
  );
}

export function ShotImagePreview({
  items,
  activeId,
  select,
  projectHandle,
  locate,
  close,
  countLabel = "本分镜表",
  origin,
  download,
  renderAction,
}: {
  items: ShotPreviewItem[];
  activeId: string;
  select: (id: string) => void;
  projectHandle: string;
  locate?: (id: string) => void;
  renderAction?: (id: string) => React.ReactNode;
  close: () => void;
  countLabel?: string;
  origin?: { x: number; y: number };
  download?: (assetId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const reduce = useReducedMotion();
  const [direction, setDirection] = useState(1);
  const [closing, setClosing] = useState(false);
  const afterExit = useRef<(() => void) | undefined>(undefined);
  const exit = (action: () => void) => {
    if (afterExit.current) return;
    if (reduce) {
      action();
      return;
    }
    afterExit.current = action;
    setClosing(true);
  };
  const lastIndex = useRef(0);
  const found = items.findIndex((item) => item.id === activeId);
  const index = found >= 0 ? found : Math.min(lastIndex.current, items.length - 1);
  const item = items[index];
  useEffect(() => {
    if (!item) close();
    else {
      lastIndex.current = index;
      if (item.id !== activeId) select(item.id);
    }
  }, [item, index, activeId, close, select]);
  const [attempt, setAttempt] = useState(0);
  const assetId = item?.assetId;
  const poster = useLocalPreviewResult(
    projectHandle,
    item?.kind === "video" ? assetId : undefined,
    "poster",
  );
  const [source, setSource] = useState<{
    projectHandle: string;
    assetId: string;
    attempt: number;
    url?: string;
  }>();
  useEffect(() => {
    if (!assetId) return;
    let current = true;
    const finish = (url?: string) => {
      if (current) setSource({ projectHandle, assetId, attempt, url });
    };
    void window.desktop.projects.getAssetPreview({ projectHandle, assetId }).then(
      (result) => finish(result.ok ? result.value.url : undefined),
      () => finish(),
    );
    return () => {
      current = false;
    };
  }, [assetId, projectHandle, attempt]);
  const loadedSource =
    source?.projectHandle === projectHandle &&
    source.assetId === assetId &&
    source.attempt === attempt
      ? source
      : undefined;
  const url = loadedSource?.url;
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const bytes = previewBytes(item?.bytes);
  const mediaKey = JSON.stringify([projectHandle, assetId]);
  const natural = sizes[mediaKey];
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const ratio = ratios[mediaKey] ?? 16 / 9;
  const readRatio = (width: number, height: number) => {
    if (width && height)
      setRatios((previous) =>
        previous[mediaKey] === width / height
          ? previous
          : { ...previous, [mediaKey]: width / height },
      );
  };
  const readSize = (width: number, height: number) => {
    readRatio(width, height);
    if (url && width && height)
      setSizes((previous) =>
        previous[mediaKey]?.width === width && previous[mediaKey]?.height === height
          ? previous
          : { ...previous, [mediaKey]: { width, height } },
      );
  };
  const many = items.length > 1;
  const goTo = (nextIndex: number) => {
    const next = items[nextIndex];
    if (!next || nextIndex === index || closing) return;
    setDirection(nextIndex > index ? 1 : -1);
    select(next.id);
  };
  useLayoutEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    element?.showModal();
    element?.focus();
    return () => {
      element?.close();
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, []);
  const tip = (label: string, button: React.ReactElement) => (
    <CanvasControlTip label={label} container={dialog} sideOffset={4}>
      {button}
    </CanvasControlTip>
  );
  return (
    <Tooltip.Provider delay={0}>
      <dialog
        ref={dialog}
        tabIndex={-1}
        className="shot-image-preview"
        data-closing={closing || undefined}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && event.animationName === "lightbox-dismiss")
            afterExit.current?.();
        }}
        aria-label="媒体预览"
        onCancel={(event) => {
          event.preventDefault();
          event.stopPropagation();
          exit(close);
        }}
        onClick={(event) => {
          if (event.currentTarget === event.target) exit(close);
        }}
        onKeyDownCapture={(event) => {
          if ((event.target as Element).closest('[role="menu"]')) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            exit(close);
            return;
          }
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            event.stopPropagation();
            goTo(index + (event.key === "ArrowLeft" ? -1 : 1));
          }
        }}
      >
        <div
          className="shot-stage"
          style={{ transformOrigin: origin && `${origin.x}px ${origin.y}px` }}
        >
          <div className="shot-stage-content">
            <AnimatePresence initial={false} mode="popLayout">
              {item && (
                <motion.div
                  className="lightbox-frame"
                  key={item.id}
                  initial={{ opacity: 0, x: reduce ? 0 : direction * 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
                  style={{
                    aspectRatio: ratio,
                    width: `min(100%, calc((100svh - 222px) * ${ratio}))`,
                  }}
                >
                  {loadedSource && (
                    <PreviewStage
                      key={JSON.stringify([mediaKey, url, attempt])}
                      item={item}
                      url={url}
                      poster={poster}
                      readRatio={readRatio}
                      readSize={readSize}
                      retry={() => setAttempt((current) => current + 1)}
                    />
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
        <div className="shot-preview-tools">
          <span aria-live="polite">
            {natural
              ? `${natural.width}×${natural.height}${bytes ? ` · ${bytes}` : ""}`
              : item?.kind === "video"
                ? "加载视频…"
                : "加载原图…"}
          </span>
          {item &&
            tip(
              "下载原文件",
              download ? (
                <button
                  type="button"
                  aria-label="下载原文件"
                  onClick={() => download(item.assetId)}
                >
                  <Download />
                </button>
              ) : (
                <a href={url} download={item.fileName ?? item.label} aria-label="下载原文件">
                  <Download />
                </a>
              ),
            )}
          {tip(
            "关闭（Esc）",
            <button type="button" aria-label="关闭" onClick={() => exit(close)}>
              <X />
            </button>,
          )}
        </div>
        {many && (
          <>
            {tip(
              "上一个（←）",
              <button
                className="shot-previous"
                type="button"
                aria-label="上一个"
                disabled={index === 0}
                onClick={() => goTo(index - 1)}
              >
                <ChevronLeft />
              </button>,
            )}
            {tip(
              "下一个（→）",
              <button
                className="shot-next"
                type="button"
                aria-label="下一个"
                disabled={index === items.length - 1}
                onClick={() => goTo(index + 1)}
              >
                <ChevronRight />
              </button>,
            )}
          </>
        )}
        <div className="shot-preview-bottom">
          <div>
            {many && (
              <>
                <span>
                  {countLabel} {index + 1} / {items.length}
                </span>
                <span className="lightbox-keys">
                  <kbd>←</kbd>
                  <kbd>→</kbd>切换
                </span>
              </>
            )}
            {item && renderAction
              ? renderAction(item.id)
              : locate && (
                  <motion.button
                    whileTap={{ scale: 0.96 }}
                    type="button"
                    onClick={() => {
                      const nodeId = item?.nodeId;
                      if (nodeId) exit(() => locate(nodeId));
                    }}
                  >
                    <Crosshair />
                    定位到节点
                  </motion.button>
                )}
          </div>
          {many && (
            <nav aria-label={countLabel === "本分镜表" ? "镜头缩略图" : "节点缩略图"}>
              {items.map((entry, nextIndex) => (
                <ShotTab
                  key={entry.id}
                  item={entry}
                  projectHandle={projectHandle}
                  active={entry.id === item?.id}
                  select={() => goTo(nextIndex)}
                />
              ))}
            </nav>
          )}
        </div>
      </dialog>
    </Tooltip.Provider>
  );
}
