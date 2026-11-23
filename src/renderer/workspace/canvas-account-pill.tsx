import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { LogOut, Sparkle, User } from "lucide-react";
import { motion } from "motion/react";

export const fixedMenuSide = { side: "none", align: "shift", fallbackAxisSide: "none" } as const;

export function CanvasAccountPill() {
  return (
    <div className="canvas-view-more canvas-account-pill">
      <Popover.Root>
        <Popover.Trigger
          aria-label="积分，实时进度未连接"
          className="canvas-credit-trigger"
          render={<motion.button type="button" whileTap={{ scale: 0.96 }} />}
        >
          <span className="canvas-connection-dot" title="实时进度未连接" />
          <Sparkle size={18} strokeWidth={0} />
          <span>—</span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            className="canvas-frame-positioner"
            align="end"
            sideOffset={10}
            collisionAvoidance={fixedMenuSide}
          >
            <Popover.Popup
              aria-label="积分余额"
              className="canvas-frame-menu canvas-view-menu canvas-credit-popup"
            >
              <div>
                <strong>—</strong>
                <span>可用积分</span>
              </div>
              <dl>
                <dt>总余额</dt>
                <dd>—</dd>
                <dt>生成中冻结</dt>
                <dd>—</dd>
              </dl>
              <p>实时进度未连接</p>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <hr className="canvas-account-divider" data-ui-divider aria-orientation="vertical" />
      <Menu.Root modal={false}>
        <Menu.Trigger
          className="canvas-account-trigger"
          aria-label="账户"
          render={<motion.button type="button" whileTap={{ scale: 0.96 }} />}
        >
          <span>我</span>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            className="canvas-frame-positioner"
            align="end"
            sideOffset={10}
            collisionAvoidance={fixedMenuSide}
          >
            <Menu.Popup
              className="canvas-frame-menu canvas-view-menu canvas-account-menu"
              aria-label="账户"
            >
              <Menu.Item disabled title="未连接官方账户">
                <User size={16} />
                个人中心
              </Menu.Item>
              <Menu.Separator />
              <Menu.Item disabled title="当前未登录" className="canvas-account-logout">
                <LogOut size={16} />
                退出登录
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
