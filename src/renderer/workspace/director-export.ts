import type { DirectorScene } from "@link-studio/core";
import { requirePresent } from "@link-studio/core";
import { loadDirectorFigures } from "./director-figures";
import { directorFrameSize } from "./director-frame-size";
import { createDirectorRenderer } from "./director-renderer";

export async function directorThumbnail(scene: DirectorScene) {
  const camera = scene.cameras.find((item) => item.id === scene.activeCameraId) ?? scene.cameras[0];
  if (!camera) return;
  await loadDirectorFigures(scene.characters);
  const renderer = createDirectorRenderer();
  const { canvas } = renderer;
  try {
    const [width, height] = camera.aspect.split(":").map(Number);
    const ratio = requirePresent(width, "width") / requirePresent(height, "height");
    renderer.renderShot(
      { ...scene, activeCameraId: camera.id },
      0,
      Math.round(480 * Math.min(1, ratio)),
      Math.round(480 * Math.min(1, 1 / ratio)),
    );
    const image = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    if (image) return new Uint8Array(await image.arrayBuffer());
  } finally {
    renderer.dispose();
  }
}

export async function supportsDirectorExport() {
  if (typeof VideoEncoder === "undefined") return false;
  const { canEncodeVideo } = await import("mediabunny");
  return canEncodeVideo("avc", { width: 1920, height: 1080 }).catch(() => false);
}

export async function exportDirectorTake(
  scene: DirectorScene,
  signal: AbortSignal,
  progress: (frames: number) => void,
  longSide: 1280 | 1920,
  firstFrame: boolean,
) {
  const camera = scene.cameras.find(({ id }) => id === scene.activeCameraId);
  if (!camera) throw new Error("请选择要导出的机位。");
  const { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH } = await import(
    "mediabunny"
  );
  const size = directorFrameSize(camera.aspect, longSide, longSide);
  await loadDirectorFigures(scene.characters);
  signal.throwIfAborted();
  const renderer = createDirectorRenderer();
  const { canvas } = renderer;
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const frameRate = 24;
  const count = Math.round(scene.duration * frameRate);
  try {
    let png: Uint8Array | undefined;
    const frames = new CanvasSource(canvas, {
      codec: "avc",
      bitrate: QUALITY_HIGH,
      keyFrameInterval: 1,
    });
    output.addVideoTrack(frames, { frameRate });
    await output.start();
    for (let index = 0; index < count; index++) {
      signal.throwIfAborted();
      const timestamp = index / frameRate;
      renderer.renderShot(scene, timestamp, size.width, size.height);
      if (!index && firstFrame) {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/png"),
        );
        if (!blob) throw new Error("无法读取首帧图");
        png = new Uint8Array(await blob.arrayBuffer());
      }
      await frames.add(timestamp, 1 / frameRate);
      progress(index + 1);
      if (index % 4 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    await output.finalize();
    signal.throwIfAborted();
    if (!target.buffer) throw new Error("编码没有产出视频。");
    return { mp4: new Uint8Array(target.buffer), png };
  } finally {
    if (output.state !== "finalized") await output.cancel().catch(() => undefined);
    renderer.dispose();
  }
}
