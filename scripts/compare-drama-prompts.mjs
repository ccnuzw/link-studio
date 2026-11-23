import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const revision = "4277d16f40457664e27a89efabac14d07c1d73e8";
const reference = resolve(process.env.VIDEO_CANVAS_REFERENCE ?? "../video-canvas");
const runner = resolve(process.env.DRAMA_RUNNER ?? "out/provider-runtime/runner");
const dir = await mkdtemp(join(tmpdir(), "drama-prompt-reference-"));
const steps = ["breakdown", "asset_prompts", "storyboard", "plan"];
try {
  const archive = join(dir, "reference.tar");
  execFileSync("git", [
    "-C",
    reference,
    "archive",
    "-o",
    archive,
    revision,
    "backend/internal/drama",
  ]);
  execFileSync("tar", ["-xf", archive, "-C", dir]);
  await writeFile(join(dir, "go.mod"), "module parity\n\ngo 1.22\n");
  await writeFile(
    join(dir, "backend/main.go"),
    `package main
import("encoding/json";"os";"parity/backend/internal/drama")
type Sample struct{Step, Body string;Variables map[string]any};func main(){var samples []Sample;if err:=json.NewDecoder(os.Stdin).Decode(&samples);err!=nil{panic(err)};result:=[]string{};for _,test:=range samples{prompt,err:=drama.PromptWithBody(test.Step,test.Variables,test.Body);if err!=nil{panic(err)};result=append(result,prompt)};if err:=json.NewEncoder(os.Stdout).Encode(result);err!=nil{panic(err)}}`,
  );
  const cases = steps
    .flatMap((step) => [
      { Step: step, Body: "" },
      { Step: step, Body: "只保留蜡印\n## 另起一段\n拍摄 {{画面}}。" },
      { Step: step + "_format", Body: "" },
    ])
    .map((sample) => ({
      ...sample,
      Variables: { title: "来客", draft_md: "「门开了」\n下一行", episodes: [1, 2] },
    }));
  cases.push({
    Step: "analyze",
    Body: "",
    Variables: { title: "来客", source: "第一章\n门响了。" },
  });
  for (const Body of ["", "只用对白和场景提示。"])
    cases.push({
      Step: "scripts",
      Body,
      Variables: {
        episode: { no: 2 },
        previous_ending: "门开了。",
        source: "## [2] 第二章\n来客敲门。\n",
      },
    });
  const expected = JSON.parse(
    execFileSync("go", ["run", "./backend"], { cwd: dir, input: JSON.stringify(cases) }),
  );
  function render(args) {
    return JSON.parse(
      execFileSync(runner, [], {
        input: JSON.stringify({ source: "", hook: "dramaAssetPrompt", args }),
      }),
    );
  }
  for (const [index, sample] of cases.entries()) {
    const result = render([sample.Step, sample.Variables, ...(sample.Body ? [sample.Body] : [])]);
    assert.equal(result.ok, true);
    assert.equal(result.result, expected[index], sample.Step);
  }
  for (const step of steps)
    assert.equal(render([step + "_format", {}, "不能替换"]).code, "AGENT_ARGUMENT_INVALID");
  function validate(episodes) {
    const args = [
      "plan_format",
      JSON.stringify({
        episodes: episodes.map(([from, to]) => ({
          title: "来客",
          synopsis: "雨夜来信",
          hook: "谁在敲门",
          cliffhanger: "门开了",
          unit_from: from,
          unit_to: to,
        })),
      }),
      { unit_from: 3, unit_to: 5 },
    ];
    return JSON.parse(
      execFileSync(runner, [], {
        input: JSON.stringify({ source: "", hook: "dramaAssetOutput", args }),
      }),
    );
  }
  assert.equal(
    validate([
      [3, 3],
      [3, 4],
      [5, 5],
    ]).ok,
    true,
  );
  for (const ranges of [
    [
      [3, 3],
      [5, 5],
    ],
    [[3, 4]],
    [[2, 5]],
    [[3, 6]],
  ])
    assert.match(validate(ranges).code, /模型输出无法解析/);
  console.log(
    `${revision}: ${cases.length} 份完整请求与固定版 Go 逐字一致，${steps.length} 个格式化覆盖均被拒绝，5 组规划覆盖校验通过`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
