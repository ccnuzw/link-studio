import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { build } from "vite";

const workspace = process.cwd();
const reference = path.resolve(process.env.AGENT_REFERENCE_WEB ?? "../video-canvas/web");
const revision = "4277d16f40457664e27a89efabac14d07c1d73e8";
const temp = await mkdtemp(path.join(tmpdir(), "link-settings-drawer-"));
const results = process.argv.includes("--approval-results");
const executed = process.argv.includes("--change-results");
const reviews = process.argv.includes("--plugin-review");
const changes = reviews || executed || process.argv.includes("--change-card");
const contexts = process.argv.includes("--page-context");
const rowMode = results || changes || contexts;
const output = path.join(
  workspace,
  contexts
    ? "test-results/settings-context-parity"
    : reviews
      ? "test-results/settings-plugin-review-parity"
      : executed
        ? "test-results/settings-change-result-parity"
        : changes
          ? "test-results/settings-change-card-parity"
          : results
            ? "test-results/settings-approval-parity"
            : "test-results/settings-drawer-parity",
);
const browser = await chromium.launch({ channel: "chrome" });
const report = {
  revision,
  browser: browser.version(),
  scope: results
    ? "审批结果行矩形（在抽屉中使用相同位置和宽度）"
    : "完整抽屉，固定纹理底图，模型加载 / 无模型（不含后台其余页面）",
  boxes: {},
  differences: {},
};
if (changes) report.scope = "配置字段变更卡矩形（从生产卡片到编辑拒绝说明）";
if (executed) report.scope = "配置结果卡矩形（已执行、部分选择、展开、回滚）";
if (reviews) report.scope = "待审插件卡矩形（首装、升级折叠、鼠标与键盘展开）";
if (contexts) report.scope = "当前页面引用组矩形（可移除、移除后、键盘焦点、已发消息只读）";
const states = contexts
  ? ["composer", "dismissed", "focused", "history"]
  : reviews
    ? ["new-plugin", "update-plugin", "code-open", "keyboard-open"]
    : executed
      ? ["executed", "partial-result", "expanded-result", "revert-result", "plugin-result"]
      : changes
        ? ["pending", "reverse-pending", "partial", "explain", "expanded", "rejected", "explained"]
        : results
          ? [
              "secret-executed",
              "secret-rejected",
              "secret-expired",
              "secret-failed",
              "trial-approved",
              "trial-executed",
              "trial-rejected",
              "trial-expired",
              "trial-failed",
            ]
          : ["closed", "loading", "no-model"];
const contextRefs = [
  { id: "page", label: "模型渠道", title: "/admin/ai/channels" },
  { id: "channel", label: "渠道：workspace-primary", title: "workspace-primary" },
  {
    id: "model",
    label: "模型：storyboard-model-with-long-identifier",
    title: "storyboard-model-with-long-identifier",
  },
];
const contextFixture = (upstream) =>
  `import {createElement,useState} from 'react';import {${upstream ? "ContextChips" : "SettingsContextChips"} as Chips} from '${upstream ? "@/pages/canvas/agent/context-chips" : "./src/renderer/settings/settings-context-chips"}';export function AdminAssistantPanel(){const [refs,setRefs]=useState(${JSON.stringify(contextRefs)});return createElement('div',{className:'row-fixture'},createElement(Chips,{refs,${upstream ? "onRemove" : "remove"}:location.hash==='#history'?undefined:(id)=>setRefs(values=>values.filter(entry=>entry.id!==id))}));}`;
const items = [
  { field: "label", before: "分镜模型", after: "影片模型" },
  { field: "model", before: "storyboard-v1", after: "storyboard-v2" },
  { field: "channel.api", before: "chat_completions", after: "responses" },
  { field: "channel.pathPrefix", before: null, after: "/api/v3" },
];
const pluginData = `const label='分镜适配器',key='storyboard',meta={name:label,vendor:'渠道工作室',auth:'bearer',endpoints:'{"text":{"mode":"sync","method":"POST","path":"/v1/responses"}}'},fresh=phase==='new-plugin',version=fresh?'1.0.0':'1.0.1';
  const request={method:'POST',url:'https://review.invalid/gateway/v1/responses'};
  const detail={plugin_key:key,version_before:fresh?null:'1.0.0',version_after:version,code_lines:3,code_diff:fresh?'':'--- before\\n+++ after\\n@@ -1,2 +1,3 @@\\n-exports.mode="sync";\\n-exports.name="分镜";\\n+exports.mode="sync";\\n+exports.name="分镜";\\n+exports.vendor="studio";\\n',meta,check:{ok:true,request,issues:[]}};
  const diff=Object.entries({'meta.auth':meta.auth,'meta.endpoints':meta.endpoints,'meta.name':label,'meta.vendor':meta.vendor,plugin_key:key,version}).map(([field,after])=>({field,before:null,after}));
  approval.payload={orderNo:order,kind:'plugin',items:[{field:'插件草稿',before:null,after:'draft-hash'}],review:{label,key,versionBefore:detail.version_before,versionAfter:version,lines:detail.code_lines,codeDiff:detail.code_diff,meta:Object.values(meta).join(' · '),request,diff}};`;
