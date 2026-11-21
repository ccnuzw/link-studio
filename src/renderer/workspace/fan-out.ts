type Point = { x: number; y: number };

type FanOutNode = {
  id: string;
  position: Point;
  parentId?: string;
  measured?: { width?: number; height?: number };
};

export function fanOutTargetPosition(
  nodes: readonly FanOutNode[],
  groups: ReadonlyMap<string, Point>,
  targetSize = { width: 280, height: 200 },
  gap = 360,
) {
  if (!nodes.length) return undefined;
  const absolute = nodes.map((node) => ({
    x: node.position.x + (node.parentId ? (groups.get(node.parentId)?.x ?? 0) : 0),
    y: node.position.y + (node.parentId ? (groups.get(node.parentId)?.y ?? 0) : 0),
    width: node.measured?.width ?? targetSize.width,
    height: node.measured?.height ?? targetSize.height,
  }));
  const right = Math.max(...absolute.map(({ x, width }) => x + width));
  const center = absolute.reduce((sum, { y, height }) => sum + y + height / 2, 0) / absolute.length;
  return { x: right + gap, y: center - targetSize.height / 2 };
}
