import type { DirectorScene } from "@link-studio/core";
import { WebGLRenderer } from "three";
import { loadDirectorFigures } from "./director-figures";
import { directorFrameSize, renderDirectorFrame } from "./director-view";

export async function exportDirectorVideo(
  scene: DirectorScene,
  signal: AbortSignal,
  progress: (fraction: number) => void,
) {
  const camera = scene.cameras.find(({ id }) => id === scene.activeCameraId);
  if (!camera) throw new Error("请选择要导出的机位。");
  const { BufferTarget, CanvasSource, Mp4OutputFormat, Output, canEncodeVideo } = await import(
    "mediabunny"
  );
  const size = directorFrameSize(camera.aspect, 1280, 1280);
  const bitrate = 4_000_000;
  if (!(await canEncodeVideo("avc", { ...size, bitrate })))
    throw new Error("此设备暂时无法编码 H.264 视频。");
  await loadDirectorFigures(scene.characters);
  signal.throwIfAborted();
  const canvas = document.createElement("canvas");
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const frameRate = 24;
  const count = Math.ceil(scene.duration * frameRate);
  try {
    renderDirectorFrame(renderer, scene, 0, true, size);
    const frames = new CanvasSource(canvas, { codec: "avc", bitrate, keyFrameInterval: 1 });
    output.addVideoTrack(frames, { frameRate });
    await output.start();
    for (let index = 0; index < count; index++) {
      signal.throwIfAborted();
      const timestamp = index / frameRate;
      renderDirectorFrame(renderer, scene, timestamp, true, size);
      await frames.add(timestamp, Math.min(1 / frameRate, scene.duration - timestamp));
      progress((index + 1) / count);
      if (index % 4 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    await output.finalize();
    signal.throwIfAborted();
    if (!target.buffer) throw new Error("编码没有产出视频。");
    return new Uint8Array(target.buffer);
  } finally {
    if (output.state !== "finalized") await output.cancel().catch(() => undefined);
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
