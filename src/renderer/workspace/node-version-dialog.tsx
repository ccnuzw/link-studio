import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import {
  type CreativeData,
  type CreativeOutput,
  type GenerationJob,
  jobFailureReason,
  type ProjectAsset,
} from "@link-studio/core";
import {
  AudioLines,
  Ban,
  ChevronDown,
  CircleX,
  Copy,
  Download,
  Ellipsis,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  Maximize2,
  X,
  ZoomIn,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useState } from "react";
import { toast } from "sonner";
import { canvasNotice as historyNotice } from "./canvas-toaster";
import { imageTaskTitle } from "./character-image-task";
import { MediaThumbnail } from "./media-thumbnail";
import { pendingVersionJobs, versionOutputs } from "./node-versions";
import { ShotImagePreview } from "./shot-image-preview";
import "./node-version-dialog.css";

export function VersionBadge({
  count,
  generating,
  open,
}: {
  count: number;
  generating: boolean;
  open: () => void;
}) {
  return (
    <button
      className="canvas-version-badge nodrag nopan"
      type="button"
      aria-label={`历史记录，共 ${count} 版${generating ? "，还有任务在生成" : ""}`}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        open();
      }}
    >
      {generating && <Loader2 size={12} className="shot-split-spinner" />}
      {count}
      <ChevronDown size={14} />
    </button>
  );
}

function Modal({
  label,
  kind,
  open = true,
  close,
  afterClose,
  children,
}: {
  label?: string;
  kind: string;
  open?: boolean;
  close: () => void;
  afterClose?: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) afterClose?.();
      }}
    >
      <Dialog.Portal>
        {kind === "normal" && <Dialog.Backdrop className="version-backdrop" />}
        <Dialog.Popup
          aria-modal="true"
          aria-label={label}
          className={`node-version-dialog ${kind}`}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-history-tile]")];
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (index < 0) return;
  const columns = items.filter((item) => item.offsetTop === items[0]?.offsetTop).length;
  const delta = (
    { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns } as Record<
      string,
      number
    >
  )[event.key];
  const next = delta && items[index + delta];
  if (next) {
    event.preventDefault();
    next.focus();
  }
}

function Tile({
  output,
  index,
  current,
  full,
  locked,
  handle,
  pick,
  zoom,
  download,
  add,
}: {
  output: CreativeOutput;
  index: number;
  current: boolean;
  full: boolean;
  locked: boolean;
  handle: string;
  pick: () => void;
  zoom: () => void;
  download: () => void;
  add: () => void;
}) {
  const copy = async () => {
    try {
      if (
        !output.assetId ||
        !(
          await window.desktop.projects.copyAssetImage({
            projectHandle: handle,
            assetId: output.assetId,
          })
        ).ok
      )
        throw new Error();
      toast.success("已复制图片", historyNotice);
    } catch {
      toast.error("复制失败，请改用下载", historyNotice);
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      data-history-tile
      aria-pressed={current}
      aria-label={`第 ${index + 1} 版${current ? "（当前主图）" : ""}`}
      title={locked ? "生成中，出第一张后可切换" : current ? "当前主图" : "设为主图"}
      data-locked={locked || undefined}
      onClick={pick}
      onDoubleClick={full ? zoom : undefined}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) {
          event.preventDefault();
          pick();
        }
      }}
    >
      {output.kind === "image" || output.kind === "video" ? (
        <MediaThumbnail
          key={JSON.stringify([handle, output.assetId, output.kind])}
          handle={handle}
          assetId={output.assetId}
          video={output.kind === "video"}
        />
      ) : (
        <AudioLines size={32} />
      )}
      {current &&
        (full ? (
          <span className="version-main">主图</span>
        ) : (
          <div className="version-current">
            <ImageIcon size={14} />
            当前图片
          </div>
        ))}
      <div
        className="version-tools"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <button type="button" aria-label="放大" title="放大" onClick={zoom}>
          <ZoomIn />
        </button>
        {output.kind === "image" && (
          <button type="button" aria-label="复制图片" title="复制图片" onClick={() => void copy()}>
            <Copy />
          </button>
        )}
        <button type="button" aria-label="下载" title="下载" onClick={download}>
          <Download />
        </button>
        <button type="button" aria-label="添加到画布" title="添加到画布" onClick={add}>
          <ImagePlus />
        </button>
      </div>
    </div>
  );
}