const changeData = `const items=${JSON.stringify(items)},order='CO-260102-AB29EF',priorOrder='CO-260101-028ACE',phase=location.hash.slice(1),rejected=['rejected','explained'].includes(phase),answer=phase==='explained'?'只改显示名称，保留模型标识。':undefined;const approval={id:'1',kind:'admin_change',status:rejected?'rejected':'pending',decision:{answer},payload:{orderNo:order,revertOf:phase==='reverse-pending'?priorOrder:undefined,expectedRevision:3,items}};${reviews ? pluginData : ""}`;
const receiptData = `${changeData}const appliedAt='2026-01-02T16:28:00Z',reverse=phase==='revert-result',plugin=phase==='plugin-result';
  const pluginDiff=Object.entries({'meta.auth':'bearer','meta.endpoints':'{"text":{"mode":"sync","method":"POST","path":"/v1/responses"}}','meta.name':'分镜适配器','meta.vendor':'渠道工作室',plugin_key:'storyboard',version:'2.0.1'}).map(([field,after])=>({field,before:null,after}));
  const entries=(plugin?[{field:'插件草稿',label:'分镜适配器',diff:pluginDiff,before:null,after:'2.0.1'}]:reverse?[items[3],items[0]]:items).map((item,index)=>({...item,...(reverse?{before:item.after,after:item.before}:{}),status:phase==='partial-result'&&index%2?'rejected':'applied'}));const applied=entries.filter(item=>item.status==='applied').length;const receipt={order,appliedAt,items:entries,applied,skipped:entries.length-applied,target:plugin?'plugin':'model',key:'test',navigable:true,reversible:!reverse&&!plugin};`;
