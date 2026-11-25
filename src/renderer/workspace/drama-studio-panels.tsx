import { type ReactNode, useSyncExternalStore } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import "./drama-studio-panels.css";

const breakpoints = [1024, 1280];
function subscribe(change: () => void) {
  const queries = breakpoints.map((width) => matchMedia(`(min-width: ${width}px)`));
  for (const query of queries) query.addEventListener("change", change);
  return () => {
    for (const query of queries) query.removeEventListener("change", change);
  };
}
function columnCount() {
  return 1 + breakpoints.filter((width) => matchMedia(`(min-width: ${width}px)`).matches).length;
}
export function StudioPanels({
  library,
  preview,
  editor,
  children,
  hidden,
}: {
  library: ReactNode;
  preview: ReactNode;
  editor: ReactNode;
  children: ReactNode;
  hidden: boolean;
}) {
  const count = useSyncExternalStore(subscribe, columnCount);
  const columns = ["library", "preview", "editor"].slice(3 - count);
  const rowsLayout = useDefaultLayout({ id: "drama-studio-rows", panelIds: ["main", "clips"] });
  const columnsLayout = useDefaultLayout({ id: "drama-studio-columns", panelIds: columns });
  return (
    <div className="studio-panel-face" inert={hidden}>
      <Group
        orientation="vertical"
        defaultLayout={rowsLayout.defaultLayout}
        onLayoutChanged={rowsLayout.onLayoutChanged}
      >
        <Panel id="main" minSize={240}>
          <Group
            key={count}
            orientation="horizontal"
            defaultLayout={columnsLayout.defaultLayout}
            onLayoutChanged={columnsLayout.onLayoutChanged}
          >
            {count === 3 && (
              <>
                <Panel id="library" defaultSize={224} minSize={180} maxSize="35%">
                  {library}
                </Panel>
                <Separator aria-label="调整资产库宽度" />
              </>
            )}
            {count >= 2 && (
              <>
                <Panel id="preview" minSize={280}>
                  {preview}
                </Panel>
                <Separator aria-label="调整编辑区宽度" />
              </>
            )}
            <Panel id="editor" defaultSize={400} minSize={320}>
              {editor}
            </Panel>
          </Group>
        </Panel>
        <Separator aria-label="调整时间线高度" />
        <Panel id="clips" defaultSize={152} minSize={140} maxSize="60%">
          {children}
        </Panel>
      </Group>
    </div>
  );
}
