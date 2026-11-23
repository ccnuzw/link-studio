import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, _electron as electron, expect } from "@playwright/test";
import { build } from "vite";
import { createIdCodec } from "../packages/agent-runtime/upstream/src/ids.ts";

const testRequire = createRequire(import.meta.resolve("@playwright/test"));
const { PNG } = createRequire(testRequire.resolve("playwright"))("playwright-core/lib/utilsBundle");

async function compareScreenshot(sample) {
  const images = await Promise.all(
    ["reference", "desktop"].map(async (side) =>
      PNG.sync.read(await readFile(path.join(output, `${sample}-${side}.png`))),
    ),
  );
  const [baseline, desktop] = images;
  const sizes = images.map((image) => [image.width, image.height]);
  if (baseline.width !== desktop.width || baseline.height !== desktop.height) return { sizes };
  let differing = 0;
  let oneLevel = 0;
  for (let offset = 0; offset < baseline.data.length; offset += 4) {
    let maxDifference = 0;
    for (let channel = offset; channel < offset + 4; channel++) {
      maxDifference = Math.max(
        maxDifference,
        Math.abs(baseline.data[channel] - desktop.data[channel]),
      );
    }
    if (maxDifference > 0) differing++;
    if (maxDifference === 1) oneLevel++;
  }
  return { sizes, differing, oneLevel, total: baseline.width * baseline.height };
}

const revision = "ff4070c7b23581b1a79eacbfeddc56f836562377";
const reference = path.resolve(process.env.AGENT_REFERENCE_WEB ?? "../video-canvas/web");
const output = path.resolve("test-results/assistant-workspaces");
const temp = await mkdtemp(path.join(tmpdir(), "link-workspaces-"));
const root = path.join(temp, "web");
const report = { revision, samples: {}, pickers: {}, renderers: {} };
const recordings = {};
const idCodec = createIdCodec("link-studio-m0");
function record(scope, stage, partial = "") {
  const database = new DatabaseSync(path.join(temp, scope, "settings", "agent.sqlite"), {
    readOnly: true,
  });
  try {
    const rows = database
      .prepare(`SELECT seq, type, CAST(run_id AS TEXT) AS run_id, payload, created_at FROM agent_events
      WHERE session_id = (SELECT session_id FROM agent_events WHERE type='message.user' ORDER BY id DESC LIMIT 1) ORDER BY seq`)
      .all();
    assert.ok(rows.some((row) => row.type === "message.user"));
    const events = rows.map(({ payload, created_at, run_id, ...event }) => ({
      ...event,
      run_id: run_id && run_id !== "0" ? idCodec.encodeDecimal(run_id) : "",
      data: JSON.parse(payload),
      created_at: new Date(created_at).toISOString(),
    }));
    if (partial)
      events.push({
        seq: 0,
        type: "message.delta",
        run_id: events.at(-1).run_id,
        data: { text: partial },
      });
    recordings[`${scope}-${stage}`] = events;
  } finally {
    database.close();
  }
}
const question = "核对本次工作区配置";
const interjection = "补充核对模型名称";
const answer = "已核对当前配置，可以继续。";
const richAnswer =
  "## 分镜检查\n\n1. 开场\n2. 使用 `近景`\n\n> 保持机位\n\n```text\n镜头一\n```\n\n|镜头|景别|\n|---|---|\n|一|近景|";
let rich = false;
let planning = false;
let asking = false;
let failing = false;
let repeatSteps = 0;
const askLabel = "核对哪个范围？";
const planSteps = [
  { title: "读取当前配置", status: "done" },
  { title: "核对模型名称", status: "doing" },
];
let responseGate;
let finishGate;
const prefix = "已核对当前配置";
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const prompt = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const titleRequest = prompt.messages?.some(
    (message) => message.role === "system" && String(message.content).includes("会话命名助手"),
  );
  await responseGate;
  const frame = (delta, finish_reason) =>
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  if (failing && !titleRequest) {
    response.writeHead(400, { "content-type": "application/json" });
    return response.end(
      JSON.stringify({ error: { type: "invalid_request_error", message: "测试模型拒绝本次输入" } }),
    );
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (titleRequest)
    return response.end(
      frame({ role: "assistant", content: question }, null) +
        frame({}, "stop") +
        "data: [DONE]\n\n",
    );
  if (repeatSteps > 0) {
    const call = {
      index: 0,
      id: `step-${repeatSteps++}`,
      type: "function",
      function: { name: "plan_update", arguments: JSON.stringify({ steps: planSteps }) },
    };
    return response.end(
      frame({ role: "assistant", tool_calls: [call] }, null) +
        frame({}, "tool_calls") +
        "data: [DONE]\n\n",
    );
  }
  if (asking && !prompt.messages?.some((message) => message.role === "tool")) {
    const args = {
      questions: [{ question: askLabel, kind: "choice", options: ["所有渠道", "当前渠道"] }],
    };
    const call = {
      index: 0,
      id: "range-call",
      type: "function",
      function: { name: "ask_user", arguments: JSON.stringify(args) },
    };
    return response.end(
      frame({ role: "assistant", tool_calls: [call] }, null) +
        frame({}, "tool_calls") +
        "data: [DONE]\n\n",
    );
  }
  if (planning) {
    if (!prompt.messages?.some((message) => message.role === "tool")) {
      return response.end(
        frame(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "plan-call",
                type: "function",
                function: { name: "plan_update", arguments: JSON.stringify({ steps: planSteps }) },
              },
            ],
          },
          null,
        ) +
          frame({}, "tool_calls") +
          "data: [DONE]\n\n",
      );
    }
    await finishGate;
  }
  if (rich)
    return response.end(
      frame({ role: "assistant", content: richAnswer }, null) +
        frame({}, "stop") +
        "data: [DONE]\n\n",
    );
  response.write(frame({ role: "assistant", content: prefix }, null));
  await finishGate;
  response.end(
    frame({ content: answer.slice(prefix.length) }, null) + frame({}, "stop") + "data: [DONE]\n\n",
  );
});
const boxes = async (panel, selectors) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(selectors).map(async ([key, selector]) => {
        const anchor = await panel.boundingBox();
        const rect = await panel.locator(selector).first().boundingBox();
        if (!anchor || !rect) throw Error(`missing ${key}`);
        return [
          key,
          [rect.x - anchor.x, rect.y - anchor.y, rect.width, rect.height].map(Math.round),
        ];
      }),
    ),
  );