export function NodeVersionDialog({
  data,
  jobs,
  assets,
  handle,
  close,
  choose,
  add,
  download,
  cancel,
}: {
  data: CreativeData;
  jobs: GenerationJob[];
  assets: ProjectAsset[];
  handle: string;
  close: () => void;
  choose: (output: CreativeOutput) => void;
  add: (outputs: CreativeOutput[]) => number;
  download: (output: CreativeOutput, name: string) => void;
  cancel: (ids: string[]) => void;
}) {
  const [normal, setNormal] = useState(false),
    [full, setFull] = useState(false),
    [zoom, setZoom] = useState<string>(),
    [confirm, setConfirm] = useState<CreativeOutput[]>();
  useLayoutEffect(() => setNormal(true), []);
  const outputs = normal ? versionOutputs(data) : [],
    ordered = [...outputs].reverse();
  const pending = normal ? pendingVersionJobs(jobs) : [];
  const newest = Math.max(0, ...jobs.map((job) => Date.parse(job.createdAt) || 0));
  const failed = normal
    ? jobs.filter(
        (job) => job.status === "failed" && newest - (Date.parse(job.createdAt) || 0) <= 30000,
      )
    : [];
  const cancelable = pending.filter(
    (job) =>
      !job.cancelRequested &&
      (job.status === "queued" || (job.status === "running" && job.canCancelRemote)),
  );
  const locked = pending.length > 0 && !data.assetId;
  const selected = data.assetId
    ? (data.activeOutputId ?? outputs.findLast((output) => output.assetId === data.assetId)?.id)
    : undefined;
  const pick = (output: CreativeOutput) => {
    if (locked) toast("生成中，出第一张后可切换", historyNotice);
    else if (selected !== output.id) choose(output);
  };
  const addVersions = (versions: CreativeOutput[]) => {
    try {
      const count = add(versions);
      if (count) toast.success(`已添加 ${count} 个节点到画布`, historyNotice);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "无法添加版本", historyNotice);
    }
  };
  const addAll = () => (outputs.length > 8 ? setConfirm(outputs) : addVersions(outputs));
  const downloadAll = () =>
    outputs.forEach((output, index) => {
      download(output, `${data.label}-${index + 1}`);
    });
  const previews = ordered.flatMap((output) => {
    const asset = assets.find((item) => item.assetId === output.assetId);
    return asset && (output.kind === "image" || output.kind === "video")
      ? [
          {
            id: output.id,
            assetId: asset.assetId,
            label: `${data.label} · 版本${outputs.indexOf(output) + 1}`,
            kind: output.kind,
            fileName: asset.displayName,
            bytes: asset.sizeBytes,
          },
        ]
      : [];
  });
  const grid = (expanded: boolean) => (
    <div className="version-grid" onKeyDown={moveFocus}>
      {pending.map((job) => (
        <div key={job.id} className="version-pending" aria-label={imageTaskTitle(job)}>
          <div>
            <Loader2 className="shot-split-spinner" />
            {imageTaskTitle(job)}
          </div>
        </div>
      ))}
      {!expanded &&
        failed.map((job) => (
          <div
            key={job.id}
            className="version-failed"
            aria-label={`生成失败：${jobFailureReason(job) || "生成失败"}`}
          >
            <div>
              <CircleX />
              <b>生成失败</b>
              <span>{jobFailureReason(job) || "生成失败"}</span>
              <span>费用以渠道账单为准</span>
            </div>
          </div>
        ))}
      {ordered.map((output) => (
        <Tile
          key={output.id}
          output={output}
          index={outputs.indexOf(output)}
          current={output.id === selected}
          full={expanded}
          locked={locked}
          handle={handle}
          pick={() => pick(output)}
          zoom={() => {
            if (previews.some((item) => item.id === output.id)) setZoom(output.id);
          }}
          add={() => addVersions([output])}
          download={() => download(output, `版本${outputs.indexOf(output) + 1}`)}
        />
      ))}
    </div>
  );
  const layers = (
    <>
      {zoom && (
        <ShotImagePreview
          items={previews}
          projectHandle={handle}
          activeId={zoom}
          select={setZoom}
          close={() => setZoom(undefined)}
          countLabel="历史版本"
          renderAction={(id) =>
            id === selected ? (
              <span>主图</span>
            ) : (
              <button
                type="button"
                disabled={locked}
                onClick={() => {
                  const output = outputs.find((item) => item.id === id);
                  if (output) pick(output);
                }}
              >
                <ImageIcon />
                设为主图
              </button>
            )
          }
        />
      )}
      {confirm && (
        <Modal kind="confirm" close={() => setConfirm(undefined)}>
          <Dialog.Title>将在画布上新建 {confirm.length} 个节点，确定吗？</Dialog.Title>
          <div>
            <button type="button" onClick={() => setConfirm(undefined)}>
              取消
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirm(undefined);
                addVersions(confirm);
              }}
            >
              确定
            </button>
          </div>
        </Modal>
      )}
    </>
  );
  return (
    <>
      <Modal
        label="历史记录"
        kind="normal"
        open={normal}
        afterClose={close}
        close={() => {
          if (!zoom && !full && !confirm) setNormal(false);
        }}
      >
        <div className="version-head">
          <h2>
            历史记录<span>{outputs.length}</span>
          </h2>
          <button type="button" onClick={() => setFull(true)}>
            <Maximize2 />
            全屏查看
          </button>
          <Menu.Root>
            <Menu.Trigger aria-label="更多">
              <Ellipsis />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner
                className="version-menu-positioner"
                align="end"
                sideOffset={4}
                collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
              >
                <Menu.Popup className="version-menu">
                  <Menu.Item onClick={downloadAll}>
                    <Download />
                    下载全部
                  </Menu.Item>
                  <Menu.Item onClick={addAll}>
                    <ImagePlus />
                    全部添加到画布
                  </Menu.Item>
                  <Menu.Item
                    disabled={!cancelable.length}
                    onClick={() => cancel(cancelable.map((job) => job.id))}
                  >
                    <Ban />
                    取消剩余{cancelable.length ? `（${cancelable.length} 个）` : ""}
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
          <i />
          <button type="button" aria-label="关闭" onClick={() => setNormal(false)}>
            <X />
          </button>
        </div>
        {grid(false)}
      </Modal>
      <Modal
        label="全屏查看"
        kind="full"
        open={full}
        close={() => {
          if (!zoom && !confirm) setFull(false);
        }}
      >
        <div className="version-head">
          <button type="button" onClick={downloadAll}>
            <Download />
            下载全部
          </button>
          <button type="button" onClick={addAll}>
            <ImagePlus />
            全部添加到画布
          </button>
          <button type="button" aria-label="关闭" onClick={() => setFull(false)}>
            <X />
          </button>
        </div>
        {grid(true)}
      </Modal>
      {layers}
    </>
  );
}
