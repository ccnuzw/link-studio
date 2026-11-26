import type { LibraryFolder, ProjectAsset, ProjectValues } from "@link-studio/core";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LibraryManagement } from "../../src/renderer/workspace/library-management";
import { ProjectFilesPanel } from "../../src/renderer/workspace/project-files-panel";
import "../../src/renderer/styles.css";
import "../../src/renderer/workspace/canvas-workspace.css";

const scenario = new URLSearchParams(location.search);

function file(
  assetId: string,
  displayName: string,
  mediaType: ProjectAsset["mediaType"],
  metadata: ProjectAsset["metadata"],
  external = false,
): ProjectAsset {
  return {
    assetId,
    displayName,
    mediaType,
    mimeType: { audio: "audio/wav", image: "image/png", video: "video/mp4" }[mediaType],
    sha256: assetId,
    sizeBytes: { audio: 612_000, image: 8_192, video: 11_245_000 }[mediaType],
    metadata,
    importMode: external ? "reference" : "copy",
    storage: external ? { kind: "external", locatorId: assetId } : { kind: "blob", hash: assetId },
    availability: external ? "missing" : "ready",
  };
}

const samples = [
  file("image", "雨夜站台.png", "image", { width: 1920, height: 1080, filingEnabled: true }),
  file("video", "末班车_预告片.mp4", "video", { width: 1920, height: 1080, durationMs: 8000 }),
  file("audio", "站台环境音.wav", "audio", { durationMs: 12300 }),
  file("missing", "末班车_外部参考_文件名过长测试图像素材.png", "image", {}, true),
];

if (scenario.has("library")) {
  const populated = !scenario.has("empty");
  const makeFolder = (id: string, name: string): LibraryFolder => ({
    id,
    name,
    createdAt: "2026-11-26",
    itemCount: 0,
  });
  let folders = populated
    ? [makeFolder("references", "镜头参考"), makeFolder("sound", "声音素材")]
    : [];
  let items: ProjectValues["listLibrary"]["items"] = populated
    ? samples
        .slice(0, 3)
        .map((asset) => ({ asset, folderId: asset.mediaType === "audio" ? "sound" : null }))
    : [];
  const subscribers = new Set<() => void>();
  const publish = () => {
    for (const listener of subscribers) listener();
  };
  const listing = () =>
    folders.map((folder) => ({
      ...folder,
      itemCount: items.filter((row) => row.folderId === folder.id).length,
    }));
  Object.assign(window.desktop.projects, {
    listLibrary: async () => ({ ok: true, value: { items, folders: listing() } }),
    listLibraryFolders: async () => ({ ok: true, value: listing() }),
    createLibraryFolder: async ({ name }: { name: string }) => {
      const folder = makeFolder("created", name);
      folders = [...folders, folder];
      publish();
      return { ok: true, value: folder };
    },
    renameLibraryFolder: async ({ folderId, name }: { folderId: string; name: string }) => {
      folders = folders.map((folder) => (folder.id === folderId ? { ...folder, name } : folder));
      publish();
      return { ok: true };
    },
    moveLibraryItem: async ({ folderId, itemId }: { folderId: string | null; itemId: string }) => {
      items = items.map((item) => (item.asset.assetId === itemId ? { ...item, folderId } : item));
      publish();
      return { ok: true };
    },
    deleteLibraryFolder: async ({ folderId }: { folderId: string }) => {
      const removed = items.filter((item) => item.folderId === folderId).length;
      folders = folders.filter((folder) => folder.id !== folderId);
      items = items.filter((item) => item.folderId !== folderId);
      publish();
      return { ok: true, value: { removed } };
    },
  });
  Object.assign(window.desktop, {
    projectEvents: {
      onLibraryChanged: (listener: () => void) => {
        subscribers.add(listener);
        return () => subscribers.delete(listener);
      },
    },
  });
}

function Fixture() {
  const [hidden, setHidden] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [mode, setMode] = useState<ProjectAsset["importMode"]>("copy");
  const [event, setEvent] = useState("");
  const [phase, setPhase] = useState<"copying" | "duplicate" | "idle">("idle");
  const record = (action: string) => (asset: ProjectAsset) =>
    setEvent(`${action}:${asset.assetId}`);
  const assetList = scenario.has("empty")
    ? []
    : scenario.has("many")
      ? [
          ...samples,
          ...Array.from({ length: 22 }, (_, index) =>
            file(`audio-${index}`, `环境音 ${index + 1}.wav`, "audio", {}),
          ),
        ]
      : samples;
  return (
    <div className="canvas-workspace">
      <main
        className="canvas-area"
        style={{
          position: "relative",
          backgroundColor: "#f5f5f5",
          backgroundImage: "radial-gradient(#bbb 1px, transparent 1px)",
          backgroundSize: "16px 16px",
        }}
      >
        <output data-testid="action" hidden>
          {event}
        </output>
        <ProjectFilesPanel
          projectHandle="fixture"
          assets={assetList}
          targetKind={scenario.has("target") ? "audio" : undefined}
          hidden={hidden}
          importMode={mode}
          busy={phase !== "idle"}
          importing={phase !== "idle"}
          canAdd
          changeImportMode={setMode}
          importFiles={() => {
            setEvent(`import:${mode}`);
            setPhase("copying");
          }}
          close={() => setHidden(true)}
          actions={{
            preview: record("preview"),
            add: record("add"),
            relocate: record("relocate"),
            remove: record("remove"),
            extract: record("extract"),
            enroll: record("enroll"),
          }}
          createFolder={() => setEvent("new-folder")}
          manageLibrary={() => {
            setEvent("library");
            if (scenario.has("library")) setLibraryOpen(true);
          }}
          progress={
            phase === "copying"
              ? {
                  name: "雨夜站台.png",
                  status: { phase: "copying", copiedBytes: 10, totalBytes: 20 },
                  cancelling: false,
                  cancel: () => setPhase("duplicate"),
                }
              : undefined
          }
          duplicate={
            phase === "duplicate"
              ? {
                  displayName: "雨夜站台.png",
                  resolve: (choice) => {
                    setEvent(choice);
                    setPhase("idle");
                  },
                }
              : undefined
          }
        >
          {libraryOpen && (
            <LibraryManagement
              handle="fixture"
              close={() => setLibraryOpen(false)}
              openPicker={() => {
                setLibraryOpen(false);
                setHidden(true);
                setEvent("picker");
              }}
            />
          )}
        </ProjectFilesPanel>
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("缺少测试容器");
createRoot(root).render(<Fixture />);