async function capture(page, panel, scope, side, state = "empty") {
  const chat = state === "chat";
  const working = state === "working";
  const streaming = state === "streaming";
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    if (side === "reference")
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.fonts.ready);
    const key = `${scope}-${theme}${state === "empty" ? "" : `-${state}`}`;
    const file = path.join(output, `${key}-${side}.png`);
    await panel.screenshot({ path: file, animations: "disabled", scale: "css" });
    report.samples[key] ??= {};
    const sample = report.samples[key];
    sample[side] = await boxes(panel, {
      header: "header",
      ...(chat || working || streaming
        ? {
            bubble:
              side === "reference"
                ? ".agent-inset.whitespace-pre-wrap"
                : ".agent-user-bubble, .settings-user-message > div:last-child",
            ...(working
              ? { working: '[role=status]:has-text("思考中…")' }
              : streaming
                ? { reply: `p:text-is("${prefix}")` }
                : {
                    reply: `p:text-is("${answer}")`,
                    feedback: side === "reference" ? "[data-slot=run-feedback]" : ".run-feedback",
                  }),
          }
        : {
            orb: side === "reference" ? ".agent-scroll .agent-orb" : ".assistant-orb",
            starter: "button:has(svg.lucide-clapperboard),button:has(svg.lucide-settings-2)",
          }),
      composer: side === "reference" ? ".agent-composer" : ".assistant-composer",
      send: working || streaming ? 'button[aria-label^="停止"]' : 'button[aria-label="发送"]',
    });
  }
}

async function checkAgentPicker(page, scope, side) {
  const trigger = page.getByRole("button", { name: "Agent 模型", exact: true });
  await trigger.click();
  const popup = page.locator(
    side === "reference" ? "[data-slot=popover-content]" : ".agent-model-picker",
  );
  const option = popup.getByRole("radio", { checked: true });
  await expect(option).toContainText("工作区模型");
  await expect(popup).toHaveAttribute("data-side", "top");
  await expect
    .poll(async () => {
      const anchor = await trigger.boundingBox(),
        box = await popup.boundingBox();
      return (
        !!anchor &&
        !!box &&
        box.width === 260 &&
        Math.abs(anchor.y - box.y - box.height - 8) <= 1 &&
        Math.abs(anchor.x + anchor.width - box.x - box.width) <= 1
      );
    })
    .toBe(true);
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    if (side === "reference")
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
    for (const hover of [false, true]) {
      if (hover) await option.hover();
      else await page.mouse.move(0, 0);
      const key = `${scope}-${theme}-agent-model${hover ? "-hover" : ""}`;
      await popup.screenshot({
        path: path.join(output, `${key}-${side}.png`),
        scale: "css",
        animations: "disabled",
      });
      report.samples[key] ??= {};
      report.samples[key][side] = await boxes(popup, {
        title: "p",
        option: "[role=radio]",
        check: "[role=radio] > svg:last-child",
      });
    }
  }
  await popup.press("Escape");
  await expect(popup).toBeHidden();
}

async function checkInsertPickers(page, side) {
  for (const [name, width] of [
    ["插入模型", 340],
    ["插入技能", 372],
  ]) {
    const trigger = page.getByRole("button", { name, exact: true });
    await trigger.click();
    const popup = page.locator(
      side === "reference" ? "[data-slot=popover-content]" : ".assistant-model-menu",
    );
    await expect(popup).toBeVisible();
    await expect(
      popup.getByText(name === "插入技能" ? "还没有启用的技能" : "还没有已发布的图片模型", {
        exact: true,
      }),
    ).toBeVisible();
    const measure = async () => {
      const anchor = await trigger.boundingBox(),
        box = await popup.boundingBox();
      const edge = await page.evaluate(() => document.documentElement.clientWidth);
      assert.equal(await popup.getAttribute("data-side"), "top");
      assert.equal(box.width, width);
      assert.ok(Math.abs(anchor.y - box.y - box.height - 8) <= 1);
      assert.ok(Math.abs(Math.min(anchor.x, edge - width - 5) - box.x) <= 1);
      return { anchor, box };
    };
    await expect(async () => {
      await measure();
    }).toPass({ timeout: 4000 });
    report.pickers[`${side}-${name}`] = { ...(await measure()), text: await popup.innerText() };
    if (name === "插入模型") {
      for (const [kind, state] of [
        ["图片", "image"],
        ["视频", "video"],
      ]) {
        await popup.getByRole("radio", { name: kind, exact: true }).click();
        await expect(popup.getByText(`还没有已发布的${kind}模型`)).toBeVisible();
        const active = popup.getByRole("radio", { name: kind, checked: true });
        await expect
          .poll(async () => {
            const target = await active.boundingBox(),
              thumb = await active.locator(":scope > :first-child").boundingBox();
            return !!target && !!thumb && Math.abs(target.x - thumb.x) < 0.05;
          })
          .toBe(true);
        await capturePicker(page, popup, side, state, { tabs: "[role=radiogroup]", notice: "p" });
      }
    } else {
      await capturePicker(page, popup, side, "skills-empty", {
        tabs: "[role=tablist]",
        search: "input",
        notice: "p",
      });
    }
    await popup.press("Escape");
    await expect(popup).toBeHidden();
  }
}

async function capturePicker(page, popup, side, state, selectors) {
  await page.mouse.move(0, 0);
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    if (side === "reference")
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
    const key = `canvas-${theme}-${state}`;
    await popup.screenshot({
      path: path.join(output, `${key}-${side}.png`),
      scale: "css",
      animations: "disabled",
    });
    report.samples[key] ??= {};
    report.samples[key][side] = await boxes(popup, selectors);
  }
}

