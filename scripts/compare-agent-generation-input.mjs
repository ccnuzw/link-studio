import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";

const repo = resolve(process.env.VIDEO_CANVAS_REPO ?? "../video-canvas");
const commit = "ccffac4e2f628c2b3a3655cafeffd4b38524ab22";
const git = (...args) => execFileSync("git", ["-C", repo, ...args]);
const scratch = await mkdtemp(join(tmpdir(), "canvas-agent-go-"));
const desktop = await createServer({
  configFile: false,
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true },
});
try {
  const dirs = [
    "internal/agent/canvasgraph",
    "internal/provider/modelcfg",
    "internal/storyboard/storyboard.go",
  ];
  const archive = git("archive", `${commit}:backend`, "go.mod", "go.sum", ...dirs);
  execFileSync("tar", ["-x", "-C", scratch], { input: archive });
  const generate = git("show", `${commit}:backend/internal/service/agent/generate.go`).toString();
  const routines = ["buildGenInput", "pickOp"].map((name) => {
    const body = generate.match(new RegExp(`^func ${name}\\([\\s\\S]+?^\\}`, "m"));
    assert(body, name);
    return body[0];
  });
  await mkdir(join(scratch, "cmd", "audit"), { recursive: true });
  await writeFile(
    join(scratch, "cmd", "audit", "main.go"),
    `package main
import ("encoding/json";"fmt";"os";"slices";"video-canvas/internal/agent/canvasgraph";"video-canvas/internal/provider/modelcfg")
${routines.join("\n")}
func main(){var cases []struct{Graph json.RawMessage;Caps modelcfg.Capabilities};if err:=json.NewDecoder(os.Stdin).Decode(&cases);err!=nil{panic(err)}; out:=[]any{};for _,c:=range cases{g,err:=canvasgraph.Parse(c.Graph);if err!=nil{panic(err)};src,err:=canvasgraph.Generation(g,"target");if err!=nil{panic(err)};name:=fmt.Sprintf("节点 %q（%s）",src.NodeID,src.Label);input,err:=buildGenInput(c.Caps,src);if err!=nil{out=append(out,map[string]any{"error":name+"："+err.Error()});continue}; normalized,errs:=modelcfg.ValidateInput(src.Kind,c.Caps,input);if len(errs)>0{out=append(out,map[string]any{"error":name+"的参数不合法："+modelcfg.JoinFieldErrors(errs)+"。请用 canvas_apply_ops 修正后再申请。"});continue};out=append(out,normalized)};if err:=json.NewEncoder(os.Stdout).Encode(out);err!=nil{panic(err)}}`,
  );
  const { nodeGenerationInput } = await desktop.ssrLoadModule(
    "/src/main/project/canvas-agent-generation.ts",
  );
  const { providerInput } = await desktop.ssrLoadModule(
    "/packages/link-studio-core/src/provider-input.ts",
  );
  const { configuredGenerationInput } = await desktop.ssrLoadModule(
    "/packages/link-studio-core/src/media-generation.ts",
  );
  const fixtures = [];
  const asset = (id, kind = "image") => ({
    id: `src-${id}`,
    kind,
    assetId: id,
    label: `素材${id}`,
  });
  const role = (name, avatar, extras, voice) => ({
    id: name,
    kind: "character",
    label: name,
    assetId: avatar,
    character: {
      name,
      extras: extras.map((assetId) => ({ assetId })),
      ...(voice && { voice: { mode: "audio", assetId: voice } }),
    },
  });
  const hero = role("甲", "1", ["2", "3"], "7"),
    guest = role("乙", "4", ["5"], "8");
  const script = {
    id: "text",
    kind: "script",
    label: "剧本",
    text: "#[武侠江湖](style/wuxia) @[角色](甲)",
  };
  const assets = Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => {
      const assetId = String(index + 1);
      return [
        assetId,
        {
          assetId,
          mediaType: index < 6 ? "image" : index < 8 ? "audio" : "video",
          availability: "ready",
        },
      ];
    }),
  );
  for (const mode of ["omni", "i2v", "t2v", "auto", "i2i"])
    for (const max of [1, 2])
      for (const sound of [false, true])
        for (const [nodes, manual, typed] of [
          [[], []],
          [[hero, guest], []],
          [[hero, asset("6")], ["2"]],
          [[hero, asset("7", "audio"), script], ["1"]],
          [[asset("1"), asset("2"), hero, guest], ["3"]],
          [[role("甲", undefined, [], "7"), asset("1"), asset("2")], []],
          [
            [asset("9", "video"), role("甲", "4", ["3"])],
            ["6", "2"],
          ],
          [[script, role("甲", "1", ["2"])], []],
          [[], ["1"]],
          [
            [asset("2"), asset("2"), script],
            ["4", "2"],
          ],
          [[hero, asset("8", "audio")], []],
          [[], [], ""],
          [[], [], "🎬".repeat(51)],
          [[script], [], ""],
        ]) {
          const kind = ["auto", "i2i"].includes(mode) ? "image" : "video";
          const ops = mode === "auto" ? ["t2i", "i2i"] : [mode];
          const counts = {
            image: max,
            audio: mode === "omni" ? 1 : 0,
            video: mode === "omni" ? 1 : 0,
          };
          const refs = Object.fromEntries(
            Object.entries(counts).map(([key, max]) => [
              key,
              { on: max > 0, max, max_mb: 10, mb: 10 },
            ]),
          );
          const field = { open: false, default: sound, type: "boolean", label: "声音" };
          const caps = {
            ops,
            refs,
            prompt: { max_length: 50 },
            params: kind === "video" ? { generate_audio: field } : {},
          };
          const prompt =
            typed ?? "#[武侠江湖](style/wuxia) @[旧名](node:甲) @[剧本](text) @[旧图](src-2)";
          if (typed === undefined) caps.prompt.max_length = 5000;
          const params = {
            prompt,
            ...(mode !== "auto" && { op: mode }),
            ...Object.fromEntries(
              ["image", "audio", "video"].map((kind) => [
                `${kind}s`,
                manual.filter((id) => assets[id].mediaType === kind),
              ]),
            ),
          };
          const edges = nodes.map(({ id }, index) => ({
            id: `edge-${index}`,
            source: id,
            target: "target",
          }));
          const unique = [...new Map(nodes.map((node) => [node.id, node])).values()];
          const graph = {
            nodes: [
              ...unique.map((node) => ({ id: node.id, type: "canvas", data: node })),
              { id: "target", type: "canvas", data: { kind, label: "目标", params } },
            ],
            edges,
          };
          const data = {
            kind,
            label: "目标",
            text: prompt,
            manualReferenceIds: manual,
            generation: { providerId: "model" },
            ...(kind === "video" && { videoMode: mode }),
          };
          const local = {
            nodes: [
              ...unique.map((node) => ({
                id: node.id,
                type: "creative",
                data: {
                  ...node,
                  text: node.text ?? "",
                  ...(node.character && {
                    kind: "image",
                    character: {
                      name: node.character.name,
                      extraAssetIds: node.character.extras.map((extra) => extra.assetId),
                      voice: node.character.voice,
                    },
                  }),
                },
              })),
              { id: "target", type: "creative", data },
            ],
            edges,
          };
          const settings = {
            plugins: [
              {
                key: kind === "image" ? "openai-image" : "doubao-video",
                hash: "adapter",
                origin: "builtin",
                kind,
              },
            ],
            providers: [
              {
                id: "model",
                model: kind === "image" ? "gpt-image-1" : "doubao-seedance-2-0",
                pluginHash: "adapter",
                enabled: true,
                config: {
                  kind,
                  modes: ops,
                  refs,
                  promptLimit: caps.prompt.max_length,
                  ...(kind === "video" && { generateAudio: field }),
                },
              },
            ],
          };
          let result;
          try {
            const input = nodeGenerationInput(local, 1, "target", assets, settings, []);
            const model = settings.providers[0].config;
            const refs = Object.fromEntries(
              ["image", "audio", "video"].map((kind) => [
                `${kind}s`,
                input.referenceAssetIds.filter((id) => assets[id].mediaType === kind).map(Number),
              ]),
            );
            const wire = providerInput(
              kind,
              settings.plugins[0].key,
              configuredGenerationInput(model, input),
              model,
              refs,
            );
            result = Object.fromEntries(
              Object.entries(wire).filter(
                ([, value]) => value !== undefined && (!Array.isArray(value) || value.length),
              ),
            );
          } catch (error) {
            assert.equal(error.name, "ProjectError");
            result = { error: error.message };
          }
          fixtures.push({ graph, caps, result });
        }
  const expected = JSON.parse(
    execFileSync("go", ["run", "./cmd/audit"], {
      cwd: scratch,
      env: { ...process.env, GOWORK: "off", GOPROXY: "off" },
      maxBuffer: 8 * 1024 * 1024,
      input: JSON.stringify(fixtures.map(({ graph, caps }) => ({ graph, caps }))),
    }),
  );
  assert.equal(expected.length, fixtures.length);
  fixtures.forEach(({ result, graph, caps }, index) => {
    assert.deepEqual(result, expected[index], JSON.stringify({ graph, caps, index }));
  });
  console.log(`固定版 Go 与桌面助手 ${fixtures.length} 组生成输入/首错误一致`);
} finally {
  await desktop.close();
  await rm(scratch, { recursive: true, force: true });
}
