export function directorAspectRatio(ratio: string) {
  const [width = 16, height = 9] = ratio.split(":").map(Number);
  return width / height;
}
export function directorFrameSize(ratio: string, maxWidth = 900, maxHeight = 500) {
  const aspect = directorAspectRatio(ratio);
  return {
    width: Math.round(Math.min(maxWidth, maxHeight * aspect) / 2) * 2,
    height: Math.round(Math.min(maxWidth / aspect, maxHeight) / 2) * 2,
  };
}
