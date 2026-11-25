import type { ProjectAsset } from "@link-studio/core";
import { requirePresent } from "@link-studio/core";
import type { Rect } from "./alignment";
import { imageFrameSize } from "./grid-placement";

export type DirectorTake = {
  cameraName: string;
  aspect: number;
  assets: ProjectAsset[];
  revision: number;
};

export function positionDirectorTakes(
  origin: Rect,
  occupied: Rect[],
  names: Iterable<string>,
  title: string,
  takes: DirectorTake[],
) {
  const taken = [...occupied],
    labels = new Set(names);
  return takes.flatMap((take) =>
    take.assets.map((asset) => {
      const base = `${title}·${take.cameraName}${asset.mediaType === "image" ? "·首帧" : ""}`.slice(
        0,
        248,
      );
      let label = base;
      for (let index = 2; labels.has(label); index++) label = `${base} ${index}`;
      labels.add(label);
      const size = requirePresent(imageFrameSize(take.aspect, 1), "imageFrameSize(take.aspect, 1)");
      const x = origin.x + origin.width + 80;
      let y = origin.y + (origin.height - size.height) / 2;
      for (
        let step = 0;
        step < 60 &&
        taken.some(
          (box) =>
            x < box.x + box.width + 40 &&
            box.x < x + size.width + 40 &&
            y < box.y + box.height + 40 &&
            box.y < y + size.height + 40,
        );
        step++
      )
        y += size.height + 40;
      taken.push({ x, y, ...size });
      return {
        id: crypto.randomUUID(),
        type: "creative" as const,
        position: { x, y },
        data: {
          label,
          kind: asset.mediaType === "video" ? ("video" as const) : ("image" as const),
          text: "",
          assetId: asset.assetId,
          mediaAspect: take.aspect,
          uploaded: true as const,
        },
      };
    }),
  );
}
