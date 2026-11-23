const frameMarkers = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
export const jpegHeaderLimit = 4 * 1024 * 1024;

function exifOrientation(segment: Buffer) {
  if (segment.length < 14 || !segment.subarray(0, 6).equals(Buffer.from("Exif\0\0"))) return;
  const tiff = segment.subarray(6);
  const little = tiff.readUInt16BE(0) === 0x4949;
  if (!little && tiff.readUInt16BE(0) !== 0x4d4d) return;
  const short = (offset: number) =>
    little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset);
  const long = (offset: number) => (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));
  if (short(2) !== 42) return;
  const directory = long(4);
  if (directory < 8 || directory + 2 > tiff.length) return;
  const entries = short(directory);
  for (let index = 0; index < entries; index++) {
    const entry = directory + 2 + 12 * index;
    if (entry + 12 > tiff.length) return;
    if (short(entry) === 0x0112 && short(entry + 2) === 3 && long(entry + 4) === 1) {
      const orientation = short(entry + 8);
      if (orientation >= 1 && orientation <= 8) return orientation;
    }
  }
}

export function jpegDimensions(header: Buffer) {
  if (header.length < 4 || header.readUInt16BE(0) !== 0xffd8) return;
  let offset = 2;
  let width = 0;
  let height = 0;
  let orientation: number | undefined;
  while (offset + 4 <= header.length && header[offset++] === 0xff) {
    while (offset < header.length && header[offset] === 0xff) offset++;
    const marker = header[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9 || offset + 2 > header.length)
      break;
    const length = header.readUInt16BE(offset);
    if (length < 2 || offset + length > header.length) break;
    if (frameMarkers.has(marker) && length >= 8) {
      height = header.readUInt16BE(offset + 3);
      width = header.readUInt16BE(offset + 5);
    } else if (marker === 0xe1 && orientation === undefined) {
      orientation = exifOrientation(header.subarray(offset + 2, offset + length));
    }
    offset += length;
  }
  if (width && height) return { width, height, orientation: orientation ?? 1 };
}
