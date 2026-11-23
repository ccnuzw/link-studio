import { expect, it } from "vitest";
import { jpegDimensions } from "../../src/main/project/jpeg-dimensions";
import { orientedJpeg } from "../fixtures/jpeg-orientation";

const frame = Buffer.from("ffd8ffc0000b080020004001011100ffd9", "hex");

it.each([true, false])("读取 IFD0 主图方向，支持小端／大端字节序 %j", (little) => {
  for (let orientation = 1; orientation <= 8; orientation++) {
    expect(jpegDimensions(orientedJpeg(frame, orientation, little))).toEqual({
      width: 64,
      height: 32,
      orientation,
    });
  }
});

it("方向字段越界、类型错误或超出枚举时沿用编码方向", () => {
  const badOffset = orientedJpeg(frame, 6);
  badOffset.writeUInt32BE(0xfffffff0, 16);
  const badType = orientedJpeg(frame, 6);
  badType.writeUInt16BE(4, 24);
  for (const image of [frame, badOffset, badType, orientedJpeg(frame, 9)]) {
    expect(jpegDimensions(image)).toEqual({ width: 64, height: 32, orientation: 1 });
  }
});

it("跳过大于旧 64 KiB 探测窗口的相机元数据，再读取主图尺寸和方向", () => {
  const image = orientedJpeg(frame, 8);
  const app = Buffer.alloc(65537);
  app.writeUInt16BE(0xffe2);
  app.writeUInt16BE(65535, 2);
  expect(jpegDimensions(Buffer.concat([image.subarray(0, 2), app, image.subarray(2)]))).toEqual({
    width: 64,
    height: 32,
    orientation: 8,
  });
});