async function checkEnabledSkill(page, side) {
  const editor = page.locator("[contenteditable=true][role=textbox]");
  await editor.fill("使用");
  await page.getByRole("button", { name: "插入技能", exact: true }).click();
  const popup = page.locator(
    side === "reference" ? "[data-slot=popover-content]" : ".assistant-skill-menu",
  );
  const row = popup.getByRole("button", { name: /镜头清单/ });
  await expect(row).toContainText("整理镜头");
  await capturePicker(page, popup, side, "skills-enabled", {
    tabs: "[role=tablist]",
    search: "input",
    row: "li button",
  });
  const search = popup.getByRole("textbox", { name: "搜索技能" });
  await search.fill("无匹配");
  await expect(popup.getByText("没有找到匹配的技能")).toBeVisible();
  await search.fill("SHOT-LIST");
  await expect(row).toBeVisible();
  await row.click();
  await expect(popup).toBeHidden();
  const chip = editor
    .locator("[contenteditable=false]")
    .filter({ has: page.locator("svg") })
    .last();
  await expect(chip).toContainText("镜头清单");
  await capturePicker(page, editor, side, "skill-draft", {
    chip: "[contenteditable=false]:has(svg)",
    icon: "svg",
  });
  await editor.press("ControlOrMeta+z");
  await expect(chip).toHaveCount(0);
  await editor.fill("");
}

async function captureNodeReference(page, side) {
  const editor = page.getByRole("textbox", {
    name: side === "reference" ? "给 Agent 的消息" : "画布消息",
  });
  const ghostSelector = side === "reference" ? ".border-dashed" : ".agent-editor-ghost";
  await expect(editor.locator(ghostSelector)).toHaveText("图片");
  await capturePicker(page, editor, side, "node-ghost", { chip: ghostSelector, icon: "svg" });
  await editor.click();
  await expect(editor.locator(ghostSelector)).toHaveCount(0);
  const chipSelector = "[contenteditable=false]:has(> svg)";
  await expect(editor.locator(chipSelector)).toHaveText("图片");
  await capturePicker(page, editor, side, "node-committed", { chip: chipSelector, icon: "svg" });
  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveText("");
}

async function captureMarkdown(page, panel, scope, side) {
  const body = panel
    .getByRole("heading", { name: "分镜检查", exact: true, level: 3 })
    .locator("..");
  await expect(body.getByRole("table")).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    if (side === "reference")
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
    await page.evaluate(() => document.fonts.ready);
    const key = `${scope}-${theme}-markdown`;
    if (process.env.AGENT_COMPARE_CSS && scope === "canvas" && theme === "light") {
      const session = await page.context().newCDPSession(page);
      await session.send("DOM.enable");
      await session.send("CSS.enable");
      const { root } = await session.send("DOM.getDocument");
      for (const selector of ["li code", "pre code"]) {
        const { nodeId } = await session.send("DOM.querySelector", {
          nodeId: root.nodeId,
          selector,
        });
        if (nodeId)
          console.log(
            side,
            selector,
            await session.send("CSS.getPlatformFontsForNode", { nodeId }),
          );
      }
      await session.detach();
    }
    if (process.env.AGENT_COMPARE_CSS && scope === "canvas" && theme === "light")
      console.log(
        side,
        await body.evaluate((el) =>
          Array.from(el.querySelectorAll("blockquote,blockquote p,li code,pre,pre code,table")).map(
            (node) => {
              const css = getComputedStyle(node);
              return [
                node.tagName,
                css.fontFamily,
                css.fontSize,
                css.lineHeight,
                css.margin,
                css.padding,
                css.borderWidth,
                css.display,
                css.verticalAlign,
              ];
            },
          ),
        ),
      );
    await body.screenshot({
      path: path.join(output, `${key}-${side}.png`),
      animations: "disabled",
      scale: "css",
    });
    report.samples[key] ??= {};
    report.samples[key][side] = await boxes(body, {
      heading: "h3",
      list: "ol",
      inline: "li code",
      quote: "blockquote",
      code: "pre",
      table: "table",
    });
  }
}

async function captureStopped(page, panel, scope, side) {
  const card = panel.getByText("已停止", { exact: true }).locator("../..").locator("..");
  const resend = panel.getByRole("button", { name: "作为新消息发送" });
  await expect(resend).toBeVisible();
  await expect(card).toContainText("没做完的计划还留着");
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    if (side === "reference")
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
    const sample = `${scope}-${theme}-stopped`;
    await card.screenshot({
      path: path.join(output, `${sample}-${side}.png`),
      animations: "disabled",
      scale: "css",
    });
    report.samples[sample] ??= {};
    report.samples[sample][side] = {
      ...(await boxes(panel, {
        card: 'text="已停止" >> ../../..',
        resend: 'button:text-is("作为新消息发送")',
      })),
      ...(await boxes(card, {
        icon: "svg",
        title: 'text="已停止"',
        hint: 'text="没做完的计划还留着，可以接着让它做"',
      })),
    };
  }
}

async function capturePlan(page, panel, scope, side) {
  const toggle = panel.getByRole("button", { name: "展开计划" });
  await expect(toggle).toContainText("1/2");
  await toggle.click();
  await page.mouse.move(0, 0);
  const strip = panel.getByRole("button", { name: "收起计划" }).locator("../..");
  await expect(panel.getByRole("region", { name: "等待读取的插话" })).toHaveCount(0);
  await expect(strip.getByRole("listitem")).toHaveText(planSteps.map((step) => step.title));
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    if (side === "reference")
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
    const sample = `${scope}-${theme}-plan`;
    await strip.screenshot({
      path: path.join(output, `${sample}-${side}.png`),
      animations: "disabled",
      scale: "css",
    });
    report.samples[sample] ??= {};
    report.samples[sample][side] = await boxes(strip, {
      steps: "ul",
      first: "li",
      toggle: "button",
      ring: "button svg",
    });
  }
}

