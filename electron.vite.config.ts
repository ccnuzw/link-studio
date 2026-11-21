import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: { build: { externalizeDeps: { exclude: ["@link-studio/core", "@sinclair/typebox"] } } },
  preload: {
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } } },
  },
  renderer: {
    root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
    assetsInclude: ["**/*.glb"],
    plugins: [
      react(),
      {
        name: "link-studio-csp",
        transformIndexHtml(html, context) {
          return html.replace(
            "__CONNECT_SRC__",
            context.server ? "'self' ws://localhost:* ws://127.0.0.1:*" : "'none'",
          );
        },
      },
    ],
    server: { host: "127.0.0.1", port: 5173, strictPort: true },
  },
});
