type Point = { x: number; y: number };
type Member = {
  id: string;
  type?: string;
  parentId?: string;
  position: Point;
  measured?: { width?: number; height?: number };
  width?: number;
  height?: number;
};

export function groupDropTargets(nodes: Member[], dragged: Member[]) {
  const moving = new Map(dragged.map((node) => [node.id, node]));
  const groups = nodes.filter((node) => node.type === "group");
  const origins = new Map(
    groups.map((group) => [group.id, (moving.get(group.id) ?? group).position]),
  );
  const eligible = groups.filter((group) => !moving.has(group.id)).reverse();
  const targets = new Map<string, { parentId?: string; position: Point }>();
  for (const member of dragged) {
    if (member.type !== "creative" || (member.parentId && moving.has(member.parentId))) continue;
    const origin = member.parentId ? origins.get(member.parentId) : undefined;
    const x = member.position.x + (origin?.x ?? 0);
    const y = member.position.y + (origin?.y ?? 0);
    const centerX = x + (member.measured?.width ?? member.width ?? 576) / 2;
    const centerY = y + (member.measured?.height ?? member.height ?? 324) / 2;
    const parent = eligible.find(
      (group) =>
        centerX >= group.position.x &&
        centerY >= group.position.y &&
        centerX <= group.position.x + (group.width ?? group.measured?.width ?? 200) &&
        centerY <= group.position.y + (group.height ?? group.measured?.height ?? 140),
    );
    targets.set(member.id, {
      parentId: parent?.id,
      position: { x: x - (parent?.position.x ?? 0), y: y - (parent?.position.y ?? 0) },
    });
  }
  return targets;
}
