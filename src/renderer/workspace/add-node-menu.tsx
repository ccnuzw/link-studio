import { Menu } from "@base-ui/react/menu";
import {
  Clapperboard,
  GalleryHorizontalEnd,
  Image,
  Library,
  Type,
  Upload,
  UserRound,
  Video,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { NodeAudioIcon } from "./node-audio-icon";

export const nodeMenuItems = [
  ["image", "图片生成", Image],
  ["video", "视频生成", Video],
  ["script", "文本", Type],
  ["audio", "音频", NodeAudioIcon],
  ["director", "导演台", Clapperboard],
  ["character", "角色卡", UserRound],
  ["storyboard", "分镜表", GalleryHorizontalEnd],
] as const;
type Kind = (typeof nodeMenuItems)[number][0];

export function AddNodeMenu({
  point,
  trigger,
  wrapTrigger,
  open,
  label,
  onOpenChange,
  disabled,
  uploadDisabled,
  choose,
  upload,
  assets,
}: {
  point?: { x: number; y: number };
  trigger?: ReactElement<{ disabled?: boolean }>;
  wrapTrigger?: (trigger: ReactElement) => ReactNode;
  open: boolean;
  label: string;
  onOpenChange: (open: boolean) => void;
  disabled: (kind: Kind) => boolean;
  uploadDisabled: boolean;
  choose: (kind: Kind) => void;
  upload: () => void;
  assets: () => void;
}) {
  const button = trigger && <Menu.Trigger render={trigger} disabled={trigger.props.disabled} />;
  return (
    <Menu.Root modal={false} open={open} onOpenChange={onOpenChange}>
      {button ? (
        wrapTrigger ? (
          wrapTrigger(button)
        ) : (
          button
        )
      ) : (
        <Menu.Trigger
          tabIndex={-1}
          aria-hidden="true"
          className="canvas-menu-anchor"
          style={{ left: point?.x ?? 0, top: point?.y ?? 0 }}
        />
      )}
      <Menu.Portal>
        <Menu.Positioner
          className="canvas-menu-positioner"
          align="start"
          side={trigger ? "right" : "bottom"}
          sideOffset={trigger ? 14 : 2}
          collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
        >
          <Menu.Popup className="canvas-add-menu" aria-label={trigger ? "添加节点" : "画布菜单"}>
            <Menu.Group>
              <Menu.GroupLabel className="canvas-menu-label">{label}</Menu.GroupLabel>
              {nodeMenuItems.map(([kind, text, Icon]) => (
                <Menu.Item key={kind} disabled={disabled(kind)} onClick={() => choose(kind)}>
                  <span>
                    <Icon />
                  </span>
                  <span>{text}</span>
                </Menu.Item>
              ))}
              <Menu.Separator />
              <Menu.Item disabled={uploadDisabled} onClick={upload}>
                <span>
                  <Upload />
                </span>
                <span>上传素材</span>
              </Menu.Item>
              <Menu.Item onClick={assets}>
                <span>
                  <Library />
                </span>
                <span>从资产库添加</span>
              </Menu.Item>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
