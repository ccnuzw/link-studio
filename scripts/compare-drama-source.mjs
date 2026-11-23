import { deepStrictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  dramaKindSample,
  importPastedDrama,
  novelAnalysisSample,
  novelPlanningBatches,
  preflightDramaSource,
} from "../src/main/project/drama-source.ts";

const revision = "4277d16f40457664e27a89efabac14d07c1d73e8";
const reference = resolve(process.env.VIDEO_CANVAS_REFERENCE ?? "../video-canvas");
const cache = resolve(".cache/drama-reference");
await mkdir(cache, { recursive: true });
const workspace = await mkdtemp(join(cache, "source-"));
const archive = join(workspace, "reference.tar");
execFileSync("git", [
  "-C",
  reference,
  "archive",
  "-o",
  archive,
  revision,
  "backend/internal/drama",
]);
execFileSync("tar", ["-xf", archive, "-C", workspace]);
await writeFile(join(workspace, "go.mod"), "module parity\n\ngo 1.22\n");
await writeFile(
  join(workspace, "backend/main.go"),
  `package main
import ("crypto/sha256"; "encoding/hex"; "encoding/json"; "os"; "strings"; "unicode/utf8"; "parity/backend/internal/drama")
type Sample struct { Raw, Kind, Hook string; Seconds, End, Budget int; Analyze bool }
func parse(sample Sample) any {
  switch sample.Hook {
  case "longSource":
    prefix:="第一章 来信\\n";tail:="\\n第二章 归家\\n终";raw:=prefix+strings.Repeat("🌙",sample.End-utf8.RuneCountInString(prefix+tail))+tail
    source,err:=drama.ParseSource("长稿.txt",[]byte(raw));if err!=nil{return err.Error()}; parsed:=drama.Preflight(source,"novel");units:=[]any{}
    for _,unit:=range parsed.Units {digest:=sha256.Sum256([]byte(unit.Text));units=append(units,[]any{unit.Title,unit.Chars,hex.EncodeToString(digest[:])})};return units
  case "dramaKindPrompt": return drama.KindPrompt(drama.KindSample(sample.Raw))
  case "dramaKindGuess": kind,reason,ok:=drama.ParseKindGuess(sample.Raw);if !ok{return nil};return map[string]string{"kind":kind,"reason":reason}
  }
  source,err := drama.ParseSource("paste.txt",[]byte(sample.Raw)); if err!=nil {return nil}
  parsed := drama.Preflight(source,sample.Kind); if len(parsed.Units)==0 {return nil}
  if sample.Analyze {return drama.Sample(parsed.Units,sample.Budget)}
  units := []any{}
  for _,unit:=range parsed.Units {units=append(units,map[string]any{"kind":unit.Kind,"title":unit.Title,"text":unit.Text})}
  if sample.Budget > 0 {
    end:=sample.End;if end==0 {end=len(units)}; if end>len(units){return nil}; batches:=[]any{}
    for cursor:=0;cursor<end; { batch,err:=drama.NextBatch(parsed.Units,cursor,end,sample.Budget); if err!=nil{return nil}; text:=drama.UnitSource(batch); cursor=batch[len(batch)-1].No; batches=append(batches,map[string]any{"from":batch[0].No,"to":cursor,"source":text,"chars":utf8.RuneCountInString(text)}) }
    return map[string]any{"units":units,"guess":parsed.KindGuess,"batches":batches}
  }
  episodes := []any{}
  for index, episode := range drama.ScriptEpisodes(parsed.Units,sample.Seconds) {
    episodes=append(episodes,map[string]any{"episode_no":index+1,"title":episode.Title,"synopsis":"","script_md":episode.ScriptMD,"unit_from":episode.UnitFrom,"unit_to":episode.UnitTo,"revision":1})
  }
  return map[string]any{"units":units,"episodes":episodes,"issues":parsed.Issues,"kindGuess":parsed.KindGuess,"kindSignals":parsed.KindSignals,"source":map[string]any{"text":parsed.Text,"kind":parsed.UnitKind,"total":len(parsed.Units),"chars":utf8.RuneCountInString(source)}}
}
func main(){ var samples []Sample; if err:=json.NewDecoder(os.Stdin).Decode(&samples);err!=nil {panic(err)}; results:=[]any{};for _,sample:=range samples{results=append(results,parse(sample))};if err:=json.NewEncoder(os.Stdout).Encode(results);err!=nil{panic(err)} }
`,
);
const scripts = [
  "开门",
  "\uFEFF序言\r\n第一集 来信\r\n场景：客厅\r\n拆信\r\n本章完\r\n第二集 回家\r\n再见",
  `场景：入口\n${"🌳".repeat(850)}\n夜·大厅\n${"灯".repeat(450)}\n内景：卧室\n落幕`,
  `第一章 走廊\n${"星".repeat(12001)}\n第二章 回声\n终`,
  `开场\n${"风".repeat(10050)}`,
  "第十集\n\n第十一集 留白\n没有台词",
  "求月票\n本章完",
  "台词\u0000",
  "\u0085门响了\u0085",
  "空白\n\ufeff第一集\n白天\n第二集\n傍晚",
  "结尾\ufeff",
  "第一集 进门\n场景：大厅\u2028回声\n第二集 熄灯\n夜／街道",
  "第一集 来客\n门响\n求月票\n第十集 空\n第一集 来客\n门开\n本章完",
  `第一集 长集\n${"风".repeat(40001)}\n第二集 落幕\n终`,
  "第一集\n阿金（低声）：开门\nSam: Hello\n第二集\n“他来过。”",
];
const samples = scripts.flatMap((raw) =>
  [30, 60, 180].map((seconds) => ({ raw, seconds, kind: "script" })),
);
for (const count of [200, 201, 1001])
  samples.push({
    raw: Array.from(
      { length: count },
      (_, index) => `第${index + 1}集 夜归\n灯火${index + 1}。`,
    ).join("\n"),
    seconds: 60,
    kind: "script",
  });
