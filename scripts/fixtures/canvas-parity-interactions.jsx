import { ReactFlow } from "@xyflow/react";
import { useState } from "react";
import { AssetPickerDialog } from "../../src/renderer/workspace/asset-picker-dialog";
import { runCanvasExport } from "../../src/renderer/workspace/canvas-export";
import { CanvasExportProgress } from "../../src/renderer/workspace/canvas-export-progress";
import { GenerationForm } from "../../src/renderer/workspace/generation";
import { ImageOutpaintDialog } from "../../src/renderer/workspace/image-outpaint-dialog";
import { NodeImagePreview } from "../../src/renderer/workspace/node-image-preview";

const settings = {
  providers: [
    {
      id: "p",
      enabled: true,
      channelEnabled: true,
      hasSecret: true,
      model: "doubao-seedance-2-0",
      revision: 1,
      pluginHash: "plugin",
    },
  ],
  plugins: [
    { hash: "plugin", key: "doubao-video", kind: "video", origin: "builtin", auth: "none" },
  ],
  channels: [],
};

export function Interactions() {
  const [data, setData] = useState({ kind: "video", label: "视频", text: "雨中的车站" });
  const [assets, setAssets] = useState([]);
  const [pick, setPick] = useState();
  const [preview, setPreview] = useState();
  const [stage, setStage] = useState(false);
  const [paint, setPaint] = useState(false);
  window.openPaint = () => setPaint(true);
  const node = { id: "video-fixture", type: "creative", position: { x: 0, y: 0 }, data };
  const graph = {
    schemaVersion: 1,
    revision: 1,
    nodes: [node],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  window.setPreviewCase = setPreview;
  window.setExportStage = setStage;
  window.checkExport = async (cancel) => {
    const controller = new AbortController();
    const pending = runCanvasExport([graph, "回放", assets], controller.signal);
    if (cancel) controller.abort();
    try {
      return JSON.parse((await pending).json).format;
    } catch (error) {
      return error.name;
    }
  };
  return (
    <>
      <div className="canvas-workspace" style={{ display: "block", width: 680, height: "auto" }}>
        <GenerationForm
          inline
          node={node}
          settings={settings}
          graph={graph}
          assets={assets}
          onSettingsChange={(patch) => setData((old) => ({ ...old, ...patch }))}
          onMentionLink={() => {}}
          onUploadReference={async () => {}}
          onVoicePicker={(validate, apply) => setPick({ validate, apply })}
          close={() => {}}
          submit={async (input) => {
            window.videoSubmission = input;
          }}
        />
      </div>
      {pick && (
        <AssetPickerDialog
          voicesFirst
          lockedKind="audio"
          handle="p"
          assets={assets}
          jobs={[]}
          projectName="demo"
          importing={false}
          capacity={1}
          close={() => setPick(undefined)}
          upload={() => {
            throw Error();
          }}
          attachOfficialVoice={async (file) => {
            const asset = {
              assetId: "local-voice",
              availability: "ready",
              mediaType: "audio",
              mimeType: "audio/wav",
              displayName: file,
              sizeBytes: 100,
              metadata: { officialVoice: `https://img.vbing.site/official-voices/${file}` },
            };
            setAssets([asset]);
            return asset;
          }}
          confirm={async ([asset]) => {
            const issue = pick.validate(asset);
            if (issue) return issue;
            pick.apply(asset);
            setPick(undefined);
          }}
        />
      )}
      {preview && (
        <div style={{ width: 360, height: 180 }}>
          <ReactFlow
            nodes={[]}
            edges={[]}
            defaultViewport={{ x: 0, y: 0, zoom: preview.zoom }}
            viewport={{ x: 0, y: 0, zoom: preview.zoom }}
            onViewportChange={() => {}}
          >
            <NodeImagePreview
              key={preview.id}
              handle="p"
              id={preview.id}
              selected={preview.selected ?? false}
              alt="分档回放"
            />
          </ReactFlow>
        </div>
      )}
      {stage && (
        <CanvasExportProgress stage="正在生成画布交换文件…" cancel={() => setStage(false)} />
      )}
      {paint && (
        <div style={{ width: 800, height: 760 }}>
          <ReactFlow
            nodes={[
              {
                id: "paint",
                position: { x: 250, y: 20 },
                data: { label: "原图" },
                style: { width: 150, height: 100 },
              },
            ]}
            edges={[]}
          >
            <ImageOutpaintDialog
              nodeId="paint"
              assetName="3×2 测试图"
              url="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAC0lEQVR4nGNgwAQAABQAAX3+Hu4AAAAASUVORK5CYII="
              settings={{
                providers: [{ ...settings.providers[0], model: "gpt-image-1" }],
                plugins: [{ ...settings.plugins[0], kind: "image", key: "openai-image" }],
              }}
              busy={false}
              error=""
              close={() => setPaint(false)}
              submit={(draft) => {
                window.outpaintDraft = draft;
              }}
            />
          </ReactFlow>
        </div>
      )}
    </>
  );
}
