import { expect, test } from "vitest";
import { groupDropTargets } from "../../src/renderer/workspace/group-drop";

const back = { id: "back", type: "group", position: { x: 40, y: 60 }, width: 300, height: 200 };
const front = { ...back, id: "front", position: { x: 100, y: 80 }, width: 120, height: 90 };
const member = { id: "member", type: "creative", position: { x: 0, y: 0 }, width: 40, height: 20 };

test("重叠组以实时中心判定，右下边界包含在组内", () => {
  const nodes = [back, front, member];
  const dragged = { ...member, parentId: back.id, position: { x: 160, y: 100 } };
  expect(groupDropTargets(nodes, [dragged]).get(member.id)).toEqual({
    parentId: front.id,
    position: { x: 100, y: 80 },
  });
  expect(
    groupDropTargets(nodes, [{ ...dragged, position: { x: 161, y: 100 } }]).get(member.id)
      ?.parentId,
  ).toBe(back.id);
});

test("多选成员分别进出组，整组拖动保留成员关系并忽略旁观节点", () => {
  const leaving = { ...member, id: "leaving", parentId: back.id, position: { x: 420, y: 150 } };
  const entering = { ...member, position: { x: 105, y: 90 } };
  const bystander = { ...entering, id: "still" };
  const nodes = [back, front, leaving, entering, bystander];
  expect([...groupDropTargets(nodes, [entering, leaving])]).toEqual([
    [member.id, { parentId: front.id, position: { x: 5, y: 10 } }],
    [leaving.id, { parentId: undefined, position: { x: 460, y: 210 } }],
  ]);
  expect([...groupDropTargets(nodes, [front, entering, back, leaving])]).toEqual([
    [member.id, { parentId: undefined, position: entering.position }],
  ]);
});
