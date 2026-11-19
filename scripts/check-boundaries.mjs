import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const violations = [];
async function inspect(directory, scope) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) await inspect(filename, scope);
    else if (/\.tsx?$/.test(filename)) {
      const source = await readFile(filename, "utf8");
      for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)) {
        const dependency = match[1];
        if (
          dependency.startsWith("node:") ||
          dependency === "electron" ||
          /(?:^|\/)main\//.test(dependency)
        ) {
          violations.push(`${filename}: ${scope} 不得导入 ${dependency}`);
        }
      }
    }
  }
}
await inspect("src/renderer", "Renderer");
await inspect("packages/link-studio-core/src", "Core");
if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else console.log("Renderer/Core 导入边界检查通过");
