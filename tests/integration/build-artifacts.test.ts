import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Electron 构建边界", () => {
  it("产出 Main、CJS preload 和带生产 CSP 的 Renderer", async () => {
    const [main, preload, html] = await Promise.all([
      readFile("out/main/index.js", "utf8"),
      readFile("out/preload/index.cjs", "utf8"),
      readFile("out/renderer/index.html", "utf8"),
    ]);
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("sandbox: true");
    expect(preload).toContain("exposeInMainWorld");
    expect(preload).not.toMatch(/require\(["']@link-studio/);
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("media-src link-media: blob:;");
    expect(html).not.toContain("__CONNECT_SRC__");
  });
});
