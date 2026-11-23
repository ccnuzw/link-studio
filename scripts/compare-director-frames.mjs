import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

assert(process.env.VIDEO_CANVAS_WEB);
async function replayGestures(page, allowPan) {
  await page.evaluate((allow) => window.beginGestures(allow), allowPan);
  const samples = {};
  const sample = async (name) => {
    samples[name] = await page.evaluate(() => structuredClone(window.gestureState));
  };
  await page.mouse.move(240, 135);
  await page.mouse.down();
  await page.mouse.move(182, 193, { steps: 4 });
  await page.mouse.up();
  await sample("look");
  for (const button of ["middle", "right"]) {
    await page.mouse.move(187, 142);
    await page.mouse.down({ button });
    await page.mouse.move(246, 111, { steps: 4 });
    await page.mouse.up({ button });
    await sample(button);
  }
  await page.mouse.wheel(0, 100);
  await page.waitForFunction(
    (pitch) => window.gestureState.pose.pitch !== pitch,
    samples.right.pose.pitch,
  );
  await sample("tilt");
  await page.keyboard.down("Alt");
  await page.mouse.wheel(0, -80);
  await page.keyboard.up("Alt");
  await page.waitForFunction(() => window.gestureState.pose.fov !== 50);
  await page.waitForTimeout(430);
  await sample("zoom");
  await page.keyboard.down("w");
  await page.keyboard.down("ArrowRight");
  await page.evaluate(() => {
    window.controller.tick(0.05);
    window.controller.tick(0.25);
  });
  await page.keyboard.up("w");
  await page.keyboard.up("ArrowRight");
  await sample("walk");
  await page.locator("input").focus();
  await page.keyboard.down("d");
  await page.evaluate(() => window.controller.tick(0.1));
  await page.keyboard.up("d");
  await sample("typing");
  await page.evaluate(() => window.controller.dispose());
  return samples;
}
const output = resolve(process.env.FRAME_OUTPUT ?? "test-results/director-frame-parity"),
  scratch = await mkdtemp(join(tmpdir(), "director-frames-"));
const base = {
  version: 1,
  duration: 2,
  activeCameraId: "wide",
  characters: [],
  props: [],
  cameras: [
    {
      id: "wide",
      name: "横机位",
      x: 0,
      y: 1.6,
      z: 4,
      yaw: 0,
      pitch: -5,
      fov: 50,
      aspect: "16:9",
      keys: [],
    },
    {
      id: "portrait",
      name: "竖机位",
      x: 1.4,
      y: 1.5,
      z: 3,
      yaw: -20,
      pitch: -8,
      fov: 48,
      aspect: "9:16",
      keys: [],
    },
  ],
};
const people = [
  {
    id: "actor",
    name: "人物A",
    model: "male",
    color: "#d4d4d8",
    scale: 1,
    pose: "wave",
    x: -0.4,
    z: 0,
    yaw: 145,
    keys: [
      { x: -0.6, z: -0.2, yaw: 165, t: 0, ease: "smooth" },
      { x: 0.55, z: 0.3, yaw: -130, t: 2, ease: "linear" },
    ],
  },
  {
    id: "second",
    name: "人物B",
    model: "female",
    color: "#22c55e",
    scale: 0.88,
    pose: "sit",
    x: 1,
    z: -0.6,
    yaw: -30,
    keys: [],
  },
];
const props = [
  { id: "table", name: "桌", shape: "table", w: 1.8, h: 0.75, d: 0.8, x: 1, z: -0.4, yaw: 30 },
  { id: "box", name: "箱", shape: "box", w: 0.7, h: 0.55, d: 0.7, x: -1.1, z: -1.6, yaw: -47 },
];
const scene = {
  ...base,
  characters: people,
  props,
  cameras: [
    {
      ...base.cameras[0],
      lookAt: "actor",
      keys: [
        { x: 0, y: 1.6, z: 4, yaw: 0, pitch: -5, fov: 45, t: 0, ease: "linear" },
        { x: 1.1, y: 1.8, z: 3.4, yaw: -16, pitch: -14, fov: 62, t: 2, ease: "smooth" },
      ],
    },
    base.cameras[1],
  ],
};
const cases = [
  ["ground", base, 0],
  ["props", { ...base, props }, 0],
  ["fallback", { ...scene, characters: [people[0]] }, 0],
  ["actors-start", scene, 0],
  ["actors-mid", scene, 0.75],
  ["actors-end", scene, 2],
  ["portrait", { ...scene, activeCameraId: "portrait" }, 1],
  [
    "hidden",
    {
      ...scene,
      props: props.map((prop) => ({ ...prop, hidden: true })),
      characters: people.map((actor, index) => ({ ...actor, hidden: index === 0 })),
    },
    0.75,
  ],
];
const browser = await chromium.launch({ channel: "chrome" }),
  pictures = {},
  tracks = {},
  gestures = {},
  outputs = {},
  differences = {};
