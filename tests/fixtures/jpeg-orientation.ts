export function orientedJpeg(image: Buffer, orientation: number, little = false) {
  const data = Buffer.alloc(36);
  data.writeUInt16BE(0xffe1);
  data.writeUInt16BE(34, 2);
  data.write("Exif\0\0", 4);
  const tiff = data.subarray(10);
  tiff.write(little ? "II" : "MM");
  const short = little ? tiff.writeUInt16LE.bind(tiff) : tiff.writeUInt16BE.bind(tiff);
  const long = little ? tiff.writeUInt32LE.bind(tiff) : tiff.writeUInt32BE.bind(tiff);
  short(42, 2);
  long(8, 4);
  short(1, 8);
  short(0x0112, 10);
  short(3, 12);
  long(1, 14);
  short(orientation, 18);
  return Buffer.concat([image.subarray(0, 2), data, image.subarray(2)]);
}
