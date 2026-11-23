import type { CreativeData } from "@link-studio/core";

export type LinkKind = CreativeData["kind"] | "storyboard" | "director" | "character";

const downstream: Record<LinkKind, readonly LinkKind[]> = {
  script: ["image", "video", "audio", "storyboard"],
  image: ["image", "video", "audio"],
  video: ["video"],
  audio: ["video"],
  character: ["image", "video"],
  storyboard: ["image", "video"],
  director: [],
};

export function linkKind(data: CreativeData): LinkKind {
  if (data.director) return "director";
  if (data.storyboard) return "storyboard";
  if (data.character) return "character";
  return data.kind;
}

export function canLinkKinds(source: LinkKind, target: LinkKind) {
  return downstream[source].includes(target);
}

type Body = { id: string; type?: string };
type Point = { x: number; y: number };
type Rect = Point & { width?: number; height?: number };

export function linkBodyAt(
  nodes: readonly Body[],
  originId: string,
  point: Point,
  bounds: (id: string) => Rect | undefined,
  accepts: (id: string) => boolean,
) {
  return nodes.findLast((node) => {
    if (node.type !== "creative" || node.id === originId) return false;
    const rect = bounds(node.id);
    return (
      !!rect?.width &&
      !!rect.height &&
      point.x >= rect.x &&
      point.y >= rect.y &&
      point.x <= rect.x + rect.width &&
      point.y <= rect.y + rect.height &&
      accepts(node.id)
    );
  })?.id;
}
