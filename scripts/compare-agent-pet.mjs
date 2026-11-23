import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { build } from "vite";

const workspace = process.cwd();
const reference = path.resolve(process.env.AGENT_REFERENCE_WEB ?? "../video-canvas/web");
const revision = "4277d16f40457664e27a89efabac14d07c1d73e8";
const temp = await mkdtemp(path.join(tmpdir(), "link-pet-"));
const output = path.join(workspace, "test-results/agent-pet-parity");
const images = new Map();
const report = {
  revision,
  scope: "DPR 1，内置桌宠动作行逐帧，不含启动淡入、气泡和整窗",
  states: {},
};
const browser = await chromium.launch({ channel: "chrome" });
try {
  await mkdir(output, { recursive: true });
  const archive = path.join(temp, "ref.tar");
  execFileSync("git", ["-C", path.dirname(reference), "archive", "-o", archive, revision, "web"]);
  execFileSync("tar", ["-xf", archive, "-C", temp]);
  const pinned = path.join(temp, "web");
  await symlink(path.join(reference, "node_modules"), path.join(pinned, "node_modules"), "dir");
  execFileSync(path.join(pinned, "node_modules/.bin/vite"), ["build", "--logLevel", "error"], {
    cwd: pinned,
  });
  for (const upstream of [true, false]) {
    const side = upstream ? "reference" : "desktop";
    const root = upstream ? pinned : workspace;
    const folder = upstream ? "./src/utils/pet" : "./src/renderer/workspace/pet";
    const component = upstream ? "./src/pages/canvas/pet/pet-sprite" : `${folder}/pet-sprite`;
    const props = upstream
      ? 'assets={{sheetUrl:"/sheet",sheet:{width:1536,height:2080}}} width={width} sleepFallback={false}'
      : 'sheet="/sheet" size={width}';
    const source = `import {createRoot} from 'react-dom/client';import {PetSprite} from '${component}';
      import {PET_ROWS,PET_CELL} from '${folder}/rows';import {buildKeyframes} from '${folder}/atlas';
      const width=Number(location.search.slice(1));const height=Math.round(width*208/192);
      createRoot(document.querySelector('main')).render(<><style>{buildKeyframes(PET_ROWS,PET_CELL)}</style>{PET_ROWS.map(({name,row,durations})=><div key={name} className="row">{durations.map((duration,index)=><div key={index} data-time={durations.slice(0,index).reduce((sum,ms)=>sum+ms,0)+duration/2} data-column={index} style={{width:width+8,height:height+8,padding:4}}><div style={{position:'relative'}}><PetSprite ${props} row={row} loop={true} paused={true}/></div></div>)}</div>)}</>);`;
    const entry = path.join(root, "pet-frames.jsx");
    const bundle = path.join(temp, side);
    await build({
      root,
      configFile: false,
      logLevel: "error",
      resolve: { alias: { "@": path.join(root, "src") } },
      publicDir: false,
      oxc: { jsx: { runtime: "automatic" } },
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [
        {
          name: "pet-frames",
          resolveId(id) {
            if (id === entry) return id;
          },
          load(id) {
            if (id === entry) return source;
          },
        },
      ],
      build: { outDir: bundle, lib: { entry, formats: ["es"], fileName: () => "fixture.js" } },
    });
    const assets = path.join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const styles = (await readdir(assets)).filter((file) => /^index-.*\.css$/.test(file));
    if (styles.length !== 1) throw Error("需要唯一的生产样式表");
    for (const theme of ["light", "dark"])
      for (const width of [80, 56, 60]) {
        const key = `${theme}-${width}`;
        const page = await browser.newPage({
          deviceScaleFactor: 1,
          colorScheme: theme,
          viewport: { width: 760, height: 1000 },
        });
        try {
          await page.route("http://pet.test/**", (route) => {
            const resource = new URL(route.request().url()).pathname;
            if (resource === "/fixture.js")
              return route.fulfill({
                path: path.join(bundle, "fixture.js"),
                contentType: "text/javascript",
              });
            if (resource === "/index.css")
              return route.fulfill({ path: path.join(assets, styles[0]), contentType: "text/css" });
            if (resource === "/sheet")
              return route.fulfill({
                path: path.join(
                  root,
                  upstream
                    ? "public/pets/xiaojing/spritesheet.webp"
                    : "src/renderer/workspace/pet/spritesheet.webp",
                ),
                contentType: "image/webp",
              });
            if (resource !== "/") return route.abort();
            return route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><html class="${theme}"><link rel="stylesheet" href="/index.css"><style>body{margin:0}main{width:max-content;background:${theme === "dark" ? "#242424" : "#fafafa"}}.row{display:flex}*[data-time]{box-sizing:border-box}</style><main></main><script type="module" src="/fixture.js"></script></html>`,
            });
          });
          await page.goto(`http://pet.test/?${width}`);
          await page.locator(".pet-sprite").first().waitFor();
          const frames = await page.evaluate(async () => {
            const sheet = new Image();
            sheet.src = "/sheet";
            await sheet.decode();
            const cells = [...document.querySelectorAll("[data-time]")];
            for (const cell of cells) {
              const sprite = cell.querySelector(".pet-sprite");
              for (const animation of cell.getAnimations({ subtree: true })) {
                animation.pause();
                animation.currentTime =
                  animation.effect.target === sprite ? Number(cell.dataset.time) : 1000;
              }
              const style = getComputedStyle(sprite);
              if (
                parseFloat(style.backgroundPositionX) !== -192 * Number(cell.dataset.column) ||
                parseFloat(style.backgroundPositionY) !== -208 * Number(sprite.dataset.row)
              )
                throw Error(`错误帧 ${sprite.dataset.row}/${cell.dataset.column}`);
            }
            return cells.length;
          });
          const bytes = await page
            .locator("main")
            .screenshot({ path: path.join(output, `${side}-${key}.png`) });
          if (upstream) images.set(key, bytes);
          else {
            const differences = await page.evaluate(
              async (pair) => {
                const pixels = await Promise.all(
                  pair.map(async (data) => {
                    const image = new Image();
                    image.src = `data:image/png;base64,${data}`;
                    await image.decode();
                    const canvas = document.createElement("canvas");
                    canvas.width = image.width;
                    canvas.height = image.height;
                    const context = canvas.getContext("2d");
                    context.drawImage(image, 0, 0);
                    return new Uint32Array(
                      context.getImageData(0, 0, image.width, image.height).data.buffer,
                    );
                  }),
                );
                if (pixels[0].length !== pixels[1].length) throw Error("图集尺寸不一致");
                return pixels[0].reduce(
                  (count, color, index) => count + Number(color !== pixels[1][index]),
                  0,
                );
              },
              [images.get(key), bytes].map((buffer) => buffer.toString("base64")),
            );
            report.states[key] = { frames, differences };
            if (key === "dark-80") {
              const cards = [images.get(key), bytes].map(
                (buffer, index) =>
                  `<section><h2>${index ? "小灵 · Link Studio" : "小镜 · 4277d16f"}</h2><div style="background-image:url(data:image/png;base64,${buffer.toString("base64")})"></div></section>`,
              );
              await page.setContent(
                `<meta charset="UTF-8"><style>body{margin:0;font:13px system-ui;color:white}article{width:max-content;display:flex;gap:2px;background:#424242}section{background:#242424;padding:12px 16px}h2{margin:0 0 8px;font-size:14px}section div{width:176px;height:95px;background-position:0 0}</style><article>${cards.join("")}</article>`,
              );
              await page
                .locator("article")
                .screenshot({ path: path.join(output, "dark-idle-comparison.png") });
            }
          }
        } finally {
          await page.close();
        }
      }
  }
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(report);
  if (Object.values(report.states).some((state) => state.differences)) process.exitCode = 1;
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
