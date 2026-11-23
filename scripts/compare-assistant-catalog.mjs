import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canvasUserMessage } from "../packages/agent-runtime/src/canvas-user-message.ts";
import { agentCanvasCatalog } from "../src/main/project/canvas-agent-catalog.ts";

const root = path.resolve(import.meta.dirname, "..");
const reference = path.resolve(
  process.env.AGENT_REFERENCE_WEB ?? path.join(root, "../video-canvas/web"),
  "..",
);
const revision = "ff4070c7b23581b1a79eacbfeddc56f836562377";
const directory = await mkdtemp(path.join(tmpdir(), "link-agent-catalog-"));
const backend = path.join(directory, "backend");
const group = { id: "g", type: "group", data: { label: "第一组" } };
const nodes = Array.from({ length: 210 }, (_, index) => ({
  id: `node-${index}`,
  type: "creative",
  parentId: "g",
  data: { kind: "script", label: `镜头 ${index}`, text: "🎞".repeat(60) + "夜" },
}));
nodes[0].data = {
  kind: "script",
  label: "分镜 <>&",
  text: "",
  storyboard: [{ scene: "火车\u2028进站" }],
};
const cases = [
  { name: "empty", nodes: [], selection: [] },
  { name: "board", nodes: [group, nodes[0]], selection: [] },
  {
    name: "large-selection",
    nodes: [group, ...nodes],
    selection: ["missing", "node-209", "g", "g"],
  },
];
try {
  const archive = path.join(directory, "source.tar");
  execFileSync("git", ["-C", reference, "archive", "-o", archive, revision, "backend"]);
  execFileSync("tar", ["-xf", archive, "-C", directory]);
  const command = path.join(backend, "cmd", "compare-catalog");
  await mkdir(command, { recursive: true });
  await writeFile(
    path.join(command, "main.go"),
    `package main
import ("encoding/json"; "os"; "video-canvas/internal/agent/canvasgraph"; "video-canvas/internal/agent/prompts")
func main() {
  var cases []struct { Graph json.RawMessage; Selection []string; Message string; Steps int }
  if err := json.NewDecoder(os.Stdin).Decode(&cases); err != nil { panic(err) }
  var messages []string
  for _, sample := range cases {
    graph, err := canvasgraph.Parse(sample.Graph); if err != nil { panic(err) }
    catalog := canvasgraph.BuildCatalog(graph, canvasgraph.CatalogOptions{Priority:sample.Selection, Selected:sample.Selection})
    data, err := json.Marshal(catalog); if err != nil { panic(err) }
    messages = append(messages,prompts.User(sample.Message,string(data),prompts.RunInfo{MaxSteps:sample.Steps}))
  }
  if err := json.NewEncoder(os.Stdout).Encode(messages); err != nil { panic(err) }
}`,
  );
  const message = "请核对分镜和引用",
    steps = 20;
  const inputs = cases.map((sample) => ({
    message,
    steps,
    selection: sample.selection,
    graph: {
      edges: [],
      nodes: sample.nodes.map((node) => {
        if (node.type === "group") return node;
        const { storyboard, ...data } = node.data;
        return {
          ...node,
          type: "canvas",
          data: storyboard
            ? { ...data, kind: "storyboard", storyboard: { shots: storyboard } }
            : data,
        };
      }),
    },
  }));
  const baseline = JSON.parse(
    execFileSync("go", ["run", "./cmd/compare-catalog"], {
      cwd: backend,
      input: JSON.stringify(inputs),
      encoding: "utf8",
    }),
  );
  const comparisons = cases.map((sample, index) => {
    const catalog = agentCanvasCatalog(
      { nodes: sample.nodes, edges: [] },
      sample.selection,
      (text) => text,
    );
    const actual = canvasUserMessage(message, catalog, steps);
    assert.equal(actual, baseline[index], sample.name);
    return { sample: sample.name, bytes: Buffer.byteLength(actual) };
  });
  const output = path.join(root, "test-results", "assistant-workspaces");
  await mkdir(output, { recursive: true });
  await writeFile(
    path.join(output, "catalog.json"),
    JSON.stringify({ revision, comparisons }, null, 2),
  );
  console.log(comparisons);
} finally {
  await rm(directory, { recursive: true, force: true });
}
