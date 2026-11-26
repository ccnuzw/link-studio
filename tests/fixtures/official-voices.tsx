import type { ProjectAsset } from "@link-studio/core";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AssetPickerDialog } from "../../src/renderer/workspace/asset-picker-dialog";
import { VoiceLibrary } from "../../src/renderer/workspace/home-asset-voices";
import "../../src/renderer/styles.css";
import "../../src/renderer/desktop-shell.css";
import "../../src/renderer/workspace/global-assets.css";

const mode = new URLSearchParams(window.location.search);

function Fixture() {
  const [open, setOpen] = useState(true);
  const [confirmed, setConfirmed] = useState<ProjectAsset[]>([]);
  if (mode.has("home")) {
    return (
      <main className="global-assets">
        <VoiceLibrary />
      </main>
    );
  }
  return (
    <>
      <output data-testid="confirmed">
        {confirmed.map((asset) => asset.displayName).join(", ")}
      </output>
      {open && (
        <AssetPickerDialog
          assets={[]}
          jobs={[]}
          handle="fixture"
          projectName="配音项目"
          importing={false}
          capacity={20}
          lockedKind={mode.has("single") ? "audio" : undefined}
          voicesFirst={mode.has("single")}
          attachOfficialVoice={async (file) => ({
            assetId: file,
            displayName: file,
            mediaType: "audio",
            mimeType: "audio/wav",
            sha256: file,
            sizeBytes: 0,
            metadata: {},
            importMode: "copy",
            storage: { kind: "blob", hash: file },
            availability: "ready",
          })}
          upload={async () => undefined}
          close={() => setOpen(false)}
          confirm={(assets) => {
            setConfirmed(assets);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
