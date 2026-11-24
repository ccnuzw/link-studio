import type { exportVideoCanvas } from "@link-studio/core";

export async function runCanvasExport(
  input: Parameters<typeof exportVideoCanvas>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const worker = new Worker(new URL("./canvas-export.worker.ts", import.meta.url), {
    type: "module",
  });
  let abort: (() => void) | undefined;
  try {
    return await new Promise<ReturnType<typeof exportVideoCanvas>>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      worker.onerror = worker.onmessageerror = () => reject(new Error("无法生成交换文件"));
      worker.onmessage = ({ data }) =>
        data.result ? resolve(data.result) : reject(new Error(data.error));
      worker.postMessage(input);
    });
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    worker.terminate();
  }
}
