import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const workspace = process.cwd();
const checkout = path.resolve(process.env.AGENT_REFERENCE_WEB ?? "../video-canvas/web");
const revision = "4277d16f40457664e27a89efabac14d07c1d73e8";
const output = path.join(workspace, "test-results/agent-empty-parity");
const temp = await mkdtemp(path.join(tmpdir(), "link-agent-visual-"));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
try {
  const archive = path.join(temp, "reference.tar");
  execFileSync("git", ["-C", path.dirname(checkout), "archive", "-o", archive, revision, "web"]);
  execFileSync("tar", ["-xf", archive, "-C", temp]);
  const upstream = path.join(temp, "web");
  await symlink(path.join(checkout, "node_modules"), path.join(upstream, "node_modules"), "dir");
  execFileSync(path.join(upstream, "node_modules/.bin/vite"), ["build", "--logLevel", "error"], {
    cwd: upstream,
    stdio: "inherit",
  });
  const page = await browser.newPage({
    viewport: { width: 400, height: 420 },
    deviceScaleFactor: 1,
    colorScheme: "light",
  });
  const states = ["idle", "hover", "focus"];
  const captures = {};
  const geometry = {};
  const pets = {};
  const frames = {};
  for (const reference of [true, false]) {
    const root = reference ? upstream : workspace;
    const name = reference ? "upstream" : "desktop";
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: path.join(temp, name),
      resolve: { alias: { "@": path.join(root, "src") } },
      plugins: reference
        ? [
            {
              name: "drama-model-fixture",
              resolveId(id) {
                if (id === "./use-drama-assistant") return "\0fixture-drama-models";
                if (id.endsWith("/pages/canvas/agent/agent-panel")) return "\0unexpected-chat";
              },
              load(id) {
                if (id === "\0unexpected-chat")
                  return 'export function AgentPanel(){throw Error("不可用状态不应挂载对话") }';
                if (id === "\0fixture-drama-models")
                  return "export let models=null; export function setModels(next){models=next} export function useDramaAssistant(){return {models}}";
              },
              enforce: "pre",
            },
          ]
        : [],
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true },
      oxc: { jsx: { runtime: "automatic" } },
    });
    const markups = {};
    const modelStates = {};
    const spriteCases = [];
    let spriteStyles;
    try {
      const exports = await server.ssrLoadModule(
        reference
          ? "/src/pages/canvas/agent/agent-empty.tsx"
          : "/src/renderer/workspace/assistant-empty.tsx",
      );
      const require = createRequire(path.join(root, "package.json"));
      const modelState = reference
        ? (await server.ssrLoadModule("/src/pages/drama/assistant/assistant-pane.tsx"))
            .AssistantPane
        : (await server.ssrLoadModule("/src/renderer/assistant/assistant-model-state.tsx"))
            .AssistantModelState;
      for (const state of ["loading", "no-model"]) {
        if (reference)
          (await server.ssrLoadModule("\0fixture-drama-models")).setModels(
            state === "loading" ? null : [],
          );
        modelStates[state] = require("react-dom/server").renderToStaticMarkup(
          require("react").createElement(modelState, { loading: state === "loading" }),
        );
      }
      const petBase = reference ? "/src/utils/pet" : "/src/renderer/workspace/pet";
      const { buildKeyframes } = await server.ssrLoadModule(`${petBase}/atlas.ts`);
      const { PET_ROWS, PET_CELL } = await server.ssrLoadModule(`${petBase}/rows.ts`);
      const { PetSprite } = await server.ssrLoadModule(
        reference ? "/src/pages/canvas/pet/pet-sprite.tsx" : `${petBase}/pet-sprite.tsx`,
      );
      spriteStyles = buildKeyframes(PET_ROWS, PET_CELL);
      for (const size of [80, 56, 60])
        for (const { row, name: action, durations } of PET_ROWS) {
          const props = reference
            ? {
                width: size,
                row,
                loop: true,
                paused: true,
                sleepFallback: false,
                assets: { sheetUrl: "/pet.webp", sheet: { width: 1536, height: 2080 } },
              }
            : { size, row, loop: true, paused: true, sheet: "/pet.webp" };
          spriteCases.push({
            id: `${action}-${size}`,
            durations,
            height: size === 60 ? 44 : Math.round((size * 208) / 192),
            size,
            html: require("react-dom/server").renderToStaticMarkup(
              require("react").createElement(PetSprite, props),
            ),
          });
        }
      for (const surface of ["canvas", "settings", "drama"]) {
        let copy;
        if (reference && surface !== "canvas") {
          const file =
            surface === "settings"
              ? "admin/assistant/admin-assistant-panel"
              : "drama/assistant/assistant-pane";
          const source = await readFile(path.join(root, `src/pages/${file}.tsx`), "utf8");
          const declaration = source.match(
            /const EMPTY_COPY: AgentEmptyCopy = (\{[\s\S]*?\n\});/u,
          )?.[1];
          const icons = source.match(/import \{[^}]+\} from "lucide-react";/u)?.[0];
          if (!icons || !declaration) throw new Error(`Missing pinned ${surface} copy`);
          await writeFile(
            path.join(root, `${surface}-copy.ts`),
            `${icons}\nexport default ${declaration};`,
          );
          copy = (await server.ssrLoadModule(`/${surface}-copy.ts`)).default;
        }
        markups[surface] = require("react-dom/server").renderToStaticMarkup(
          require("react").createElement(
            reference ? exports.AgentEmpty : exports.CanvasAssistantEmpty,
            {
              hasModel: true,
              settings: surface === "settings",
              drama: surface === "drama",
              copy,
              onStarter() {},
            },
          ),
        );
      }
    } finally {
      await server.close();
    }
    const assets = path.join(root, reference ? "dist/assets" : "out/renderer/assets");
    const css = (await readdir(assets)).filter((file) => /^index-.*\.css$/.test(file));
    if (css.length !== 1) throw new Error(`Expected one built stylesheet in ${assets}`);
    const resources = new Map(
      await Promise.all(
        [css[0], ...(await readdir(assets)).filter((name) => name.endsWith(".woff2"))].map(
          async (name) => [name, await readFile(path.join(assets, name))],
        ),
      ),
    );
    const wrapper = (surface) =>
      surface.startsWith("drama") && Object.hasOwn(modelStates, surface.slice(6))
        ? `<div class="${reference ? "drama-theme bg-background text-foreground" : "assistant-surface drama-assistant drama-model-state"}" style="height:100%;border-radius:0">${modelStates[surface.slice(6)]}</div>`
        : reference
          ? `<div class="${surface === "drama" ? "drama-theme bg-background text-popover-foreground" : ""}" style="display:flex;height:100%;flex-direction:column">${markups[surface]}</div>`
          : `<div class="${surface === "canvas" ? "canvas-workspace" : ""}" style="display:block;height:100%"><section class="assistant-surface ${surface}-assistant" style="position:static;display:flex;padding:0;border:0;border-radius:0;height:100%;width:100%"><div class="assistant-events" style="flex:1">${markups[surface]}</div></section></div>`;
    const origin = `https://${name}.test`;
    await page.route(`${origin}/**`, (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/pet.webp")
        return route.fulfill({
          contentType: "image/webp",
          path: path.join(
            root,
            reference
              ? "public/pets/xiaojing/spritesheet.webp"
              : "src/renderer/workspace/pet/spritesheet.webp",
          ),
        });
      if (
        Object.hasOwn(markups, pathname.slice(1)) ||
        /^\/drama-(loading|no-model)$/.test(pathname)
      )
        return route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html class="${reference && new URL(route.request().url()).searchParams.has("dark") ? "dark" : ""}"><meta charset=utf-8><link rel=stylesheet href="/assets/${css[0]}"><style>html,body{height:100%;margin:0;background:white}</style>${wrapper(pathname.slice(1))}`,
        });
      if (/^\/assets\/[\w.-]+\.(?:css|woff2)$/.test(pathname))
        return route.fulfill({
          body: resources.get(path.basename(pathname)),
          contentType: pathname.endsWith(".css") ? "text/css" : "font/woff2",
        });
      return route.abort();
    });
    for (const theme of ["light", "dark"])
      for (const state of Object.keys(modelStates)) {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.setViewportSize({ width: 320, height: 260 });
        await page.goto(`${origin}/drama-${state}${theme === "dark" ? "?dark" : ""}`);
        await page.evaluate(() => document.fonts.ready);
        if (state === "no-model")
          await page.getByText("暂时没有可用的 Agent 模型", { exact: true }).waitFor();
        else await page.locator("[aria-busy=true]").waitFor();
        if (await page.locator("button,textarea").count()) throw Error("模型不可用时出现会话操作");
        const key = `drama-${theme}-${state}`;
        const image = await page.screenshot({ path: path.join(output, `${name}-${key}.png`) });
        if (!(await page.screenshot()).equals(image)) throw Error(`Unstable ${key}`);
        (captures[key] ??= []).push(image.toString("base64"));
      }
    await page.setViewportSize({ width: 400, height: 420 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    for (const surface of Object.keys(markups)) {
      for (const theme of surface === "drama" ? ["light", "dark"] : ["light"]) {
        const suffix = theme === "dark" ? "-dark" : "";
        const label = surface === "canvas" ? name : `${name}-${surface}${suffix}`;
        await page.emulateMedia({ colorScheme: theme });
        const url = `${origin}/${surface}${suffix ? "?dark" : ""}`;
        await page.goto(url);
        await page.evaluate(() => document.fonts.ready);
        if (
          !(await page.evaluate(() =>
            [...document.fonts].some(
              (font) => font.family.includes("Geist") && font.status === "loaded",
            ),
          ))
        )
          throw new Error(`${name} Geist font is missing`);
        geometry[`${label}Elements`] = await page
          .locator(reference ? ".agent-scroll .m-auto" : ".canvas-assistant-welcome")
          .evaluate((element) =>
            [
              ...element.children,
              element.querySelector("button"),
              element.querySelector("button span"),
              element.querySelector("button svg"),
            ].map((child) => {
              const style = getComputedStyle(child);
              const rect = child.getBoundingClientRect();
              return {
                tag: child.tagName,
                x: rect.x,
                y: rect.y,
                w: rect.width,
                h: rect.height,
                font: style.font,
                color: style.color,
                background: style.backgroundColor,
                radius: style.borderRadius,
                shadow: style.boxShadow,
              };
            }),
          );
        geometry[label] = await page
          .locator("button")
          .evaluateAll((buttons) =>
            buttons.map((button) => button.getBoundingClientRect().toJSON()),
          );
        geometry[`${label}Container`] = await page
          .locator(reference ? ".agent-scroll" : ".assistant-events")
          .evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              width: element.offsetWidth,
              client: element.clientWidth,
              font: style.font,
              scroll: style.overflowY,
              gutter: style.scrollbarGutter,
              computedScrollbar: getComputedStyle(element, "::-webkit-scrollbar").width,
            };
          });
        await page.mouse.move(0, 0);
        for (const state of states) {
          if (state === "hover") await page.getByRole("button").first().hover();
          if (state === "focus") {
            await page.mouse.move(0, 0);
            await page.keyboard.press("Tab");
            if (
              !(await page
                .getByRole("button")
                .first()
                .evaluate((button) => button.matches(":focus-visible")))
            )
              throw new Error(`${name} keyboard focus is missing`);
          }
          await page.evaluate(async () => {
            await new Promise(requestAnimationFrame);
            await Promise.all(document.getAnimations().map((animation) => animation.finished));
          });
          const file = state === "idle" ? `${label}.png` : `${label}-${state}.png`;
          const image = await page.screenshot({ path: path.join(output, file) });
          const key = surface === "canvas" ? state : `${surface}${suffix}-${state}`;
          captures[key] ??= [];
          captures[key].push(image.toString("base64"));
          if (!(await page.screenshot()).equals(image))
            throw new Error(`Unstable ${name} ${state}`);
        }
        await page.setViewportSize({ width: 300, height: 180 });
        await page.goto(url);
        await page.evaluate(() => document.fonts.ready);
        const scroller = page.locator(reference ? ".agent-scroll" : ".assistant-events");
        for (const edge of ["top", "bottom"]) {
          await scroller.evaluate((element, edge) => {
            if (element.scrollHeight <= element.clientHeight)
              throw new Error("Expected an overflowing welcome");
            element.scrollTop = edge === "bottom" ? element.scrollHeight : 0;
          }, edge);
          const target =
            edge === "top"
              ? page.locator(reference ? ".agent-orb" : ".assistant-orb")
              : page.getByRole("button").last();
          const box = await target.boundingBox();
          if (!box || box.y < 0 || box.y + box.height > 180)
            throw new Error(`Unreachable ${label} ${edge}`);
          const key = `${surface}${suffix}-compact-${edge}`;
          geometry[`${label}-compact-${edge}`] = await scroller.evaluate((scroll) => ({
            top: scroll.scrollTop,
            height: scroll.scrollHeight,
            boxes: [...scroll.firstElementChild.children, ...scroll.querySelectorAll("button")].map(
              (child) => {
                const rect = child.getBoundingClientRect();
                return [rect.x, rect.y, rect.width, rect.height];
              },
            ),
          }));
          const image = await page.screenshot({
            path: path.join(output, `${label}-compact-${edge}.png`),
          });
          if (!(await page.screenshot()).equals(image))
            throw new Error(`Unstable ${label} ${edge}`);
          (captures[key] ??= []).push(image.toString("base64"));
        }
        await page.setViewportSize({ width: 400, height: 420 });
      }
    }
    await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "light" });
    await page.setContent(
      `<link rel="stylesheet" href="${origin}/assets/${css[0]}"><style>${spriteStyles} body{margin:0;background:white}.sample{position:fixed;left:0;top:0;overflow:hidden;background:white}</style><div class="sample"></div>`,
    );
    await page.evaluate(async () => {
      const image = new Image();
      image.src = "/pet.webp";
      await image.decode();
    });
    for (const { id, durations, size, height, html } of spriteCases) {
      const sample = page.locator(".sample");
      await sample.evaluate(
        (el, { size, height, html }) => {
          el.style.width = `${size}px`;
          el.style.height = `${height}px`;
          el.innerHTML = html;
        },
        { size, height, html },
      );
      await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        const animations = document.getAnimations();
        for (const anim of animations) {
          anim.pause();
          anim.currentTime = anim.effect.getTiming().iterations === Infinity ? 0 : 1000;
        }
        await Promise.all(animations.map((anim) => anim.ready));
        await new Promise(requestAnimationFrame);
      });
      await sample.evaluate(async (el) => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        if (getComputedStyle(el.querySelector(".pet-sprite")).animationName === "none")
          throw new Error("Missing frozen row");
      });
      const image = await sample.screenshot();
      if (!(await sample.screenshot()).equals(image)) throw new Error(`Unstable ${name} ${id}`);
      pets[id] ??= [];
      pets[id].push(image.toString("base64"));
      if (id === "sleeping-80") await writeFile(path.join(output, `${name}-sleeping.png`), image);
      let elapsed = 0;
      for (const [index, duration] of durations.entries()) {
        await sample.evaluate(
          async (el, time) => {
            const sprite = el.querySelector(".pet-sprite");
            const anim = sprite.getAnimations()[0];
            anim.currentTime = time;
            await new Promise(requestAnimationFrame);
          },
          elapsed + duration / 2,
        );
        const key = `${id}:${index}`;
        frames[key] ??= [];
        frames[key].push((await sample.screenshot()).toString("base64"));
        elapsed += duration;
      }
    }
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
  const compare = async (images) =>
    page.evaluate(async (images) => {
      const pixels = await Promise.all(
        images.map(async (source) => {
          const image = new Image();
          image.src = `data:image/png;base64,${source}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0);
          return new Uint32Array(
            context.getImageData(0, 0, canvas.width, canvas.height).data.buffer,
          );
        }),
      );
      return pixels[0].reduce(
        (count, pixel, index) => count + Number(pixel !== pixels[1][index]),
        0,
      );
    }, images);
  const differences = {};
  for (const [state, images] of Object.entries(captures))
    differences[state] = await compare(images);
  const petDifferences = {};
  for (const [id, images] of Object.entries(pets)) petDifferences[id] = await compare(images);
  const frameDifferences = {};
  for (const [id, images] of Object.entries(frames)) frameDifferences[id] = await compare(images);
  const report = {
    revision,
    viewport: [400, 420],
    compactViewport: [300, 180],
    modelStateViewport: [320, 260],
    scope:
      "空会话内容区。短剧基线为保留但未挂载的 AssistantPane / AgentEmpty；设置为无抽屉外壳的共享内容组件。",
    dpr: 1,
    browser: browser.version(),
    difference: differences.idle,
    differences,
    petDifferences,
    frameDifferences,
    geometry,
  };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await page.setViewportSize({ width: 840, height: 1380 });
  await page.setContent(
    `<style>*{box-sizing:border-box}body{margin:0;background:#e9eaec;font:15px system-ui}main{display:grid;grid-template-columns:400px 400px;gap:8px 12px;padding:12px}header{font-weight:600;padding:4px}figure{margin:0}img{display:block}figcaption{font-size:12px;padding:3px 0}</style><main><header>video-canvas · 4277d16f</header><header>link-studio · 小灵</header>${[
      ["idle", "画布"],
      ["settings-idle", "设置"],
      ["drama-idle", "短剧"],
    ]
      .map(([key, label]) =>
        captures[key]
          .map(
            (image) =>
              `<figure><img width="400" height="420" src="data:image/png;base64,${image}"><figcaption>${label} · 空会话 / 常态</figcaption></figure>`,
          )
          .join(""),
      )
      .join("")}</main>`,
  );
  await page.locator("main").screenshot({ path: path.join(output, "surfaces.png") });
  console.log(JSON.stringify(report));
  if (
    [
      ...Object.values(differences),
      ...Object.values(petDifferences),
      ...Object.values(frameDifferences),
    ].some((count) => count !== 0)
  )
    throw new Error("Welcome or pet sprite pixels differ; inspect report.json");
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
