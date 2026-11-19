import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "out/agent-runtime");
const dependencies = new Map();
function collectPackage(source) {
  let directory = dirname(source.split("?")[0]);
  while (directory !== dirname(directory)) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const metadata = JSON.parse(readFileSync(manifest, "utf8"));
      dependencies.set(`${metadata.name}@${metadata.version}`, { directory, metadata });
      return;
    }
    directory = dirname(directory);
  }
}
const provenance = JSON.parse(
  readFileSync(join(root, "packages/agent-runtime/upstream/provenance.json"), "utf8"),
);
for (const [path, originalHash] of Object.entries(provenance.sha256)) {
  const actual = createHash("sha256")
    .update(readFileSync(join(root, "packages/agent-runtime/upstream", path)))
    .digest("hex");
  if (actual !== (provenance.localPatches[path]?.sha256 ?? originalHash))
    throw new Error(`Agent 上游来源指纹不符：${path}`);
}
await build({
  configFile: false,
  logLevel: "warn",
  ssr: { noExternal: true, external: ["@earendil-works/pi-codemode"] },
  plugins: [
    {
      name: "agent-dependency-inventory",
      generateBundle() {
        for (const source of this.getModuleIds()) {
          if (source.includes("/node_modules/") && source.startsWith("/")) collectPackage(source);
        }
      },
    },
  ],
  build: {
    ssr: join(root, "packages/agent-runtime/src/worker.ts"),
    outDir: output,
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: "worker.mjs" } },
  },
});
await build({
  configFile: false,
  logLevel: "warn",
  build: {
    ssr: join(root, "packages/agent-runtime/src/client.ts"),
    outDir: output,
    emptyOutDir: false,
    rollupOptions: { output: { entryFileNames: "client.cjs", format: "cjs" } },
  },
});
const codemode = dirname(
  dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-codemode"))),
);
const codemodeRequire = createRequire(join(codemode, "package.json"));
await mkdir(join(output, "node_modules/@earendil-works"), { recursive: true });
await cp(codemode, join(output, "node_modules/@earendil-works/pi-codemode"), {
  recursive: true,
  dereference: true,
});
const wasm = codemodeRequire.resolve("quickjs-wasi/quickjs.wasm");
collectPackage(join(codemode, "dist/index.js"));
collectPackage(wasm);
await cp(dirname(wasm), join(output, "node_modules/quickjs-wasi"), {
  recursive: true,
  dereference: true,
});
await writeFile(join(output, "package.json"), '{"type":"module","private":true}\n');
await cp(
  join(root, "packages/agent-runtime/upstream/UPSTREAM-LICENSE"),
  join(output, "UPSTREAM-LICENSE"),
);
await cp(
  join(root, "packages/agent-runtime/upstream/provenance.json"),
  join(output, "provenance.json"),
);
await cp(join(root, "resources/agent"), join(output, "licenses"), { recursive: true });
const inventory = [];
for (const [key, { directory, metadata }] of [...dependencies].sort()) {
  const texts = readdirSync(directory).filter(
    (name) =>
      /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i.test(name) &&
      statSync(join(directory, name)).isFile(),
  );
  const target = join(output, "licenses", key.replaceAll("/", "__"));
  await mkdir(target, { recursive: true });
  for (const name of texts) await cp(join(directory, name), join(target, name));
  const fallback = metadata.name.startsWith("@earendil-works/")
    ? "PI-LICENSE"
    : metadata.name === "quickjs-wasi"
      ? "QUICKJS-WASI-LICENSE"
      : null;
  inventory.push({
    name: metadata.name,
    version: metadata.version,
    license: metadata.license,
    repository: metadata.repository,
    notices: texts.length
      ? texts.map((name) => `${key.replaceAll("/", "__")}/${name}`)
      : fallback
        ? [fallback]
        : [],
  });
}
await writeFile(join(output, "dependencies.json"), `${JSON.stringify(inventory, null, 2)}\n`);
console.log("Agent Worker / QuickJS WASM 已构建");