const textByState = [
  "已保存密钥",
  "已跳过",
  "密钥请求已失效",
  "密钥未保存",
  "仍在运行",
  "试跑成功",
  "未试跑",
  "试跑请求已失效",
  "试跑失败",
];
const rowData = `const [kind,status]=location.hash.slice(1).split('-');const trial=kind==='trial',label='分镜助手 Storyboard 02',approval={id:'1',kind:trial?'admin_test_run':'admin_secret',status,payload:{model_label:label,channel_label:label},result:trial?{status:status==='executed'?'succeeded':status==='failed'?'failed':undefined}:{configured:status==='executed'?true:undefined}};`;
try {
  await mkdir(output, { recursive: true });
  execFileSync("git", [
    "-C",
    path.dirname(reference),
    "archive",
    "-o",
    path.join(temp, "web.tar"),
    revision,
    "web",
  ]);
  execFileSync("tar", ["-xf", path.join(temp, "web.tar"), "-C", temp]);
  const pinned = path.join(temp, "web");
  await symlink(path.join(reference, "node_modules"), path.join(pinned, "node_modules"), "dir");
  execFileSync(path.join(pinned, "node_modules/.bin/vite"), ["build", "--logLevel", "error"], {
    cwd: pinned,
  });
  for (const [side, root] of [
    ["baseline", pinned],
    ["desktop", workspace],
  ]) {
    const upstream = side === "baseline";
    const assets = path.join(root, upstream ? "dist/assets" : "out/renderer/assets");
    const styles = (await readdir(assets)).filter((file) => /^index-.*\.css$/.test(file));
    if (styles.length !== 1) throw Error(`找不到唯一的生产 CSS: ${assets}`);
    const component = upstream
      ? `import {AssistantDrawer} from './src/pages/admin/assistant/assistant-drawer';
      import {useAdminStore} from './src/store/admin';useAdminStore.setState({assistantOpen:open,role:'${reviews ? "super_admin" : "admin"}'});const drawer=<AssistantDrawer/>;`
      : executed
        ? `import {SettingsDrawer} from './src/renderer/settings/settings-drawer';import {SettingsChangeResult} from './src/renderer/settings/settings-change-result';${receiptData}const drawer=<SettingsDrawer open><section className="settings-assistant assistant-surface"><div className="row-fixture"><SettingsChangeResult receipt={receipt} resolveJump={()=>()=>{}} rollback={()=>{}}/></div></section></SettingsDrawer>;`
        : changes
          ? `import {SettingsDrawer} from './src/renderer/settings/settings-drawer';import {ApprovalCard} from './src/renderer/settings/settings-change-card';import {RejectedChange} from './src/renderer/settings/settings-action-result';${changeData}const drawer=<SettingsDrawer open><section className="settings-assistant assistant-surface"><div className="row-fixture">{rejected?<RejectedChange answer={answer}/>:<ApprovalCard approval={approval} disabled={false} decide={async()=>{}}/>}</div></section></SettingsDrawer>;`
          : contexts
            ? `import {SettingsDrawer} from './src/renderer/settings/settings-drawer';${contextFixture(false)}const drawer=<SettingsDrawer open><section className="settings-assistant assistant-surface"><AdminAssistantPanel/></section></SettingsDrawer>;`
            : results
              ? `import {SettingsDrawer} from './src/renderer/settings/settings-drawer';import {SettingsActionResult} from './src/renderer/settings/settings-action-result';${rowData}
      const drawer=<SettingsDrawer open><section className="settings-assistant assistant-surface"><div className="row-fixture"><SettingsActionResult kind={approval.kind} status={status} result={trial?{tested:status==='executed'}:approval.result} label={label}/></div></section></SettingsDrawer>;`
              : `import {SettingsDrawer} from './src/renderer/settings/settings-drawer'; import {AssistantModelState} from './src/renderer/assistant/assistant-model-state';
      const drawer=<SettingsDrawer open={open}><AssistantModelState settings loading={state==='loading'}/></SettingsDrawer>;`;
    const script = `import {createRoot} from 'react-dom/client';const state=location.hash.slice(1), open=state!=='closed';${component}
      createRoot(document.querySelector('main')).render(<><div className="settings-page-content" style={{flex:1,minWidth:0}}/>{drawer}</>);`;
    const entry = path.join(root, "drawer-fixture.jsx");
    const bundle = path.join(temp, side);
    const stubs = {
      ...(contexts && { "admin-assistant-panel": contextFixture(true) }),
      ...(changes && {
        "admin-assistant-panel": `import {ApprovalRow} from '@/pages/canvas/agent/approval-row';import {createElement} from 'react';${changeData}const revert=approval.payload.revertOf;approval.payload={order_no:order,revert_of:revert,title:revert?'回滚变更单 '+revert:'配置变更单',reason:revert?'恢复该单已应用条目的改前值':'基线修订 3',items:items.map(({field,before,after})=>({key:field,label:field,diff:[{path:field,before,after}]}))};export function AdminAssistantPanel(){return createElement('div',{className:'row-fixture'},createElement(ApprovalRow,{approvalId:'1',ctl:{state:{approvals:{1:approval}},pending:rejected?null:approval}}));}`,
      }),
      ...(results && {
        "admin-assistant-panel": `import {ApprovalRow} from '@/pages/canvas/agent/approval-row';import {createElement} from 'react';${rowData}export function AdminAssistantPanel(){return createElement('div',{className:'row-fixture'},createElement(ApprovalRow,{approvalId:'1',ctl:{state:{approvals:{1:approval}}}}));}`,
      }),
      ...(reviews && {
        "admin-assistant-panel": `import {ApprovalRow} from '@/pages/canvas/agent/approval-row';import {createElement} from 'react';${changeData}approval.payload={order_no:order,title:'配置变更单',items:[{target:'plugin',required_role:'super_admin',key,label,detail,diff:diff.map(({field,before,after})=>({path:field,before,after}))}]};export function AdminAssistantPanel(){return createElement('div',{className:'row-fixture'},createElement(ApprovalRow,{approvalId:'1',ctl:{state:{approvals:{1:approval}},pending:approval}}));}`,
      }),
      ...(executed && {
        "admin-assistant-panel": `import {ApprovalRow} from '@/pages/canvas/agent/approval-row';import {createElement} from 'react';${receiptData}approval.status='executed';approval.payload={order_no:order,revert_of:reverse?priorOrder:'',items:entries.map(item=>({target:receipt.target,key:'test',label:item.label??item.field,diff:(item.diff??[item]).map(({field,before,after})=>({path:field,before,after}))}))};approval.result={applied_at:appliedAt,items:entries.map(({status},index)=>({index,status}))};export function AdminAssistantPanel(){return createElement('div',{className:'row-fixture'},createElement(ApprovalRow,{approvalId:'1',ctl:{state:{approvals:{1:approval}}}}));}`,
      }),
      "hooks/use-agent-controller": `export const useAgentModels=()=>location.hash==='#loading'?null:[];export const useAgentController=()=>({});`,
      "hooks/use-admin-page-context": "export const useAdminPageContext=()=>({});",
      "pages/canvas/agent/agent-panel":
        'export function AgentPanel(){throw Error("无模型不应显示输入框")}',
    };
    await build({
      root,
      configFile: false,
      publicDir: false,
      logLevel: "error",
      define: { "process.env.NODE_ENV": '"production"' },
      resolve: { alias: { "@": path.join(root, "src") } },
      oxc: { jsx: { runtime: "automatic" } },
      plugins: [
        {
          name: "drawer-fixture",
          enforce: "pre",
          resolveId(id) {
            if (id === entry) return entry;
            const key = upstream && Object.keys(stubs).find((name) => id.endsWith("/" + name));
            if (key) return "\0stub:" + key;
          },
          load(id) {
            if (id === entry) return script;
            if (id.startsWith("\0stub:")) return stubs[id.slice(6)];
          },
        },
      ],
      build: { outDir: bundle, lib: { entry, formats: ["es"], fileName: () => "fixture.js" } },
    });
    const page = await browser.newPage({ deviceScaleFactor: 1, reducedMotion: "reduce" });
    try {
      await page.route("http://drawer.test/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/fixture.js")
          return route.fulfill({
            path: path.join(bundle, "fixture.js"),
            contentType: "text/javascript",
          });
        if (url.pathname === "/index.css")
          return route.fulfill({ path: path.join(assets, styles[0]), contentType: "text/css" });
        if (url.pathname.endsWith(".woff2"))
          return route.fulfill({
            path: path.join(assets, path.basename(url.pathname)),
            contentType: "font/woff2",
          });
        if (url.pathname !== "/") return route.abort();
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html class="${upstream ? "admin-theme" : ""} ${upstream && url.searchParams.has("dark") ? "dark" : ""}"><meta charset=utf-8><link rel=stylesheet href=/index.css><style>body{margin:0}main{display:flex;height:100vh;background:repeating-linear-gradient(32deg,#888 0 13px,#556 13px 29px)!important}.row-fixture{position:absolute;top:24px;left:12px;right:12px}</style><main class="${upstream ? "" : "model-settings"}"></main><script type=module src=/fixture.js></script>`,
        });
      });
      for (const width of rowMode ? [320, 1080] : [767, 768, 1080])
        for (const theme of ["light", "dark"])
          for (const state of states) {
            const key = `${width}-${theme}-${state}`;
            await page.setViewportSize({ width, height: reviews ? 760 : changes ? 560 : 420 });
            await page.emulateMedia({ colorScheme: theme });
            await page.goto(
              `http://drawer.test/?sample=${key}${theme === "dark" ? "&dark" : ""}#${state}`,
            );
            const wrapper = page.locator("aside");
            await wrapper.waitFor({ state: "attached" });
            if (
              state === "closed" &&
              !(await wrapper.evaluate((el) => el.inert && !el.firstElementChild?.children.length))
            )
              throw Error("首次关闭时仍挂载了面板");
            if (state === "loading") await wrapper.locator("[aria-busy=true]").waitFor();
            if (state === "no-model")
              await page.getByText("请先在模型渠道发布 Agent 模型").waitFor();
            const row = wrapper.locator(".row-fixture > :first-child");
            if (contexts) {
              await row.getByText("模型渠道", { exact: true }).waitFor();
              if (state === "dismissed")
                await row.getByRole("button", { name: "移除 渠道：workspace-primary" }).click();
              if (state === "focused") {
                await row.getByRole("button").first().focus();
                await page.keyboard.press("Tab");
              }
              await page.mouse.move(0, 410);
            } else if (executed) {
              await row.getByText(/变更单 CO-260102-AB29EF · 已应用/).waitFor();
              if (state === "plugin-result")
                await row.getByText("meta.endpoints", { exact: true }).waitFor();
              if (state === "expanded-result")
                await row.getByRole("button", { name: "还有 1 项" }).click();
              await page.mouse.move(0, 410);
            } else if (changes && ["rejected", "explained"].includes(state))
              await row
                .getByText(
                  state === "explained"
                    ? "已拒绝：配置变更单 · 你的说明：只改显示名称，保留模型标识。"
                    : "已拒绝：配置变更单",
                  { exact: true },
                )
                .waitFor();
            else if (changes) {
              await row
                .getByRole("option", { name: reviews ? /应用 1 项变更/ : /应用 4 项变更/ })
                .waitFor();
              if (state === "code-open")
                await row.getByRole("button", { name: "代码差异" }).click();
              if (state === "keyboard-open")
                await row.getByRole("button", { name: "代码差异" }).press("Enter");
              if (state === "expanded")
                await row.getByRole("button", { name: "还有 1 项" }).click();
              if (state === "partial") {
                await row.getByRole("checkbox").first().click();
                await row.getByRole("option", { name: /应用 3 项变更/ }).waitFor();
              }
              if (state === "explain") {
                await row.getByRole("option", { name: /拒绝，并告诉助手怎么改/ }).click();
                await row.getByRole("textbox").fill("保留模型标识");
              }
              await page.mouse.move(0, 410);
              await page.evaluate(async () => {
                await Promise.all(
                  document
                    .getAnimations()
                    .filter((animation) => animation.effect.getTiming().iterations !== Infinity)
                    .map((animation) => animation.finished.catch(() => {})),
                );
              });
            }
            if (results)
              await row
                .getByText(
                  textByState[states.indexOf(state)] +
                    (state.startsWith("trial") ? " · 分镜助手 Storyboard 02" : ""),
                  { exact: true },
                )
                .waitFor();
            await page.evaluate(() => document.fonts.ready);
            if (changes && width === 1080 && theme === "light") {
              report.details ??= {};
              report.details[`${key}-${side}`] = await row.evaluate((element) =>
                [
                  element,
                  ...element.querySelectorAll(
                    "li:first-child span,li:first-child code,li:first-child strong,[role=option],button",
                  ),
                ].map((child) => {
                  const style = getComputedStyle(child),
                    box = child.getBoundingClientRect();
                  return {
                    text: child.textContent.slice(0, 44),
                    box: [box.x, box.y, box.width, box.height],
                    font: style.font,
                    background: style.backgroundColor,
                    outline: style.outline,
                    color: style.color,
                  };
                }),
              );
            }
            report.boxes[key] ??= {};
            report.boxes[key][side] = await (rowMode
              ? row
              : wrapper.locator(":scope > div")
            ).boundingBox();
            if (
              rowMode &&
              !upstream &&
              JSON.stringify(report.boxes[key].baseline) !==
                JSON.stringify(report.boxes[key].desktop)
            )
              throw Error(`组件几何不一致: ${key} ${JSON.stringify(report.boxes[key])}`);
            const surface = rowMode ? row : page;
            let image = await surface.screenshot();
            let stable = false;
            for (let attempt = 0; attempt < 5 && !stable; attempt++) {
              await page.evaluate(
                () =>
                  new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                  ),
              );
              const next = await surface.screenshot();
              stable = next.equals(image);
              image = next;
            }
            if (!stable) throw Error(`截图不稳定: ${key}`);
            await writeFile(path.join(output, `${side}-${key}.png`), image);
            if (!upstream) {
              const baseline = await readFile(path.join(output, `baseline-${key}.png`));
              report.differences[key] = await page.evaluate(
                async (images) => {
                  const [left, right] = await Promise.all(
                    images.map(async (data) => {
                      const img = new Image();
                      img.src = "data:image/png;base64," + data;
                      await img.decode();
                      const canvas = document.createElement("canvas");
                      canvas.width = img.width;
                      canvas.height = img.height;
                      const ctx = canvas.getContext("2d");
                      ctx.drawImage(img, 0, 0);
                      return new Uint32Array(
                        ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer,
                      );
                    }),
                  );
                  return left.length !== right.length
                    ? "size mismatch"
                    : left.reduce(
                        (count, color, index) => count + Number(color !== right[index]),
                        0,
                      );
                },
                [baseline, image].map((buffer) => buffer.toString("base64")),
              );
            }
          }
    } finally {
      await page.close();
    }
  }
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(report.differences);
  if (Object.values(report.differences).some((value) => value !== 0)) throw Error("抽屉像素不一致");
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