async function captureQuickQuestion(page, panel, scope, side) {
  const card = panel.getByRole("group", { name: askLabel, exact: true });
  await expect(card.getByRole("option")).toHaveCount(2);
  const waiting = panel.getByRole("status").filter({ hasText: "等你回答 ↓" });
  await expect(waiting).toBeVisible();
  assert.ok(
    (await waiting.boundingBox()).y >=
      (await card.boundingBox()).y + (await card.boundingBox()).height,
  );
  await page.mouse.move(0, 0);
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    if (side === "reference")
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
    const sample = `${scope}-${theme}-question`;
    await card.screenshot({
      path: path.join(output, `${sample}-${side}.png`),
      animations: "disabled",
      scale: "css",
    });
    report.samples[sample] ??= {};
    report.samples[sample][side] = {
      ...(await boxes(panel, {
        card: `:is(fieldset,[role="group"])[aria-label="${askLabel}"]`,
        activity: 'button[aria-label="处理中"]',
      })),
      ...(await boxes(card, {
        icon: "svg",
        options: "[role=listbox]",
        first: "[role=option]",
        number: "[role=option] span:not([aria-hidden])",
      })),
    };
  }
}

async function captureAnswered(page, panel, scope, side) {
  const row = panel.getByLabel("你的回答：当前渠道", { exact: true });
  await expect(row).toContainText(askLabel);
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    if (side === "reference")
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
    const sample = `${scope}-${theme}-answered`;
    await row.screenshot({
      path: path.join(output, `${sample}-${side}.png`),
      animations: "disabled",
      scale: "css",
    });
    report.samples[sample] ??= {};
    report.samples[sample][side] = {
      ...(await boxes(panel, { record: '[aria-label="你的回答：当前渠道"]' })),
      ...(await boxes(row, { icon: "svg", prompt: "span", answer: ":scope > :last-child" })),
    };
  }
}

