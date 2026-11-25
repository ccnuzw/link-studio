const { app, WebContentsView } = require("electron");
const { mkdtemp, readFile, readdir, writeFile, copyFile, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");

async function verify() {
  if (process.platform === "darwin") app.setActivationPolicy("prohibited");
  const directory = await mkdtemp(join(tmpdir(), "link-worker-check-"));
  let contents;
  try {
    app.setPath("userData", directory);
    await app.whenReady();
    const root = join(__dirname, "../out/renderer");
    const html = await readFile(join(root, "index.html"), "utf8");
    const policy = html.match(/<meta[^>]*Content-Security-Policy[^>]*>/i)?.[0];
    assert.ok(policy);
    const workers = (await readdir(join(root, "assets"))).filter((file) =>
      /^canvas-export\.worker-[\w-]+\.js$/.test(file),
    );
    assert.equal(workers.length, 1);
    await copyFile(join(root, "assets", workers[0]), join(directory, "worker.js"));
    await writeFile(
      join(directory, "probe.html"),
      `<!doctype html><html><head>${policy}</head><body></body></html>`,
    );
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: "canvas-worker-check",
      },
    });
    contents = view.webContents;
    await contents.loadURL(pathToFileURL(join(directory, "probe.html")).href);
    const format = await contents.executeJavaScript(
      `new Promise((resolve,reject)=>{const worker=new Worker(new URL('./worker.js',location.href),{type:'module'});const timer=setTimeout(()=>{worker.terminate();reject(Error('worker timed out'));},5000);worker.onerror=()=>{clearTimeout(timer);worker.terminate();reject(Error('worker load failed'));};worker.onmessage=({data})=>{clearTimeout(timer);worker.terminate();if(data.error)reject(Error(data.error));else resolve(JSON.parse(data.result.json).format);};worker.postMessage([{schemaVersion:1,revision:1,nodes:[],edges:[],viewport:{x:0,y:0,zoom:1}},'打包回放',[]]);})`,
    );
    assert.equal(format, "video-canvas/canvas");
    console.log(
      "Packaged worker exported successfully under Electron file:// and production CSP; no window created.",
    );
  } finally {
    contents?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
verify().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
