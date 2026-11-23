import { Menu } from "@base-ui/react/menu";
import { ChevronDown, ChevronRight, Grid3x3 } from "lucide-react";
import { useState } from "react";

const counts = [1, 2, 3, 4, 5];
const collision = { side: "none", align: "shift", fallbackAxisSide: "none" } as const;

export function GridSplitMenu({
  disabled,
  choose,
}: {
  disabled: boolean;
  choose: (rows: number, columns: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<{ row: number; column: number }>();
  function pick(row: number, column: number) {
    if (row * column < 2) return;
    setOpen(false);
    choose(row, column);
  }
  return (
    <Menu.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        setHover(undefined);
      }}
      modal={false}
    >
      <Menu.Trigger
        disabled={disabled}
        className="canvas-frame-trigger"
        title="宫格切分"
        aria-label="宫格切分"
      >
        <Grid3x3 size={16} />
        <span>宫格切分</span>
        <ChevronDown size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="canvas-frame-positioner"
          sideOffset={8}
          align="start"
          collisionAvoidance={collision}
        >
          <Menu.Popup className="canvas-frame-menu" aria-label="宫格切分">
            {counts.slice(1).map((count) => (
              <Menu.Item key={count} onClick={() => pick(count, count)}>
                <Grid3x3 size={16} />
                {count * count} 宫格 ({count}×{count})
              </Menu.Item>
            ))}
            <Menu.SubmenuRoot>
              <Menu.SubmenuTrigger>
                <Grid3x3 size={16} />
                自定义
                <ChevronRight size={16} style={{ marginLeft: "auto" }} />
              </Menu.SubmenuTrigger>
              <Menu.Portal>
                <Menu.Positioner
                  className="canvas-frame-positioner"
                  side="right"
                  align="start"
                  sideOffset={6}
                  alignOffset={-6}
                  collisionAvoidance={collision}
                >
                  <Menu.Popup className="canvas-frame-menu split-picker" aria-label="自定义宫格">
                    <header>
                      自定义宫格<b>{hover && `${hover.row}×${hover.column}`}</b>
                    </header>
                    <fieldset
                      aria-label="宫格尺寸"
                      className="split-cells"
                      onMouseLeave={() => setHover(undefined)}
                      onBlur={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget)) setHover(undefined);
                      }}
                    >
                      {counts.flatMap((row) =>
                        counts.map((column) => (
                          <button
                            key={`${row}-${column}`}
                            type="button"
                            aria-label={`${row}×${column}`}
                            aria-disabled={row * column === 1 || undefined}
                            title={row * column === 1 ? "至少 2 格，1×1 不可选" : undefined}
                            data-lit={!!hover && row <= hover.row && column <= hover.column}
                            onMouseEnter={() => setHover({ row, column })}
                            onFocus={() => setHover({ row, column })}
                            onClick={() => pick(row, column)}
                          />
                        )),
                      )}
                    </fieldset>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.SubmenuRoot>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
