import { expect, it } from "vitest";
import {
  canvasUploadKind,
  clipboardFileName,
} from "../../src/renderer/workspace/canvas-upload-file";
import { captureSelection, cloneSelection } from "../../src/renderer/workspace/selection-actions";
import {
  liveUploadFields,
  type UploadHistoryData,
} from "../../src/renderer/workspace/upload-history";
import { requireTestValue } from "../require-test-value";

it.each([
  ["image", "png", 20],
  ["video", "mp4", 200],
  ["audio", "wav", 50],
] as const)("%s 在大小上限可以入画布，多一个字节就拒绝", (kind, extension, limit) => {
  const file = { type: `${kind}/${extension}`, size: limit * 1024 * 1024 };
  expect(canvasUploadKind(file)).toEqual({ kind });
  expect(canvasUploadKind({ ...file, size: file.size + 1 })).toEqual({
    error: `文件超过 ${limit}MB，换个小点的`,
  });
});
it("拖入文件用 MIME 判型，不能把文本伪装成图", () => {
  expect(canvasUploadKind(new File(["abc"], "文档.png", { type: "text/plain" }))).toEqual({
    error: "只收图片、视频和音频，换个文件试试",
  });
});
it.each([
  ["", "image/jpeg", "粘贴图片.jpeg"],
  ["Image.PNG", "image/png", "粘贴图片.PNG"],
  ["第一帧.png", "image/png", "第一帧.png"],
  ["image.mp4", "video/mp4", "image.mp4"],
])("剪贴板命名沿用原扩展名，只重命名通用图片：%j", (name, type, expected) => {
  expect(clipboardFileName({ name, type })).toBe(expected);
});
it.each(["", "image", "application/octet-stream"])(
  "浏览器提供的 MIME %j 不得回退到扩展名",
  (type) => {
    expect(canvasUploadKind(new File([], "示例.png", { type }))).toHaveProperty("error");
  },
);
it("撤销时保留当前上传的结果，副本不带上传任务或重试权", () => {
  const pending: UploadHistoryData = {
    kind: "image",
    label: "旧名",
    text: "",
    uploaded: true,
    uploadPending: true,
  };
  const done: UploadHistoryData = {
    kind: "image",
    label: "新名",
    text: "",
    uploaded: true,
    assetId: "asset",
    mediaAspect: 0.5,
  };
  expect(liveUploadFields(pending, done)).toEqual({ ...done, label: "旧名" });
  for (const state of [pending, { ...pending, uploadFailed: true as const }, done]) {
    const graph = {
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{ id: "n", type: "creative" as const, position: { x: 0, y: 0 }, data: state }],
      edges: [],
    };
    const copy = cloneSelection(
      requireTestValue(captureSelection(graph, new Set(["n"]))),
      graph,
      () => "copy",
    ).nodes[0];
    expect(copy?.data).not.toHaveProperty("uploadPending");
    expect(copy?.data).not.toHaveProperty("uploadFailed");
    if (state === done) expect(copy?.data).toHaveProperty("assetId", "asset");
  }
});
