import { Popover } from "@base-ui/react/popover";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Copy,
  Ellipsis,
  Image,
  RefreshCw,
  Trash2,
  Video,
} from "lucide-react";
import { useRef, useState } from "react";

export function ShotRowMenu({
  number,
  full,
  insert,
  duplicate,
  remove,
  prepareVideo,
  hasVideo,
  hasImage,
  generateImage,
}: {
  number: number;
  full: boolean;
  insert: (after: boolean) => void;
  duplicate: () => void;
  remove: () => void;
  prepareVideo: () => void;
  hasVideo: boolean;
  hasImage: boolean;
  generateImage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const inserting = useRef(false);
  const run = (action: () => void) => {
    setOpen(false);
    action();
  };
  const insertRow = (after: boolean) => {
    inserting.current = true;
    run(() => insert(after));
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setConfirming(false);
          inserting.current = false;
        }
        setOpen(next);
      }}
    >
      <Popover.Trigger aria-label={`第 ${number} 镜的操作`}>
        <Ellipsis size={16} />
      </Popover.Trigger>
      <Popover.Portal className="storyboard-layer">
        <Popover.Positioner
          align="end"
          sideOffset={4}
          collisionBoundary={document.documentElement}
          collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
          className="shot-menu-position"
        >
          <Popover.Popup
            className="shot-row-menu"
            aria-label="镜头操作"
            finalFocus={() => !inserting.current}
          >
            {confirming ? (
              <section>
                <p>删除第 {number} 镜？</p>
                <div>
                  <button type="button" onClick={() => setConfirming(false)}>
                    取消
                  </button>
                  <button type="button" className="shot-destructive" onClick={() => run(remove)}>
                    删除
                  </button>
                </div>
              </section>
            ) : (
              <>
                <button type="button" onClick={() => run(generateImage)}>
                  {hasImage ? <RefreshCw /> : <Image />}
                  {hasImage ? "重新生成分镜图" : "生成分镜图"}
                </button>
                <button type="button" onClick={() => run(prepareVideo)}>
                  <Video />
                  {hasVideo ? "重新生成视频" : "生成视频"}
                </button>
                <div role="separator" />
                <button type="button" disabled={full} onClick={() => insertRow(false)}>
                  <ArrowUpToLine />
                  在上方插入
                </button>
                <button type="button" disabled={full} onClick={() => insertRow(true)}>
                  <ArrowDownToLine />
                  在下方插入
                </button>
                <button type="button" disabled={full} onClick={() => run(duplicate)}>
                  <Copy />
                  复制镜头
                </button>
                <div role="separator" />
                <button
                  type="button"
                  className="shot-destructive"
                  onClick={() => setConfirming(true)}
                >
                  <Trash2 />
                  删除镜头
                </button>
              </>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