await mkdir(output, { recursive: true });
try {
  for (const upstream of [true, false]) {
    const side = upstream ? "upstream" : "desktop",
      root = upstream ? resolve(process.env.VIDEO_CANVAS_WEB) : process.cwd(),
      entry = "/src/__audit_frame.ts";
    const renderModule = upstream
      ? `import {createShotRenderer} from '@/utils/director/render';import {loadFigureModels} from '@/utils/director/figure';const shot=createShotRenderer();window.finish=()=>shot.dispose();window.render=async(scene,t,size,load)=>{if(load && !(await loadFigureModels(scene.characters.map(actor=>actor.model))))throw Error('上游模型加载失败');shot.setSize(...size);shot.render(scene,scene.activeCameraId,t);return shot.canvas.toDataURL()}`
      : `import {createDirectorRenderer} from '/src/renderer/workspace/director-renderer';import {loadDirectorFigures} from '/src/renderer/workspace/director-figures';const shot=createDirectorRenderer();window.finish=()=>shot.dispose();window.render=async(scene,t,[width,height],load)=>{if(load && !(await loadDirectorFigures(scene.characters)))throw Error('桌面模型加载失败');shot.renderShot(scene,t,width,height);return shot.canvas.toDataURL()}`;
    const code = `${renderModule};
      import {attachFreeCamera} from '${upstream ? "@/components/director/free-camera" : "/src/renderer/workspace/director-free-camera"}';
      window.beginGestures=allowPan=>{document.body.innerHTML='<canvas width="480" height="270" tabindex="0"></canvas><input>';document.body.style.margin='0';const element=document.querySelector('canvas');element.focus();const pose={x:1,y:2,z:4,yaw:10,pitch:-9,fov:50},state={pose,begins:0,ends:0};window.gestureState=state;window.controller=attachFreeCamera({element,camera:{get fov(){return pose.fov},aspect:480/270},allowPan,gizmoBusy:{current:false},driver:{read:()=>pose,write:patch=>{window.prevPitch=pose.pitch;Object.assign(pose,patch)},begin:()=>state.begins++,end:()=>state.ends++}})};
      import {CAMERA_PRESETS,applyPreset} from '${upstream ? "@/utils/director/preset" : "/src/renderer/workspace/director-presets"}';
      import {${upstream ? "renderThumbnail" : "directorThumbnail"} as thumbnail} from '${upstream ? "@/utils/director/render" : "/src/renderer/workspace/director-export"}';
      window.presetScenes = scene => CAMERA_PRESETS.map(meta=>({meta,...applyPreset(scene,scene.activeCameraId,meta.id)}));
      const asUrl = blob => new Promise((ok,fail)=>{const reader=new FileReader();reader.onload=()=>ok(reader.result);reader.onerror=fail;reader.readAsDataURL(blob)});
      window.thumbnail=async scene=>{const data=await thumbnail(scene);return data && asUrl(data instanceof Blob?data:new Blob([data],{type:'image/jpeg'}))};
      window.take=async scene=>{${upstream ? `const {exportCameras}=await import('@/utils/director/export');const {createExportEngine}=await import('@/utils/director/export-engine');const [result]=await exportCameras({scene,cameraIds:[scene.activeCameraId],resolution:'720p',withFirstFrame:true},createExportEngine());if(!result.ok) return {error:result.error};return {mp4:await asUrl(result.video),png:await asUrl(result.firstFrame)}` : `const {exportDirectorTake}=await import('/src/renderer/workspace/director-export');const result=await exportDirectorTake(scene,new AbortController().signal,()=>{},1280,true);return {mp4:await asUrl(new Blob([result.mp4])),png:await asUrl(new Blob([result.png]))}`}};`;
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: join(scratch, side),
      resolve: { alias: { "@": join(root, "src") } },
      assetsInclude: ["**/*.glb"],
      oxc: { jsx: { runtime: "automatic" } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      plugins: [
        {
          name: "frame-audit",
          resolveId: (id) => (id === entry ? id : undefined),
          load: (id) => (id === entry ? code : undefined),
        },
      ],
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls.local[0],
        page = await browser.newPage();
      try {
        page.on("pageerror", (error) => console.error(side, error));
        await page.route(origin + "audit", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<script type="module" src="${entry}"></script>`,
          }),
        );
        await page.goto(origin + "audit");
        await page.waitForFunction(() => typeof window.render === "function");
        const variants = await page.evaluate((input) => window.presetScenes(input), scene);
        tracks[side] = variants;
        const frames = [
          ...cases,
          ...variants.map(({ meta, scene: input }) => ["preset-" + meta.id, input, 1.25]),
        ];
        for (const model of ["male", "female"])
          for (const pose of [
            "stand",
            "walk",
            "run",
            "sit",
            "crouch",
            "point",
            "armsCrossed",
            "wave",
            "talk",
            "raiseHand",
            "lookBack",
            "lying",
          ])
            frames.push([
              `${model}-${pose}`,
              { ...base, characters: [{ ...people[0], model, pose, keys: [], x: 0, z: 0 }] },
              0,
            ]);
        for (const shape of [
          "box",
          "cylinder",
          "sphere",
          "plane",
          "table",
          "chair",
          "sofa",
          "bed",
          "cabinet",
          "door",
          "wall",
          "stairs",
          "car",
          "tree",
        ])
          frames.push([
            `prop-${shape}`,
            { ...base, props: [{ ...props[0], shape, x: 0, z: 0, w: 1.6, h: 1.3, d: 1.1 }] },
            0,
          ]);
        const store = async (name, url, ext) => {
          pictures[side + name] = url;
          await writeFile(
            join(output, `${side}-${name}.${ext}`),
            Buffer.from(url.split(",")[1], "base64"),
          );
        };
        for (const [name, input, t] of frames) {
          const size = input.activeCameraId === "portrait" ? [270, 480] : [480, 270];
          const url = await page.evaluate(
            (args) => window.render(...args),
            [input, t, size, name !== "fallback"],
          );
          await store(name, url, "png");
        }
        for (const aspect of ["16:9", "9:16", "1:1", "4:3", "21:9"]) {
          const input = { ...scene, cameras: [{ ...scene.cameras[0], aspect }] };
          const url = await page.evaluate((input) => window.thumbnail(input), input);
          await store("thumbnail-" + aspect.replace(":", "x"), url, "jpg");
        }
        if (process.argv.includes("--video")) {
          const result = await page.evaluate((input) => window.take(input), {
            ...scene,
            duration: 1,
          });
          outputs[side] = result.error ?? "ok";
          if (!result.error)
            for (const ext of ["mp4", "png"])
              await writeFile(
                join(output, `${side}-take.${ext}`),
                Buffer.from(result[ext].split(",")[1], "base64"),
              );
        }
        await page.evaluate(() => window.finish());
        gestures[side] = {};
        for (const mode of ["director", "camera"])
          gestures[side][mode] = await replayGestures(page, mode === "director");
      } finally {
        await page.close();
      }
    } finally {
      await server.close();
    }
  }
  const page = await browser.newPage();
  assert.equal(tracks.upstream.length, 13);
  assert.deepEqual(tracks.desktop, tracks.upstream, "预设元数据、完整场景关键帧或提示不一致");
  await writeFile(join(output, "gestures.json"), JSON.stringify(gestures, null, 2));
  assert.deepEqual(gestures.desktop, gestures.upstream, "手势的实际变换或连续操作边界不一致");
  for (const result of Object.values(gestures.desktop)) {
    assert.deepEqual(result.walk, result.typing);
    assert.equal(result.walk.begins, result.walk.ends);
    assert.notEqual(result.walk.pose.x, result.zoom.pose.x);
    assert.equal(result.tilt.pose.pitch, result.right.pose.pitch - 2);
  }
  for (const name of Object.keys(pictures)
    .filter((key) => key.startsWith("upstream"))
    .map((key) => key.slice(8)))
    differences[name] = await page.evaluate(
      async (urls) => {
        const pair = await Promise.all(
          urls.map(async (url) => {
            const image = new Image();
            image.src = url;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(image, 0, 0);
            return {
              width: image.width,
              height: image.height,
              pixels: new Uint32Array(
                ctx.getImageData(0, 0, image.width, image.height).data.buffer,
              ),
            };
          }),
        );
        if (pair[0].width !== pair[1].width || pair[0].height !== pair[1].height)
          throw Error("图像尺寸不同");
        return pair[0].pixels.reduce(
          (count, value, index) => count + (pair[1].pixels[index] !== value),
          0,
        );
      },
      [pictures["upstream" + name], pictures["desktop" + name]],
    );
  console.table(differences);
  await writeFile(join(output, "tracks.json"), JSON.stringify(tracks, null, 2));
  if (process.argv.includes("--video")) {
    assert.equal(outputs.upstream, "ok");
    assert.equal(outputs.desktop, "ok");
    const hashes = {};
    for (const side of ["upstream", "desktop"]) {
      const decoded = execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          join(output, `${side}-take.mp4`),
          "-pix_fmt",
          "rgb24",
          "-f",
          "framehash",
          "-hash",
          "sha256",
          "-",
        ],
        { encoding: "utf8" },
      );
      await writeFile(join(output, `${side}-rgb.sha256`), decoded);
      hashes[side] = decoded
        .trim()
        .split("\n")
        .filter((line) => !line.startsWith("#"));
    }
    outputs.differentDecodedFrames = hashes.upstream.filter(
      (line, index) => line !== hashes.desktop[index],
    ).length;
    outputs.firstPngIdentical = (await readFile(join(output, "upstream-take.png"))).equals(
      await readFile(join(output, "desktop-take.png")),
    );
    outputs.mp4Identical = (await readFile(join(output, "upstream-take.mp4"))).equals(
      await readFile(join(output, "desktop-take.mp4")),
    );
    console.table(outputs);
    await writeFile(join(output, "video.json"), JSON.stringify(outputs, null, 2));
    if (process.argv.includes("--strict")) {
      assert.equal(hashes.upstream.length, 24);
      assert.equal(hashes.desktop.length, 24);
      assert.equal(outputs.differentDecodedFrames, 0);
      assert(outputs.firstPngIdentical);
    }
  }
  await writeFile(join(output, "results.json"), JSON.stringify(differences, null, 2));
  if (process.argv.includes("--strict"))
    assert(Object.values(differences).every((value) => value === 0));
} finally {
  await browser.close();
  await rm(scratch, { recursive: true, force: true });
}
