import type { DirectorScene } from "@link-studio/core";
import { X } from "lucide-react";
import "./director-export-dialog.css";
import { useEffect, useRef, useState } from "react";
import { exportDirectorTake } from "./director-export";
import { directorFrameSize } from "./director-frame-size";
import type { DirectorTake } from "./director-take-placement";

export function DirectorExportDialog({
  scene,
  label,
  projectHandle,
  close,
  back,
  place,
  checkCapacity,
}: {
  scene: DirectorScene;
  label: string;
  projectHandle: string;
  close: () => void;
  back: () => void;
  place: (takes: DirectorTake[]) => void;
  checkCapacity: (count: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    job = useRef<AbortController>(undefined);
  const [ids, setIds] = useState([scene.activeCameraId || scene.cameras[0]?.id || ""]);
  const [longSide, setLongSide] = useState<1280 | 1920>(1280),
    [first, setFirst] = useState(true);
  const [phase, setPhase] = useState<"idle" | "rendering" | "publishing" | "done">("idle");
  const [progress, setProgress] = useState<Record<string, number>>({}),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [message, setMessage] = useState("");
  const published = useRef(new Set<string>());
  const running = phase === "rendering" || phase === "publishing",
    locked = running || phase === "done";
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    if (element) element.scrollLeft = 0;
    return () => {
      job.current?.abort();
      element?.close();
    };
  }, []);
  const total = Math.round(scene.duration * 24),
    chosen = scene.cameras.filter((camera) => ids.includes(camera.id));
  const estimate = chosen.reduce((sum, camera) => {
    const { width, height } = directorFrameSize(camera.aspect, longSide, longSide);
    return sum + (width * height * 0.45 * scene.duration) / 1024 / 1024;
  }, 0);
  async function run(selected: string[]) {
    const cameras = selected
      .filter((id) => !published.current.has(id))
      .map((id) => scene.cameras.find((camera) => camera.id === id)!);
    if (!cameras.length || job.current) return;
    const controller = new AbortController();
    job.current = controller;
    setPhase("rendering");
    setMessage("");
    const failures = { ...errors };
    for (const camera of cameras) delete failures[camera.id];
    setErrors({ ...failures });
    const encoded: {
      camera: (typeof cameras)[number];
      output: Awaited<ReturnType<typeof exportDirectorTake>>;
    }[] = [];
    try {
      checkCapacity(cameras.length * (first ? 2 : 1));
      for (const camera of cameras) {
        try {
          setProgress((current) => ({ ...current, [camera.id]: 0 }));
          const output = await exportDirectorTake(
            { ...scene, activeCameraId: camera.id },
            controller.signal,
            (frames) => setProgress((current) => ({ ...current, [camera.id]: frames })),
            longSide,
            first,
          );
          if (output.mp4.byteLength > 200 * 1024 * 1024)
            throw Error("视频超过上传大小上限，请降低分辨率或缩短时长");
          encoded.push({ camera, output });
        } catch (error) {
          controller.signal.throwIfAborted();
          failures[camera.id] = error instanceof Error ? error.message : "导出失败";
        }
      }
      controller.signal.throwIfAborted();
      setPhase("publishing");
      const takes: DirectorTake[] = [],
        success: string[] = [];
      for (const { camera, output } of encoded) {
        controller.signal.throwIfAborted();
        const stem = (prefix: string) =>
          `${prefix}_${camera.name}`.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").slice(0, 251);
        try {
          const result = await window.desktop.projects.attachDirectorTake({
            projectHandle,
            operationId: crypto.randomUUID(),
            name: stem(label),
            ...(output.png && { frameName: stem(`${label}_首帧`) }),
            ...output,
          });
          if (!result.ok) throw Error("预演素材写入失败，可以重试该机位");
          const [width, height] = camera.aspect.split(":").map(Number);
          takes.push({ ...result.value, cameraName: camera.name, aspect: width! / height! });
          success.push(camera.id);
        } catch (error) {
          failures[camera.id] = error instanceof Error ? error.message : "预演素材写入失败";
        }
      }
      controller.signal.throwIfAborted();
      if (takes.length) place(takes);
      for (const id of success) published.current.add(id);
      setErrors(failures);
      setPhase(Object.keys(failures).length ? "idle" : "done");
    } catch (error) {
      setMessage(
        controller.signal.aborted
          ? "已取消导出，已编码的内容已丢弃"
          : error instanceof Error
            ? error.message
            : "导出失败",
      );
      setPhase("idle");
      setProgress((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => published.current.has(id))),
      );
    } finally {
      job.current = undefined;
    }
  }
  return (
    <dialog
      ref={dialog}
      className="director-export-dialog"
      aria-label="导出运镜预览视频"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!running) close();
      }}
    >
      <div className="director-export-panel">
        <div className="director-export-heading">
          <h3>导出运镜预览视频</h3>
          {!running && (
            <button type="button" aria-label="关闭" title="关闭" onClick={close}>
              <X size={16} />
            </button>
          )}
        </div>
        <p>
          每个机位导出一段 MP4（H.264，24fps，{scene.duration.toFixed(1)}s，{total}{" "}
          帧），画面不带标签、网格和控件。 完成后在画布上导演台右侧新建节点并上传。
        </p>
        <div className="director-export-cameras">机位</div>
        {scene.cameras.map((camera) => {
          const on = ids.includes(camera.id),
            size = directorFrameSize(camera.aspect, longSide, longSide),
            frames = progress[camera.id];
          return (
            <div className="director-export-camera" data-checked={on} key={camera.id}>
              <label>
                <input
                  type="checkbox"
                  aria-label={camera.name}
                  checked={on}
                  disabled={locked}
                  onChange={() =>
                    setIds((current) =>
                      on ? current.filter((id) => id !== camera.id) : [...current, camera.id],
                    )
                  }
                />
                <span>
                  <strong>{camera.name}</strong>
                  <small>
                    {camera.aspect} · {size.width}×{size.height} ·{" "}
                    {camera.keys.length ? `${camera.keys.length} 个关键帧` : "固定机位"}
                  </small>
                  {frames !== undefined && (
                    <>
                      <progress value={frames} max={total} />
                      <small>
                        {errors[camera.id] ??
                          (frames >= total ? "完成" : `渲染 ${frames}/${total} 帧`)}
                      </small>
                    </>
                  )}
                </span>
              </label>
              {errors[camera.id] && !running && (
                <button type="button" onClick={() => void run([camera.id])}>
                  重试该机位
                </button>
              )}
            </div>
          );
        })}
        <div className="director-export-options">
          <strong>分辨率</strong>
          {([1280, 1920] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                checked={value === longSide}
                name="director-resolution"
                disabled={locked}
                onChange={() => setLongSide(value)}
              />
              {value === 1280 ? "720p" : "1080p"}
            </label>
          ))}
          <label>
            <input
              type="checkbox"
              checked={first}
              disabled={locked}
              onChange={(event) => setFirst(event.target.checked)}
            />
            同时导出首帧图
          </label>
        </div>
        <p className="director-export-estimate">
          {running
            ? "导出中，请保持页面在前台"
            : `预计约 ${estimate.toFixed(1)}MB（粗估）· 逐帧离线渲染，不依赖实时播放`}
        </p>
        {message && <p role="status">{message}</p>}
        <div className="director-export-actions">
          {running ? (
            <button
              type="button"
              disabled={phase === "publishing"}
              onClick={() => job.current?.abort()}
            >
              取消导出
            </button>
          ) : phase === "done" ? (
            <>
              <button type="button" onClick={back}>
                回到画布查看
              </button>
              <button type="button" onClick={close}>
                继续编辑
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={close}>
                {published.current.size ? "完成" : "取消"}
              </button>
              <button
                type="button"
                disabled={!chosen.some((camera) => !published.current.has(camera.id))}
                title={!chosen.length ? "至少选一台机位" : undefined}
                onClick={() => void run(ids)}
              >
                开始导出（{chosen.length}）
              </button>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
