import { exportVideoCanvas } from "@link-studio/core";

self.onmessage = ({ data }: MessageEvent<Parameters<typeof exportVideoCanvas>>) => {
  try {
    self.postMessage({ result: exportVideoCanvas(...data) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "画布导出失败" });
  }
};
