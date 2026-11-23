import { expect, it, vi } from "vitest";
import {
  proposeQuestions,
  proposeWorkspaceQuestions,
  resolveQuestions,
} from "../../packages/agent-runtime/src/questionnaire";

const original = "239fb76b-1532-4579-a00c-d78085198925";
const added = "27c0a3ce-0aee-4597-b400-bda742abc745";
const ask = { questions: [{ kind: "model", question: "使用哪个图片模型？", modelKind: "image" }] };

it("目录发生变化后按提问当时的可选模型验证并回显回答", async () => {
  const catalog = vi.fn().mockResolvedValue([{ id: original, kind: "image", name: "原模型" }]);
  const proposal = await proposeWorkspaceQuestions(ask, catalog);
  catalog.mockResolvedValue([{ id: added, kind: "image", name: "新模型" }]);
  const decide = (value: string) =>
    resolveQuestions(
      proposal.payload,
      {
        decision: "approve",
        answers: [{ id: "1", value }],
      },
      catalog,
    );
  await expect(decide(added)).rejects.toThrow("AGENT_ARGUMENT_INVALID");
  await expect(decide(original)).resolves.toMatchObject({
    decision: { answer: `原模型（模型 key：${original}）` },
  });
  expect(catalog).toHaveBeenCalledTimes(1);
});

it("指定种类没有已发布模型时，把原因交还模型并继续运行", async () => {
  const result = await proposeWorkspaceQuestions(ask, async () => [
    { id: original, kind: "video" },
  ]);
  expect(result).toMatchObject({
    is_error: true,
    terminate: false,
    content: "第 1 题：目前没有已发布的图片模型，请告诉用户需要管理员先配置。",
  });
  expect(result.payload).toBeUndefined();
});

it("兼容格式传入的模型列表不能覆盖工作区目录或短剧目录", async () => {
  const input = {
    questions: [
      {
        id: "1",
        kind: "model",
        label: "图片模型",
        modelKind: "image",
        models: [{ key: added, name: "传入模型" }],
      },
    ],
  };
  const result = await proposeWorkspaceQuestions(input, async () => [
    { id: original, kind: "image" },
  ]);
  expect(result.payload?.questions[0]?.models?.map((model) => model.key)).toEqual([original]);
  expect(() => proposeQuestions(input)).toThrow("AGENT_ARGUMENT_INVALID");
});