async function captureEndState(page, panel, scope, side, state) {
  const limit = state === "limit";
  const title = limit ? "达到本轮步数上限" : "运行失败";
  const card = panel.getByText(title, { exact: true }).locator("../../..");
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "继续", exact: true })).toHaveCount(limit ? 1 : 0);
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    if (side === "reference")
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
    const sample = `${scope}-${theme}-${state}`;
    await card.screenshot({
      path: path.join(output, `${sample}-${side}.png`),
      animations: "disabled",
      scale: "css",
    });
    report.samples[sample] ??= {};
    report.samples[sample][side] = await boxes(card, {
      icon: "svg",
      title: `text="${title}"`,
      hint: "p:last-child",
      ...(limit && { resume: "button" }),
    });
  }
}

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await mkdir(output, { recursive: true });
  const archive = path.join(temp, "reference.tar");
  execFileSync("git", ["-C", reference, "archive", "-o", archive, revision, "--", "."]);
  await mkdir(root);
  execFileSync("tar", ["-xf", archive, "-C", root]);
  await symlink(path.join(reference, "node_modules"), path.join(root, "node_modules"));
  execFileSync(path.join(root, "node_modules/.bin/vite"), ["build", "--logLevel", "error"], {
    cwd: root,
  });
  const entry = path.join(root, "workspace-fixture.jsx");
  const controller = `import {buildTimeline,buildStatusLine,buildRunStrip} from '@/utils/agent/timeline';
    import {emptySession,applyAgentEvent,activeRunId} from '@/utils/agent/session-state';
    const state=(window.recordedEvents || []).reduce(applyAgentEvent,emptySession());
    export const useAgentModels=()=>[{key:'fixture',name:'工作区模型'}];
    export const useAgentController=()=>({sessions:[],session:state.events.length?{title:${JSON.stringify(question)}}:undefined,busy:!!activeRunId(state),
      pending:Object.values(state.approvals).findLast(a => a.run_id === activeRunId(state) && a.status === 'pending'),
      timeline:buildTimeline(state),strip:buildRunStrip(state,new Set()),statusLine:buildStatusLine(state),
      state,modelKey:'fixture',context:{tokens:state.contextTokens,window:32000}});`;
  await writeFile(
    entry,
    `import {createRoot} from 'react-dom/client'; import {ReactFlowProvider} from '@xyflow/react'; import {TooltipProvider} from '@/components/ui/tooltip'; import {AgentPanel} from '@/pages/canvas/agent/agent-panel'; import {AssistantDrawer} from '@/pages/admin/assistant/assistant-drawer'; import {useAdminStore} from '@/store/admin'; import {useAgentController,useAgentModels} from '@/hooks/use-agent-controller'; useAdminStore.setState({assistantOpen:true}); function Sample(){const ctl=useAgentController(),models=useAgentModels();return <TooltipProvider><ReactFlowProvider>{location.pathname==='/settings'?<AssistantDrawer/>:<AgentPanel ctl={ctl} models={models} onClose={()=>{}} selection={location.search==='?selection'?['fixture-image']:[]} nodes={[]} refNodes={[{id:'fixture-image',kind:'image',label:'图片'}]}/>}</ReactFlowProvider></TooltipProvider>}; createRoot(document.querySelector('main')).render(<Sample/>);`,
  );
  const bundle = path.join(temp, "fixture");
  await writeFile(path.join(temp, "controller.js"), controller);
  await writeFile(
    path.join(temp, "skill-api.js"),
    "export async function getAgentSkills(){return window.fixtureSkills ?? []}",
  );
  await writeFile(
    path.join(temp, "page.js"),
    `export const useAdminPageContext=()=>({chips:[{id:'page',label:'模型渠道',title:'模型渠道'}],remove:()=>{}})`,
  );
  await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: "error",
    resolve: {
      alias: {
        "@/hooks/use-agent-controller": path.join(temp, "controller.js"),
        "@/api/agent/skill": path.join(temp, "skill-api.js"),
        "@/hooks/use-admin-page-context": path.join(temp, "page.js"),
        "@": path.join(root, "src"),
      },
    },
    oxc: { jsx: { runtime: "automatic" } },
    define: { "process.env.NODE_ENV": '"production"' },
    build: { outDir: bundle, lib: { entry, formats: ["es"], fileName: () => "fixture.js" } },
  });
  const assets = path.join(root, "dist/assets");
  const css = (await readdir(assets)).find((name) => /^index-.*\.css$/.test(name));
  const referenceMain = path.join(temp, "reference.cjs");
  await writeFile(
    referenceMain,
    `const {app,BrowserWindow}=require('electron');
    app.whenReady().then(()=>{const window=new BrowserWindow({width:1280,height:800,useContentSize:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});window.loadURL('about:blank');});`,
  );
  async function renderReference() {
    const browser = await electron.launch({
      args: [referenceMain, `--user-data-dir=${path.join(temp, "reference-profile")}`],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    });
    try {
      const page = await browser.firstWindow();
      await page.addInitScript((records) => {
        window.recordedEvents =
          records[location.pathname.slice(1) + "-" + location.search.slice(1)];
      }, recordings);
      report.renderers.reference = await page.evaluate(() => ({
        agent: navigator.userAgent,
        dpr: devicePixelRatio,
      }));
      page.on("pageerror", (error) => console.error(error));
      page.on("console", (message) => {
        if (message.type() === "error") console.error(message.text());
      });
      await page.route("http://workspace.test/**", async (route) => {
        const name = path.basename(new URL(route.request().url()).pathname);
        if (/^(canvas|settings)-(light|dark)-backdrop\.png$/.test(name))
          return route.fulfill({ path: path.join(temp, name), contentType: "image/png" });
        if (name.endsWith(".js"))
          return route.fulfill({ path: path.join(bundle, name), contentType: "text/javascript" });
        if (name.endsWith(".woff2") || name.endsWith(".css"))
          return route.fulfill({ path: path.join(assets, name) });
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html class="${name === "settings" ? "admin-theme" : ""}"><meta charset=utf-8><link rel=stylesheet href="/${css}"><style>main{background:url('/${name}-light-backdrop.png') center/100% 100%}html.dark main{background-image:url('/${name}-dark-backdrop.png')}</style><main style="display:flex;justify-content:flex-end;height:100vh"></main><script type=module src=/fixture.js></script>`,
        });
      });
      for (const scope of ["canvas", "settings"]) {
        await page.goto(`http://workspace.test/${scope}`);
        if (scope === "canvas") {
          await checkInsertPickers(page, "reference");
          await page.evaluate(() => {
            window.fixtureSkills = [
              { name: "shot-list", title: "镜头清单", description: "整理镜头" },
            ];
          });
          await checkEnabledSkill(page, "reference");
          await page.goto("http://workspace.test/canvas?selection");
          await captureNodeReference(page, "reference");
          await page.goto("http://workspace.test/canvas");
        }
        await checkAgentPicker(page, scope, "reference");
        await capture(
          page,
          page.locator(scope === "canvas" ? "[role=dialog]" : "aside > div"),
          scope,
          "reference",
        );
        for (const state of ["working", "streaming", "chat"]) {
          await page.goto(`http://workspace.test/${scope}?${state}`);
          await capture(
            page,
            page.locator(scope === "canvas" ? "[role=dialog]" : "aside > div"),
            scope,
            "reference",
            state,
          );
        }
        await page.goto(`http://workspace.test/${scope}?markdown`);
        await captureMarkdown(
          page,
          page.locator(scope === "canvas" ? "[role=dialog]" : "aside > div"),
          scope,
          "reference",
        );
        await page.goto(`http://workspace.test/${scope}?stopped`);
        await captureStopped(
          page,
          page.locator(scope === "canvas" ? "[role=dialog]" : "aside > div"),
          scope,
          "reference",
        );
        await page.goto(`http://workspace.test/${scope}?plan`);
        await capturePlan(
          page,
          page.locator(scope === "canvas" ? "[role=dialog]" : "aside > div"),
          scope,
          "reference",
        );
        await page.goto(`http://workspace.test/${scope}?question`);
        await captureQuickQuestion(
          page,
          page.locator(scope === "canvas" ? "[role=dialog]" : "aside > div"),
          scope,
          "reference",
        );
        await page.goto(`http://workspace.test/${scope}?answered`);
        await captureAnswered(
          page,
          page.locator(scope === "canvas" ? "[role=dialog]" : "aside > div"),
          scope,
          "reference",
        );
        for (const state of ["failed", "limit"]) {
          await page.goto(`http://workspace.test/${scope}?${state}`);
          await captureEndState(
            page,
            page.locator(scope === "canvas" ? "[role=dialog]" : "aside > div"),
            scope,
            "reference",
            state,
          );
        }
      }
    } finally {
      await browser.close();
    }
  }
  for (const scope of ["canvas", "settings"]) {
    const data = path.join(temp, scope);
    await mkdir(data);
    const app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        LINK_STUDIO_TEST_USER_DATA: data,
        LINK_STUDIO_TEST_PROJECT_PARENT: data,
        ELECTRON_RUN_AS_NODE: undefined,
      },
    });
    try {
      const page = await app.firstWindow();
      report.renderers[scope] = await page.evaluate(() => ({
        agent: navigator.userAgent,
        dpr: devicePixelRatio,
      }));
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
      );
      await page.evaluate(async (port) => {
        const api = window.desktop.settings;
        await api.agentLayout({ mode: "hidden" });
        const channel = await api.channelSave({
          expectedRevision: 0,
          approve: true,
          secret: "fixture",
          fields: {
            name: "测试",
            endpoint: `http://127.0.0.1:${port}`,
            allowLocal: true,
            enabled: true,
            sort: 1,
            headers: [],
          },
        });
        if (!channel.ok) throw Error(channel.code);
        const model = await api.modelSave({
          expectedRevision: 0,
          channelId: channel.value.id,
          channelRevision: channel.value.revision,
          enabled: true,
          upstreamModel: "fixture",
          settings: { api: "chat_completions" },
          config: {
            name: "工作区模型",
            kind: "agent",
            sort: 1,
            description: "",
            promptLimit: 24000,
            contextWindow: 32000,
            maxOutputTokens: 500,
            pricing: { unit: "token", input: 1, output: 1 },
          },
        });
        if (!model.ok) throw Error(model.code);
      }, server.address().port);
      if (scope === "canvas") {
        await page.getByRole("button", { name: "新建项目" }).click();
        await page.getByRole("button", { name: "打开小灵", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "模型设置" }).click();
        await page.getByRole("button", { name: "设置助手" }).click();
      }
      const panel = page.locator(
        scope === "canvas" ? ".assistant-frame" : ".settings-drawer-glass",
      );
      await expect(panel.locator(".assistant-starters")).toBeVisible();
      if (scope === "settings") {
        await panel.getByRole("button", { name: /^移除 渠道/ }).click();
        await expect(panel.getByRole("group", { name: "页面上下文" })).toHaveText("模型渠道");
      }
      for (const theme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.screenshot({
          path: path.join(temp, `${scope}-${theme}-backdrop.png`),
          animations: "disabled",
          style: ".assistant-frame,.settings-drawer-glass {visibility:hidden!important}",
        });
      }
      if (scope === "canvas") {
        await checkInsertPickers(page, "desktop");
        const source = path.join(data, "SKILL.md");
        await writeFile(
          source,
          "---\nname: shot-list\ntitle: 镜头清单\ndescription: 整理镜头\n---\n# 镜头顺序\n",
        );
        await app.evaluate(({ dialog }, file) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
        }, source);
        await page.evaluate(async () => {
          const api = window.desktop.skills;
          const picked = await api.pick({ kind: "markdown" });
          if (!picked.ok || !picked.value?.id) throw Error("技能导入预检失败");
          const saved = await api.confirm({
            id: picked.value.id,
            scopes: ["agent"],
            enabled: true,
          });
          if (!saved.ok) throw Error(saved.message);
        });
        await checkEnabledSkill(page, "desktop");
      }
      await checkAgentPicker(page, scope, "desktop");
      await capture(page, panel, scope, "desktop");
      await panel.locator(".assistant-starters button").first().click();
      await expect(panel.getByRole("textbox")).toBeFocused();
      await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
      await panel.getByRole("textbox").fill(question);
      let release;
      let finish;
      finishGate = new Promise((resolve) => {
        finish = resolve;
      });
      responseGate = new Promise((resolve) => {
        release = resolve;
      });
      try {
        await panel.getByRole("button", { name: "发送", exact: true }).click();
        await expect(panel.getByRole("status").filter({ hasText: "思考中…" })).toBeVisible();
        record(scope, "working");
        await capture(page, panel, scope, "desktop", "working");
        release();
        await expect(panel.getByRole("log").getByText(prefix, { exact: true })).toBeVisible();
        await panel.locator(".agent-reply").evaluate((element) => {
          window.streamingMessage = element;
        });
        record(
          scope,
          "streaming",
          await panel.getByRole("log").getByText(prefix, { exact: true }).innerText(),
        );
        await capture(page, panel, scope, "desktop", "streaming");
      } finally {
        release();
        finish();
        finishGate = undefined;
        responseGate = undefined;
      }
      await expect(panel.getByRole("log").getByText(answer, { exact: true })).toBeVisible();
      assert.ok(
        await panel
          .locator(".agent-reply")
          .evaluate((element) => window.streamingMessage === element),
        `${scope} streaming message replaced`,
      );
      await expect(panel.locator(".assistant-status[data-idle=true]")).toBeAttached();
      record(scope, "chat");
      await expect(panel.getByRole("button", { name: /^历史会话，当前/ })).toHaveAccessibleName(
        `历史会话，当前：${question}`,
      );
      await capture(page, panel, scope, "desktop", "chat");
      await expect(panel.getByRole("button", { name: "复制", exact: true })).toHaveCount(1);
      const feedback = panel.locator(".run-feedback");
      await feedback.getByRole("button", { name: "有帮助" }).click();
      await expect(feedback.getByText("感谢反馈")).toBeVisible();
      await feedback.getByRole("button", { name: "没帮上忙" }).click();
      await feedback.getByRole("button", { name: "没理解我的需求" }).click();
      await feedback.getByRole("textbox", { name: "补充说明" }).fill("请先确认当前页面");
      await feedback.getByRole("button", { name: "提交" }).click();
      await expect(feedback.getByText("已记录：没理解我的需求")).toBeVisible();
      await panel.getByRole("button", { name: "新对话", exact: true }).click();
      await panel.getByRole("button", { name: /^历史会话，当前/ }).click();
      await panel.locator(".assistant-history-row button").first().click();
      await expect(feedback.getByText("已记录：没理解我的需求")).toBeVisible();
      await feedback.getByRole("button", { name: "没帮上忙" }).click();
      await expect(feedback.getByRole("button", { name: "没帮上忙" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      await panel.getByRole("button", { name: "新对话", exact: true }).click();
      await panel.getByRole("textbox").fill(question);
      rich = true;
      try {
        await panel.getByRole("button", { name: "发送", exact: true }).click();
        await captureMarkdown(page, panel, scope, "desktop");
        record(scope, "markdown");
      } finally {
        rich = false;
      }
      await panel.getByRole("button", { name: "新对话", exact: true }).click();
      const editor = panel.getByRole("textbox");
      await editor.fill(question);
      responseGate = new Promise((resolve) => {
        release = resolve;
      });
      try {
        await editor.press("Enter");
        await expect(panel.getByRole("status").filter({ hasText: "思考中…" })).toBeVisible();
        await editor.fill(interjection);
        await editor.press("Enter");
        await expect(panel.getByRole("region", { name: "等待读取的插话" })).toHaveText(
          interjection,
        );
        await panel.getByRole("button", { name: /^停止/ }).click();
        await captureStopped(page, panel, scope, "desktop");
        record(scope, "stopped");
      } finally {
        release();
        responseGate = undefined;
      }
      await editor.fill("保留这份草稿");
      await panel.getByRole("button", { name: "作为新消息发送" }).click();
      await expect(panel.getByRole("log").getByText(answer, { exact: true })).toBeVisible();
      await expect(editor).toHaveText("保留这份草稿");
      await expect(panel.getByRole("button", { name: "作为新消息发送" })).toHaveCount(0);
      await panel.getByRole("button", { name: "新对话", exact: true }).click();
      await editor.fill("把这次配置检查列入计划");
      planning = true;
      finishGate = new Promise((resolve) => {
        finish = resolve;
      });
      try {
        await editor.press("Enter");
        await capturePlan(page, panel, scope, "desktop");
        record(scope, "plan");
        await panel.getByRole("button", { name: /^停止/ }).click();
        await expect(panel.getByText("未完成", { exact: true })).toBeVisible();
        await panel.getByRole("button", { name: "隐藏这个计划" }).click();
        await expect(panel.getByRole("region", { name: "本轮计划" })).toHaveCount(0);
      } finally {
        planning = false;
        finish();
        finishGate = undefined;
      }
      await panel.getByRole("button", { name: "新对话", exact: true }).click();
      asking = true;
      try {
        await editor.fill("请先确认范围");
        await editor.press("Enter");
        await captureQuickQuestion(page, panel, scope, "desktop");
        record(scope, "question");
        await panel.getByRole("option", { name: /当前渠道/ }).click();
        await expect(panel.getByRole("log").getByText(answer, { exact: true })).toBeVisible();
        await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeVisible();
        await captureAnswered(page, panel, scope, "desktop");
        record(scope, "answered");
      } finally {
        asking = false;
      }
      await panel.getByRole("button", { name: "新对话", exact: true }).click();
      failing = true;
      try {
        await editor.fill("检查运行失败后的记录");
        await editor.press("Enter");
        await captureEndState(page, panel, scope, "desktop", "failed");
        record(scope, "failed");
        const reason = await panel.locator(".agent-run-status-card p").innerText();
        const history = panel.getByRole("button", { name: /^历史会话，当前/ });
        await history.dblclick();
        const title = panel.getByRole("textbox", { name: "会话标题" });
        await title.fill("异常历史回放");
        await title.press("Enter");
        await panel.getByRole("button", { name: "新对话", exact: true }).click();
        await history.click();
        await panel.getByRole("button", { name: "异常历史回放", exact: true }).click();
        await expect(panel.locator(".agent-run-status-card p")).toHaveText(reason);
      } finally {
        failing = false;
      }
      await panel.getByRole("button", { name: "新对话", exact: true }).click();
      repeatSteps = 1;
      try {
        await editor.fill("核对步数用尽后继续");
        await editor.press("Enter");
        const resume = panel.getByRole("button", { name: "继续", exact: true });
        await expect(resume).toBeVisible({ timeout: 60000 });
        await captureEndState(page, panel, scope, "desktop", "limit");
        record(scope, "limit");
        repeatSteps = 0;
        await resume.click();
        await expect(panel.getByRole("log").getByText(answer, { exact: true })).toBeVisible();
        await expect(resume).toHaveCount(0);
      } finally {
        repeatSteps = 0;
      }
      if (scope === "canvas") {
        await page.locator(".react-flow__pane").dblclick({ position: { x: 70, y: 100 } });
        await page
          .getByRole("menu", { name: /^(画布菜单|添加节点)$/ })
          .getByRole("menuitem", { name: "图片生成", exact: true })
          .click();
        await captureNodeReference(page, "desktop");
      }
    } finally {
      await app.close();
    }
  }
  await renderReference();
  await writeFile(
    path.join(output, "replay.json"),
    JSON.stringify({ revision, recordings }, null, 2),
  );
  await writeFile(path.join(output, "geometry.json"), JSON.stringify(report, null, 2));
  const gallery = [];
  for (const [scope, host] of [
    ["canvas", "画布浮窗"],
    ["settings", "设置抽屉"],
  ]) {
    for (const [theme, tone] of [
      ["light", "浅色"],
      ["dark", "深色"],
    ]) {
      for (const [suffix, state] of [
        ["", "打开窗口"],
        ["-agent-model", "对话模型"],
        ["-agent-model-hover", "悬停在当前模型"],
        ...(scope === "canvas"
          ? [
              ["-image", "图片模型"],
              ["-video", "视频模型"],
              ["-skills-empty", "空技能库"],
              ["-skills-enabled", "已启用的技能"],
              ["-skill-draft", "技能插入草稿"],
              ["-node-ghost", "画布选中节点"],
              ["-node-committed", "聚焦后引入节点"],
            ]
          : []),
        ["-working", "思考中"],
        ["-streaming", "正文输出中"],
        ["-chat", "收到回复"],
        ["-markdown", "回复正文排版"],
        ["-stopped", "停止后的状态卡"],
        ["-plan", "运行中的计划步骤"],
        ["-question", "等待单选回答"],
        ["-answered", "提交后的回答记录"],
        ["-failed", "运行失败"],
        ["-limit", "步数用尽后继续"],
      ]) {
        const sample = `${scope}-${theme}${suffix}`;
        const pair = [
          ["reference", "小镜 · ff4070c7"],
          ["desktop", "小灵 · Electron"],
        ]
          .map(
            ([side, label]) =>
              `<figure><figcaption>${label}</figcaption><img loading="lazy" src="${sample}-${side}.png" alt="${host}，${tone}，${state}，${label}"></figure>`,
          )
          .join("");
        gallery.push(
          `<section id="${sample}"><h2>${host} · ${tone} · ${state}</h2><div>${pair}</div></section>`,
        );
      }
    }
  }
  await writeFile(
    path.join(output, "index.html"),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小镜 / 小灵 · 工作区对照</title><style>*{box-sizing:border-box}body{max-width:1020px;margin:auto;padding:24px;font:15px/1.5 system-ui;background:#eeeae3;color:#332f29}h1{font-size:24px}h2{font-size:17px}section{margin:36px 0}section>div{display:flex;gap:12px}figure{margin:0;min-width:0}figcaption{margin-bottom:6px}img{max-width:100%;height:auto;display:block}</style><h1>小镜 / 小灵 · 工作区对照</h1><p>左列是固定版本的原版组件，右列是桌面端实际窗口。两边使用相同的问题和回复。<a href="geometry.json">查看位置与尺寸（CSS 像素）</a></p>${gallery.join("")}</html>`,
  );
  const browserForSheet = await chromium.launch({ channel: "chrome" });
  try {
    const sheet = await browserForSheet.newPage({
      viewport: { width: 1060, height: 1000 },
      deviceScaleFactor: 1,
    });
    const pixels = {};
    for (const sample of Object.keys(report.samples)) {
      pixels[sample] = await compareScreenshot(sample);
    }
    await writeFile(
      path.join(output, "pixels.json"),
      JSON.stringify({ revision, samples: pixels }, null, 2),
    );
    for (const [sample, result] of Object.entries(pixels)) {
      if (/-(answered|node-ghost|node-committed|skill-draft)$/.test(sample))
        assert.equal(result.differing, 0, sample);
    }
    for (const scope of ["canvas", "settings"]) {
      const tiles = [];
      for (const suffix of ["", "-chat"])
        for (const [side, label] of [
          ["reference", "小镜 · ff4070c7"],
          ["desktop", "小灵 · 桌面端"],
        ]) {
          const image = await readFile(path.join(output, `${scope}-light${suffix}-${side}.png`));
          tiles.push(
            `<figure><figcaption>${label}　/　${suffix ? "收到回复" : "打开窗口"}</figcaption><img src="data:image/png;base64,${image.toString("base64")}"></figure>`,
          );
        }
      await sheet.setContent(
        `<meta charset=utf-8><style>*{box-sizing:border-box}body{margin:0;background:#e9e7e2;color:#32312f;font:15px system-ui}main{display:grid;grid-template-columns:repeat(2,max-content);gap:18px;padding:20px;width:max-content}figure{margin:0}img{display:block}figcaption{margin-bottom:8px}</style><main>${tiles.join("")}</main>`,
      );
      await sheet
        .locator("main")
        .screenshot({ path: path.join(output, `${scope}-comparison.png`) });
    }
    const overview = [];
    for (const [scope, label, suffix] of [
      ["canvas", "画布 · 打开窗口", ""],
      ["settings", "设置 · 收到回复", "-chat"],
    ])
      for (const [side, title] of [
        ["reference", "小镜"],
        ["desktop", "小灵"],
      ]) {
        const image = await readFile(path.join(output, `${scope}-light${suffix}-${side}.png`));
        overview.push(
          `<figure><figcaption>${label}　/　${title}</figcaption><img src="data:image/png;base64,${image.toString("base64")}"></figure>`,
        );
      }
    await sheet
      .locator("main")
      .evaluate((main, html) => (main.innerHTML = html), overview.join(""));
    await sheet.locator("main").screenshot({ path: path.join(output, "overview.png") });
    const journey = [];
    for (const [state, label] of [
      ["question", "等待回答"],
      ["answered", "回答记录"],
      ["limit", "步数用尽"],
    ]) {
      for (const [side, name] of [
        ["reference", "小镜"],
        ["desktop", "小灵"],
      ]) {
        const image = await readFile(path.join(output, `settings-light-${state}-${side}.png`));
        journey.push(
          `<figure><figcaption>${name} · ${label}</figcaption><img src="data:image/png;base64,${image.toString("base64")}"></figure>`,
        );
      }
    }
    await sheet.locator("main").evaluate((element, html) => {
      element.innerHTML = html;
    }, journey.join(""));
    await sheet.locator("main").screenshot({ path: path.join(output, "question-and-resume.png") });
    const references = [];
    for (const [sample, label] of [
      ["canvas-light-node-ghost", "画布选中节点"],
      ["canvas-light-node-committed", "聚焦输入框"],
      ["canvas-dark-skill-draft", "插入技能"],
    ]) {
      for (const [side, name] of [
        ["reference", "小镜"],
        ["desktop", "小灵"],
      ]) {
        const image = await readFile(path.join(output, `${sample}-${side}.png`));
        references.push(
          `<figure><figcaption>${name} · ${label}</figcaption><img src="data:image/png;base64,${image.toString("base64")}"></figure>`,
        );
      }
    }
    await sheet.locator("main").evaluate((element, html) => {
      element.innerHTML = html;
    }, references.join(""));
    await sheet.locator("main").screenshot({ path: path.join(output, "editor-comparison.png") });
    const menus = [];
    for (const [sample, label] of [
      ["canvas-dark-agent-model-hover", "画布 · 对话模型悬停"],
      ["settings-light-agent-model", "设置 · 对话模型"],
      ["canvas-light-video", "画布 · 视频"],
      ["canvas-light-skills-enabled", "画布 · Skills"],
    ]) {
      for (const [side, name] of [
        ["reference", "小镜"],
        ["desktop", "小灵"],
      ]) {
        const image = await readFile(path.join(output, `${sample}-${side}.png`));
        menus.push(
          `<figure><figcaption>${name} · ${label}</figcaption><img src="data:image/png;base64,${image.toString("base64")}"></figure>`,
        );
      }
    }
    await sheet.locator("main").evaluate((element, html) => {
      element.innerHTML = html;
    }, menus.join(""));
    await sheet.locator("main").screenshot({ path: path.join(output, "picker-comparison.png") });
  } finally {
    await browserForSheet.close();
  }
  for (const [state, sample] of Object.entries(report.samples))
    assert.deepEqual(sample.desktop, sample.reference, state);
  for (const name of ["插入模型", "插入技能"]) {
    const reference = report.pickers[`reference-${name}`];
    const desktop = report.pickers[`desktop-${name}`];
    assert.equal(desktop.text, reference.text, name);
    assert.deepEqual(desktop.anchor, reference.anchor, name);
    for (const edge of ["x", "y", "width", "height"])
      assert.ok(Math.abs(desktop.box[edge] - reference.box[edge]) <= 1 / 64, `${name} ${edge}`);
  }
  console.log(JSON.stringify(report));
} finally {
  server.closeAllConnections();
  server.close();
  await rm(temp, { recursive: true, force: true });
}