const expected = JSON.parse(
  execFileSync("go", ["run", "./backend"], {
    cwd: workspace,
    input: JSON.stringify(samples),
    maxBuffer: 4 * 1024 * 1024,
  }),
);
for (const [index, sample] of samples.entries()) {
  let actual;
  try {
    actual = importPastedDrama(sample.raw, sample.seconds);
  } catch (error) {
    if (error.code !== "VALIDATION_FAILED") throw error;
    actual = null;
  }
  deepStrictEqual(actual, expected[index], `剧本样例 ${index + 1}`);
}
console.log(`${revision}: ${samples.length} 个粘贴剧本与 Go 基线一致`);
const longSources = [24_001, 5_000_000, 5_000_001].map((end) => ({ hook: "longSource", end }));
const longExpected = JSON.parse(
  execFileSync("go", ["run", "./backend"], { cwd: workspace, input: JSON.stringify(longSources) }),
);
for (const [index, { end }] of longSources.entries()) {
  const prefix = "第一章 来信\n",
    tail = "\n第二章 归家\n终";
  const text = prefix + "🌙".repeat(end - [...(prefix + tail)].length) + tail;
  let actual;
  try {
    actual = preflightDramaSource(text, "novel").units.map((unit) => [
      unit.title,
      [...unit.text].length,
      createHash("sha256").update(unit.text).digest("hex"),
    ]);
  } catch (error) {
    if (error.code !== "VALIDATION_FAILED") throw error;
    actual = error.message;
  }
  deepStrictEqual(actual, longExpected[index], `长稿边界 ${end}`);
  console.log(
    `${end} 码点：${Array.isArray(actual) ? `${actual.length} 单元标题、字数、正文哈希一致` : actual}`,
  );
}
const chapters = Array.from(
  { length: 25 },
  (_, index) => `第${index + 1}章 来信\n${"🌙".repeat(200)}`,
).join("\n");
const checks = [
  ...scripts,
  chapters,
  "场景：入门\n场景：天晴\n外景：河流\n第一章\n雨\n第二章\n云",
  "“开门。”\n雨落了。",
].flatMap((raw) =>
  ["novel", ""].flatMap((kind) => [0, 1].map((end) => ({ raw, kind, end, budget: 3808 }))),
);
const baseline = JSON.parse(
  execFileSync("go", ["run", "./backend"], {
    cwd: workspace,
    input: JSON.stringify(checks),
    maxBuffer: 12 * 1024 * 1024,
  }),
);
for (const [index, sample] of checks.entries()) {
  let actual;
  try {
    const parsed = preflightDramaSource(sample.raw, sample.kind || undefined);
    actual = {
      units: parsed.units,
      guess: parsed.kindGuess,
      batches: novelPlanningBatches(parsed.units, sample.end || parsed.units.length),
    };
  } catch (error) {
    if (!["VALIDATION_FAILED", "DRAMA_CONTEXT"].includes(error.code)) throw error;
    actual = null;
  }
  deepStrictEqual(actual, baseline[index], `原文识别与规划批次 ${index + 1}`);
}
console.log(`${checks.length} 组原文识别、完整单元及规划批次与 Go 基线一致`);
const readings = [chapters, "第一章\n" + "🌙".repeat(12001) + "\n第二章\n回家"].flatMap((raw) =>
  [0, 1, 13, 200, 3808, 12000, 80000].map((budget) => ({
    raw,
    kind: "novel",
    analyze: true,
    budget,
  })),
);
const readingsExpected = JSON.parse(
  execFileSync("go", ["run", "./backend"], { cwd: workspace, input: JSON.stringify(readings) }),
);
for (const [index, reading] of readings.entries()) {
  deepStrictEqual(
    novelAnalysisSample(preflightDramaSource(reading.raw, "novel").units, reading.budget),
    readingsExpected[index],
  );
}
console.log(`${readings.length} 组研读抽样正文与 Go 基线逐字一致`);
const alphabet = [..."甲🌙e\u0301乙。"];
const kindInputs = [
  "",
  "\u0085  一封信。 \u3000",
  ...[3999, 4000, 4001, 6000].map((size) =>
    Array.from({ length: size }, (_, index) => alphabet[index % alphabet.length]).join(""),
  ),
];
const kindReplies = [
  "{}",
  "无法判断",
  '{"kind":"poem"}',
  '{"kind":1}',
  '{"kind":"script","reason":[]}',
  '说明：{"kind":" novel ","reason":"  叙述  "} 完毕',
  '```json\n{"kind":"script"}\n```',
  JSON.stringify({ kind: "novel", reason: "🌙".repeat(61) }),
];
const guesses = [
  ...kindInputs.map((raw) => ({ hook: "dramaKindPrompt", raw })),
  ...kindReplies.map((raw) => ({ hook: "dramaKindGuess", raw })),
];
const guessesExpected = JSON.parse(
  execFileSync("go", ["run", "./backend"], { cwd: workspace, input: JSON.stringify(guesses) }),
);
for (const [index, { hook, raw }] of guesses.entries()) {
  const reply = JSON.parse(
    execFileSync(process.env.DRAMA_DESKTOP_RUNNER ?? resolve("out/provider-runtime/runner"), [], {
      input: JSON.stringify({
        source: "",
        hook,
        args: [hook === "dramaKindPrompt" ? dramaKindSample(raw) : raw],
      }),
    }),
  );
  deepStrictEqual(reply.ok, true, `${hook} ${index + 1}: ${reply.code}`);
  deepStrictEqual(reply.result, guessesExpected[index], `${hook} ${index + 1}`);
}
console.log(
  `${kindInputs.length} 组体裁请求逐字一致，${kindReplies.length} 组模型回复与 Go 基线解析一致`,
);
