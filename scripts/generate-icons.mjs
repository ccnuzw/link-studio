import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url));
const iconDirectory = join(root, "resources/icons");
const iconsetDirectory = join(iconDirectory, "icon.iconset");
await mkdir(iconsetDirectory, { recursive: true });
const svg = await readFile(join(root, "resources/brand/icon.svg"), "utf8");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "link-studio-icons-"));
const rendererPath = join(temporaryDirectory, "render.cjs");
await writeFile(
  rendererPath,
  `const {app,BrowserWindow}=require("electron");
app.whenReady().then(()=>{
  const window=new BrowserWindow({show:false,width:1024,height:1024,transparent:true,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}});
  window.loadURL("data:text/html,<html></html>");
});`,
);
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({ args: [rendererPath], env: environment });
const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
const images = new Map();

try {
  const page = await application.firstWindow();
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`,
    );
    const png = await page.screenshot({ omitBackground: true });
    images.set(size, png);
    await writeFile(join(iconDirectory, size === 1024 ? "icon.png" : `icon-${size}.png`), png);
  }
} finally {
  await application.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}

for (const size of [16, 32, 128, 256, 512]) {
  await writeFile(join(iconsetDirectory, `icon_${size}x${size}.png`), images.get(size));
  await writeFile(join(iconsetDirectory, `icon_${size}x${size}@2x.png`), images.get(size * 2));
}

const windowsSizes = [16, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6 + windowsSizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(windowsSizes.length, 4);
let imageOffset = header.length;
for (const [index, size] of windowsSizes.entries()) {
  const entryOffset = 6 + index * 16;
  const png = images.get(size);
  header.writeUInt8(size === 256 ? 0 : size, entryOffset);
  header.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
  header.writeUInt16LE(1, entryOffset + 4);
  header.writeUInt16LE(32, entryOffset + 6);
  header.writeUInt32LE(png.length, entryOffset + 8);
  header.writeUInt32LE(imageOffset, entryOffset + 12);
  imageOffset += png.length;
}
await writeFile(
  join(iconDirectory, "icon.ico"),
  Buffer.concat([header, ...windowsSizes.map((size) => images.get(size))]),
);

if (process.platform === "darwin") {
  execFileSync("iconutil", [
    "-c",
    "icns",
    iconsetDirectory,
    "-o",
    join(iconDirectory, "icon.icns"),
  ]);
} else {
  const macSizes = new Map([
    ["icp4", 16],
    ["icp5", 32],
    ["icp6", 64],
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024],
    ["ic11", 32],
    ["ic12", 64],
    ["ic13", 256],
    ["ic14", 512],
  ]);
  const chunks = [...macSizes].map(([type, size]) => {
    const png = images.get(size);
    const chunk = Buffer.alloc(8);
    chunk.write(type);
    chunk.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([chunk, png]);
  });
  const icnsHeader = Buffer.alloc(8);
  icnsHeader.write("icns");
  icnsHeader.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  await writeFile(join(iconDirectory, "icon.icns"), Buffer.concat([icnsHeader, ...chunks]));
}
await rm(iconsetDirectory, { recursive: true });
console.log("Generated Link Studio PNG, ICO and ICNS icons from resources/brand/icon.svg");
