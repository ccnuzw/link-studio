import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const root = process.cwd(),
  web = resolve(process.env.VIDEO_CANVAS_WEB ?? "../video-canvas/web");
const historyPins = process.argv.includes("--history-pins");
const history = historyPins || process.argv.includes("--history");
const detailLoading = process.argv.includes("--detail-loading");
const detailSettings = process.argv
  .find((value) => value.startsWith("--detail-settings="))
  ?.split("=")[1];
if (detailSettings && !["openai", "vertex-ai"].includes(detailSettings))
  throw Error("未知的插件设置对照");
const pluginDelete = process.argv
  .find((value) => value.startsWith("--plugin-delete="))
  ?.split("=")[1];
const pluginDeleteLabels = {
  ready: "确认",
  loading: "检查中",
  error: "检查失败",
  blocked: "内置阻断",
  refs: "模型与任务占用",
  pending: "删除中",
};
if (pluginDelete && !Object.hasOwn(pluginDeleteLabels, pluginDelete))
  throw Error("未知插件删除状态");
const deleteVersionState = process.argv
  .find((value) => value.startsWith("--delete-version="))
  ?.split("=")[1];
if (deleteVersionState && !["pending", "error"].includes(deleteVersionState))
  throw Error("未知版本删除状态");
const deleteVersion = !!deleteVersionState || process.argv.includes("--delete-version");
const disableConfirm = process.argv.includes("--disable-channel");
const kindConfirm = process.argv.includes("--confirm-kind");
const channelDiscard = process.argv.includes("--channel-discard");
const channelInvalid = process.argv.includes("--channel-invalid");
const channelSaving = process.argv.includes("--channel-saving");
const channelFiling = process.argv.includes("--channel-filing");
const channelApproval = process.argv
  .find((value) => value.startsWith("--channel-approval="))
  ?.split("=")[1];
if (channelApproval !== undefined && !["endpoint", "network"].includes(channelApproval))
  throw Error("授权状态须为 endpoint 或 network");
const channelFixtureUrl = channelFiling
  ? "https://ark.cn-beijing.volces.com"
  : "https://example.invalid";
const channelEdit =
  channelApproval ||
  channelSaving ||
  channelFiling ||
  channelInvalid ||
  channelDiscard ||
  process.argv.includes("--channel-edit");
const smallConfirm = channelDiscard || disableConfirm || kindConfirm || deleteVersion;
const channelOverview = process.argv.includes("--channel-overview");
const enrollExisting = process.argv.includes("--enroll-existing");
const detailPreview = process.argv.includes("--human-detail-preview");
const removeUsed = process.argv.includes("--human-remove-used");
const humanRemove = removeUsed || process.argv.includes("--human-remove");
const detailRefs = removeUsed
  ? ["first", "second", "second"].map((image_id, index) => ({
      image_id,
      canvas_id: "sample",
      canvas_title: "样片",
      node_id: index === 2 ? "other" : "lead",
      node_name: index === 2 ? "配角" : "主角",
    }))
  : [];
const filingPicker = [
  "empty",
  "loading",
  "error",
  "folders",
  "selected",
  "queue",
  "rejected",
  "more-error",
  "mixed",
  "search-error",
  "history",
  "history-filtered",
  "history-menu",
].find((state) => process.argv.includes(`--filing-picker-${state}`));
const pickerMenu = filingPicker === "history-menu";
const pickerHistory = filingPicker?.startsWith("history");
const pickerMore = filingPicker === "more-error";
const pickerSearchError = filingPicker === "search-error";
const pickerMixed = filingPicker === "mixed";
const moreFooter = '.filing-library-more,[data-slot="load-more"]';
const pickerUpload = ["queue", "rejected"].includes(filingPicker);
const pickerStateLabels = {
  empty: "空态",
  loading: "读取中",
  error: "读取失败",
  folders: "文件夹",
  selected: "选中图片",
  queue: "上传队列",
  rejected: "上传失败",
  "more-error": "续读失败页脚",
  mixed: "已备案与可选图片",
  "search-error": "搜索失败保留已选",
  history: "生成历史空态",
  "history-filtered": "生成历史无匹配",
  "history-menu": "生成历史时间菜单",
};
const pickerImage =
  (filingPicker === "selected" || pickerMore || pickerMixed || pickerSearchError) &&
  (await readFile(join(root, "resources/icons/icon-256.png")));
const pickerFolder = {
  id: "d23e9ba8-6bc4-4199-91d4-dfc0be307d80",
  name: "角色图",
  createdAt: "2025-08-21T12:00:00Z",
  itemCount: 0,
};
const humanDetail =
  filingPicker || humanRemove || detailPreview || process.argv.includes("--human-detail");
const detailHuman = {
  id: "fixture",
  name: "角色乙",
  status: "active",
  images: [
    { id: "first", status: "active" },
    { id: "second", status: "failed", error: "方舟审核未通过，请换一张清晰的正面照" },
  ],
};
if (pickerMixed)
  detailHuman.images[0].asset = {
    id: "124",
    kind: "image",
    fileName: "已备案.png",
    url: "/picker-image.png",
  };
const enroll = enrollExisting || process.argv.includes("--enroll");
const humans = enrollExisting
  ? [
      { id: "full", name: "角色甲", images: Array.from({ length: 5 }, () => ({})) },
      { id: "open", name: "角色乙", images: [{}] },
    ]
  : [];
const enrollName = "林舟_正面.png";
const enrollImage = enroll ? await readFile(join(root, "resources/icons/icon-32.png")) : undefined;
const uploadIssue = process.argv.includes("--upload-issue");
const uploadDuplicate = process.argv.includes("--upload-duplicate");
const uploadDown = process.argv.includes("--upload-down");
const uploadLimit = process.argv.includes("--upload-limit");
const uploadPending = process.argv.includes("--upload-pending");
const uploadPrompt = process.argv.includes("--upload-prompt");
const uploadInvalidVersion = process.argv.includes("--upload-invalid-version");
const uploadAdjusted = uploadInvalidVersion || process.argv.includes("--upload-adjusted");
const uploadSuccess = uploadAdjusted || process.argv.includes("--upload-success");
const upload =
  uploadDown ||
  uploadLimit ||
  uploadSuccess ||
  uploadDuplicate ||
  uploadIssue ||
  uploadPending ||
  uploadPrompt ||
  process.argv.includes("--upload");
const keysSaving = process.argv.includes("--keys-saving");
const keysPartial = process.argv.includes("--keys-partial");
const keysReplace = keysSaving || keysPartial || process.argv.includes("--keys-replace");
const keys = keysReplace || process.argv.includes("--keys");
const channel = channelEdit || process.argv.includes("--channel");
const pullState = process.argv.find((arg) => arg.startsWith("--pull="))?.slice(7) ?? "ready";
const pullLabels = {
  ready: "已存在",
  empty: "上游空清单",
  loading: "拉取中",
  error: "上游不支持",
  nomatch: "无匹配",
};
if (!Object.hasOwn(pullLabels, pullState)) throw Error("未知拉取状态");
const pull =
  process.argv.includes("--pull") || process.argv.some((arg) => arg.startsWith("--pull="));
const pullStatus = { empty: "上游没有返回模型", loading: "正在拉取模型…", error: "拉取失败" }[
  pullState
];
const catalogEmpty = process.argv.includes("--catalog-empty");
const catalogMenu = process.argv.includes("--catalog-menu");
const catalogSelect = process.argv
  .find((arg) => arg.startsWith("--catalog-select="))
  ?.split("=")[1];
const catalogSelectLabels = { source: "按来源筛选", status: "按状态筛选", size: "每页条数" };
if (catalogSelect && !Object.hasOwn(catalogSelectLabels, catalogSelect))
  throw new Error("未知目录下拉");
const catalogState = process.argv.includes("--catalog-error")
  ? "error"
  : process.argv.includes("--catalog-loading")
    ? "loading"
    : "ready";
const catalogPanel =
  catalogState !== "ready" ||
  catalogEmpty ||
  catalogMenu ||
  !!catalogSelect ||
  process.argv.includes("--catalog");
const catalogQuery = catalogState !== "ready" ? "" : catalogEmpty ? "no-match-fixture" : "openai";
const migrate = process.argv.includes("--migrate");
const deleteChannel = migrate || process.argv.includes("--delete-channel");
const upgradeNotice = process.argv.includes("--upgrade-notice");
const toggleState = process.argv.find((arg) => arg.startsWith("--plugin-disable="))?.split("=")[1];
if (toggleState && !["confirm", "pending", "error"].includes(toggleState))
  throw Error("未知插件停用状态");
const upgradeFailed = upgradeNotice || process.argv.includes("--upgrade-failed");
const upgradeMultiple = process.argv.includes("--upgrade-multiple");
const upgradePending = process.argv.includes("--upgrade-pending");
const upgradeDisabled = process.argv.includes("--upgrade-disabled");
const upgrade =
  Boolean(toggleState) ||
  upgradeFailed ||
  upgradeMultiple ||
  upgradePending ||
  upgradeDisabled ||
  process.argv.includes("--upgrade");
const upgradeModels = ["alpha-chat", "beta-chat"];
const pulled = ["audit-model", "gpt-fixture", "whisper-fixture"].map((id) => ({
  id,
  exists: id === "audit-model",
}));
const batchAgent = process.argv.includes("--batch-agent");
const batchSelectedProtocol = process.argv.includes("--batch-openai");
const batchProtocolEmpty = process.argv.includes("--batch-protocol-empty");
const batchProtocol =
  batchAgent ||
  batchSelectedProtocol ||
  batchProtocolEmpty ||
  process.argv.includes("--batch-protocol");
const batchChannel = process.argv.find((arg) => arg.startsWith("--batch-channel="))?.split("=")[1];
if (batchChannel && !["open", "selected", "long"].includes(batchChannel))
  throw Error("未知批改渠道状态");
let batchChannels = [];
const modelList = process.argv.includes("--model-list");
let modelListItems;
const firstResultPage = process.argv.includes("--batch-result-first");
const longResult = firstResultPage || process.argv.includes("--batch-result-long");
const resultKind = process.argv.find((arg) => arg.startsWith("--batch-result="))?.split("=")[1];
const mixedAction = process.argv.includes("--mixed-result");
const allFailed = process.argv.includes("--all-failed");
const progressKind =
  process.argv
    .find((arg) => arg.startsWith("--batch-progress="))
    ?.slice("--batch-progress=".length) ??
  (process.argv.includes("--batch-progress") ? "enable" : undefined);
const batchProgress = progressKind !== undefined;
const progressDone = Number(
  process.argv.find((arg) => arg.startsWith("--progress-done="))?.split("=")[1] ?? 1,
);
if (
  allFailed &&
  (mixedAction || longResult || (!resultKind && !process.argv.includes("--batch-result")))
)
  throw Error("--all-failed 需要指定一个批量操作且不能混用结果");
if (mixedAction && !resultKind) throw Error("--mixed-result 需要指定批量操作");
const resultLabels = {
  enable: "批量上线",
  disable: "批量下线",
  edit: "批量修改",
  protocol: "批量设置能力与协议",
};
const progressLabels = { ...resultLabels, delete: "批量删除" };
if (
  batchProgress &&
  (!Object.hasOwn(progressLabels, progressKind) ||
    ![0, 1].includes(progressDone) ||
    resultKind ||
    allFailed ||
    mixedAction)
)
  throw Error("批量进度需要独立指定操作和 0 或 1 个回执");
const progressText = `${progressLabels[progressKind]}中… ${progressDone} / 2`;
if (resultKind && !Object.hasOwn(resultLabels, resultKind)) throw Error("未知批量结果类型");
const deleteResult = longResult || process.argv.includes("--batch-result");
const batchResult = deleteResult || !!resultKind;
const batchToolbar = process.argv.includes("--batch-toolbar");
const onlineNames = longResult
  ? Array.from({ length: 15 }, (_, index) => `online-model-${String(index + 1).padStart(2, "0")}`)
  : ["online-model"];
const skipReason = {
  enable: "已经在线",
  disable: "已经下线",
  edit: "已保存，但有 3 个问题，上线前要处理",
  protocol: "已保存，但有 1 个问题，上线前要处理",
};
const mixedResult = {
  action: resultKind ?? "delete",
  done: allFailed ? [] : ["audit-model"],
  skipped:
    !allFailed && deleteResult
      ? onlineNames.map((key) => ({ key, reason: "还在上线，先下线再删除" }))
      : mixedAction
        ? [{ key: "skip-model", reason: skipReason[resultKind] }]
        : [],
  failed: allFailed
    ? ["audit-model", "changed-model"].map((key) => ({
        key,
        reason: "配置已更新，请重新载入后再保存。",
      }))
    : deleteResult || mixedAction
      ? [{ key: "changed-model", reason: "配置已更新，请重新载入后再保存。" }]
      : [],
};
const batch =
  process.argv.includes("--batch") ||
  process.argv.includes("--batch-timeout") ||
  batchChannel ||
  batchProtocol ||
  batchResult ||
  batchToolbar ||
  batchProgress;
const batchAction = resultKind
  ? resultLabels[resultKind]
  : deleteResult
    ? "批量删除"
    : batchProtocol
      ? "批量设置能力与协议"
      : "批量修改";
const batchTimeout = process.argv.includes("--batch-timeout");
const modelTab = process.argv.find((arg) => arg.startsWith("--model="))?.slice(8);
const dirtyTrial = process.argv.includes("--dirty-trial");
if (dirtyTrial && modelTab !== "basic") throw Error("脏草稿试跑核对需要 --model=basic");
const jsonNonObject = process.argv.includes("--json-non-object");
const contextAgent = process.argv.includes("--context-agent");
const contextHint = contextAgent || process.argv.includes("--context-hint");
const contextName = contextAgent ? "gemini-2.5-pro" : "gpt-4o";
if (contextHint && modelTab !== "params") throw Error("上下文提示需要 --model=params");
const jsonExtension = process.argv.includes("--json-extension");
const jsonInvalidReturn = process.argv.includes("--json-invalid-return") || jsonNonObject;
const logoMenu = process.argv.find((arg) => arg.startsWith("--logo-menu="))?.slice(12);
if (logoMenu && (modelTab !== "basic" || !["all", "empty", "selected"].includes(logoMenu)))
  throw Error("厂商菜单：--model=basic --logo-menu=all/empty/selected");
if (jsonInvalidReturn && modelTab !== "json") throw Error("返回表单错误态需要 --model=json");
if (jsonExtension && (modelTab !== "json" || jsonInvalidReturn))
  throw Error("扩展草稿需要单独指定 --model=json --json-extension");
const priceState = ["token-cost", "tiers", "stale", "second"].find((name) =>
  process.argv.includes(`--price-${name}`),
);
if (priceState && modelTab !== "price") throw Error("定价对照必须指定 --model=price");
const priceFixture = ["tiers", "stale"].includes(priceState)
  ? {
      kind: "image",
      label: "分档样例",
      capabilities: {
        ops: ["t2i"],
        params: {
          detail: {
            type: "enum",
            label: "精度",
            open: true,
            spec: true,
            options: ["标准", "高"],
            default: "标准",
          },
          clean: { type: "boolean", label: "降噪", open: false, spec: true, default: false },
        },
      },
      pricing: {
        billing: "per_call",
        unit: 2,
        tiers: [
          { on: true, when: { clean: true }, unit: 4 },
          { on: true, when: { clean: true, detail: "高" }, unit: 9 },
        ],
      },
    }
  : priceState === "second"
    ? {
        kind: "video",
        label: "按秒样例",
        capabilities: {
          ops: ["t2v"],
          params: {
            detail: {
              type: "enum",
              label: "精度",
              open: true,
              spec: true,
              options: ["标准", "高"],
              default: "高",
            },
            aspect_ratio: {
              type: "enum",
              label: "比例",
              open: false,
              spec: false,
              options: ["16:9", "1:1"],
              default: "16:9",
            },
            duration: { type: "number", open: true, min: 2, max: 10, step: 2, default: 6 },
          },
        },
        pricing: {
          billing: "per_second",
          per_second: 2,
          tiers: [{ on: true, when: { detail: "高", aspect_ratio: "16:9" }, unit: 7 }],
        },
      }
    : null;
if (priceState === "stale") priceFixture.pricing.tiers[0].when.legacy = "退役档";
const expandedTimeline = process.argv.includes("--trial-timeline-expanded");
const timelineState = process.argv
  .find((arg) => arg.startsWith("--trial-trace-state="))
  ?.split("=")[1];
if (timelineState && !["empty", "error"].includes(timelineState)) throw Error("无效追踪状态");
const trialTimeline =
  Boolean(timelineState) || expandedTimeline || process.argv.includes("--trial-timeline");
const trialSuccess = trialTimeline || process.argv.includes("--trial-success");
const trialFailed = process.argv.includes("--trial-failed");
const trialRun = trialSuccess || trialFailed;
if (trialSuccess && trialFailed) throw Error("成功与失败试跑应分别复验");
const failureReason = "当前模型不支持此请求类型";
const compact = process.argv.includes("--compact");
const trialRefMenu = process.argv.includes("--trial-ref-menu");
const voiceMenu = process.argv.includes("--trial-voices");
const trialMenu = trialRefMenu || voiceMenu;
const dryView = process.argv.find((arg) => arg.startsWith("--trial-dry="))?.split("=")[1];
if (dryView && !["short", "long", "folded"].includes(dryView))
  throw Error("请求描述状态须为 short/long/folded");
const dryPrompt = dryView === "short" ? "预览这次请求。" : "只预览，不调用供应商。".repeat(155);
const dryTime = new Date("2026-11-22T18:24:00Z");
const dryBody = { model: "audit-model", input: dryPrompt, stream: false, store: false };
const dryDescriptor = {
  json: dryBody,
  method: "POST",
  responseType: "json",
  url: `${channelFixtureUrl}/v1/responses`,
};
const trialTab = dryView
  ? "request"
  : trialRun || trialMenu
    ? "result"
    : process.argv.find((arg) => arg.startsWith("--trial="))?.slice(8);
const trialPrompt = "用一句话概括这次试跑。";
const trialText = "模型已收到提示词，文本结果可在这里查看。";
let trialTask;
let trialSteps;
let dryGeometry;
const trialTabs = { result: "结果", request: "请求描述", trace: "追踪", logs: "日志" };
if (trialTab && !Object.hasOwn(trialTabs, trialTab)) throw new Error("无效试跑页签");
const modelTabs = {
  basic: "基本信息",
  agent: "基本信息",
  params: "能力与参数",
  price: "积分定价",
  json: "配置 JSON",
};
if (modelTab && !Object.hasOwn(modelTabs, modelTab)) throw new Error("无效页签");
const captureName =
  (detailLoading && "detail-loading") ||
  (channelApproval && `channel-approval-${channelApproval}`) ||
  (channelSaving && "channel-saving") ||
  (channelFiling && "channel-filing") ||
  (channelInvalid && "channel-invalid") ||
  (channelDiscard && "channel-discard") ||
  (channelEdit && "channel-edit") ||
  (filingPicker && `filing-picker-${filingPicker}`) ||
  (kindConfirm && "confirm-kind") ||
  (channelOverview && "channel-overview") ||
  (disableConfirm && "disable-channel") ||
  (modelList && "model-list") ||
  (pluginDelete && `plugin-delete-${pluginDelete}`) ||
  (deleteVersion && `delete-version${deleteVersionState ? `-${deleteVersionState}` : ""}`) ||
  (enroll && (enrollExisting ? "enroll-existing" : "enroll")) ||
  (humanDetail &&
    (removeUsed
      ? "human-remove-used"
      : humanRemove
        ? "human-remove"
        : detailPreview
          ? "human-detail-preview"
          : "human-detail")) ||
  (uploadSuccess &&
    (uploadInvalidVersion
      ? "upload-invalid-version"
      : uploadAdjusted
        ? "upload-adjusted"
        : "upload-success")) ||
  (uploadIssue && "upload-issue") ||
  (uploadDuplicate && "upload-duplicate") ||
  (uploadDown && "upload-down") ||
  (uploadLimit && "upload-limit") ||
  (uploadPending && "upload-pending") ||
  (uploadPrompt && "upload-prompt") ||
  (deleteChannel && (migrate ? "migrate" : "delete-channel")) ||
  (catalogPanel && "catalog") ||
  (toggleState && `plugin-disable-${toggleState}`) ||
  (upgradeNotice && "upgrade-notice") ||
  (upgradeFailed && "upgrade-failed") ||
  (upgradePending && "upgrade-pending") ||
  (upgradeDisabled && "upgrade-disabled") ||
  (upgradeMultiple && "upgrade-multiple") ||
  (upgrade && "upgrade") ||
  (pull && `pull-${pullState}`) ||
  (batchChannel && `batch-channel-${batchChannel}`) ||
  (batchProgress && "batch-progress") ||
  (batch &&
    (resultKind
      ? `batch-result-${resultKind}`
      : firstResultPage
        ? "batch-result-first"
        : longResult
          ? "batch-result-long"
          : batchResult
            ? "batch-result"
            : batchToolbar
              ? "batch-toolbar"
              : batchSelectedProtocol
                ? "batch-openai"
                : batchProtocolEmpty
                  ? "batch-protocol-empty"
                  : batchProtocol
                    ? "batch-protocol"
                    : batchTimeout
                      ? "batch-timeout"
                      : "batch")) ||
  (dryView && `trial-dry-${dryView}`) ||
  (timelineState && `trial-trace-${timelineState}`) ||
  (expandedTimeline && "trial-timeline-expanded") ||
  (trialTimeline && "trial-timeline") ||
  (trialFailed && "trial-failed") ||
  (trialSuccess && "trial-success") ||
  trialTab ||
  (contextHint && (contextAgent ? "context-agent" : "context-hint")) ||
  (jsonExtension && "json-extension") ||
  (jsonNonObject && "json-non-object") ||
  (jsonInvalidReturn && "json-invalid-return") ||
  (logoMenu && `logo-${logoMenu}`) ||
  priceState ||
  modelTab ||
  (channel
    ? "channel"
    : keysSaving
      ? "keys-saving"
      : keysPartial
        ? "keys-partial"
        : keys
          ? "keys"
          : upload
            ? "upload"
            : history
              ? "history"
              : "overview");
const pluginDetails = ["overview", "history", "detail-loading"].includes(captureName);
if (
  compact &&
  !pull &&
  !deleteChannel &&
  !deleteVersion &&
  !pluginDelete &&
  !upgrade &&
  !pluginDetails &&
  !channel &&
  !filingPicker &&
  !trialTab &&
  !catalogPanel &&
  !modelList &&
  !modelTab &&
  !keys &&
  !batchResult &&
  !batchProgress &&
  !batchSelectedProtocol &&
  !batchProtocolEmpty &&
  !upload
)
  throw new Error(`此状态尚无窄窗口对照：${captureName}`);
let channelId;
const historyNames = Array.from({ length: 10 }, (_, index) => `分镜模型 ${index + 1}`);
let panelBox;
let contextGeometry;
const require = createRequire(join(root, "package.json"));
const { chromium, _electron } = require("@playwright/test");
const { createServer } = await import(join(web, "node_modules/vite/dist/node/index.js"));
const source =
  (await readFile(
    join(web, `../backend/plugins/${detailSettings ?? (voiceMenu ? "doubao-video" : "openai")}.js`),
    "utf8",
  )) + (upgrade ? "\nmodule.exports.meta.key='fixture-upgrade';" : "");
const scope = { module: { exports: {} } };
runInNewContext(source, scope);
const meta = scope.module.exports.meta,
  stamp = "2026-11-01T00:00:00Z";
const fixture = {
  key: meta.key,
  name: meta.name,
  source: upgrade ? "uploaded" : "builtin",
  enabled: true,
  updated_at: stamp,
  versions: [
    {
      id: 1,
      plugin_key: meta.key,
      version: meta.version,
      meta,
      created_at: stamp,
      created_by: upgrade ? 1 : 0,
      model_count: 0,
      sha256: createHash("sha256").update(source).digest("hex"),
    },
  ],
};
const entry = () =>
  `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router';import {PluginDialog} from '/src/pages/admin/ai/plugins/plugin-dialog.tsx';import {UploadDialog} from '/src/pages/admin/ai/plugins/upload-dialog.tsx';import '/src/index.css';const p=${JSON.stringify(fixture)};createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,null,React.createElement(${upload ? "UploadDialog" : "PluginDialog"},{open:true,pluginKey:p.key,summary:p,detail:${detailLoading ? "null" : "p"},tab:'${history ? "versions" : "overview"}',canWrite:true,onUploaded:()=>{},onNextStep:()=>{},onChanged:()=>{},onClose:()=>{}})));`;
const work = await mkdtemp(join(tmpdir(), "parity-ui-"));
const catalogItems =
  catalogPanel && !catalogEmpty && catalogState === "ready"
    ? await Promise.all(
        ["openai", "openai-chat-image", "openai-image"].map(async (key) => {
          const context = { module: { exports: {} } };
          runInNewContext(
            await readFile(join(web, `../backend/plugins/${key}.js`), "utf8"),
            context,
          );
          const meta = context.module.exports.meta;
          return {
            ...fixture,
            key,
            name: meta.name,
            latest_version: meta.version,
            model_count: 0,
            outdated_model_count: 0,
            versions: [{ ...fixture.versions[0], plugin_key: key, version: meta.version, meta }],
          };
        }),
      )
    : [];
let server, browser, app;
const providerCalls = [];
comparison: try {
  process.chdir(web);
  server = await createServer({
    root: web,
    cacheDir: join(work, "vite"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "audit",
        configureServer(dev) {
          if (dirtyTrial)
            dev.middlewares.use("/v1", (request, response) => {
              providerCalls.push(`${request.method} ${request.url}`);
              response.writeHead(503).end();
            });
          if (trialRun)
            dev.middlewares.use("/v1/responses", (_req, res) => {
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify(
                  trialFailed
                    ? { error: { message: failureReason } }
                    : {
                        output: [
                          { type: "message", content: [{ type: "output_text", text: trialText }] },
                        ],
                      },
                ),
              );
            });
          if (pull)
            dev.middlewares.use("/v1/models", (_req, res) => {
              if (pullState === "loading") return;
              if (pullState === "error") {
                res.writeHead(404).end();
                return;
              }
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify({
                  data: pullState === "empty" ? [] : pulled.map(({ id }) => ({ id })),
                }),
              );
            });
        },
        resolveId(id) {
          if (id === "/src/__audit.js") return join(web, "src/__audit.js");
        },
        load(id) {
          if (channelOverview && id.endsWith("/__audit.js"))
            return `import React from 'react';import {createRoot} from 'react-dom/client';import {ChannelHeader} from '/src/pages/admin/ai/channels/channel-header.tsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement('main',{style:{position:'absolute',left:${panelBox.x},top:${panelBox.y},width:${panelBox.width}}},React.createElement(ChannelHeader,{channel:{name:'测试渠道',enabled:true,base_url:'https://example.invalid',headers:{},secret_set:false,secret_key_set:false},canWrite:true})));`;
          if ((kindConfirm || disableConfirm) && id.endsWith("/__audit.js")) {
            const props = kindConfirm
              ? {
                  title: "改成Agent模型？",
                  description: "能力、参数和定价将重置为默认值，不兼容的协议会被清空。",
                  confirmLabel: "确认修改",
                }
              : {
                  title: "停用渠道？",
                  description: "「测试渠道」的模型将在画布中不可见，进行中的任务不受影响。",
                  confirmLabel: "停用",
                  destructive: true,
                };
            return `import React from 'react';import {createRoot} from 'react-dom/client';import {ConfirmDialog} from '/src/components/admin-ui/confirm-dialog.tsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(ConfirmDialog,{...${JSON.stringify(props)},open:true,onConfirm:()=>{},onCancel:()=>{}}));`;
          }
          if (modelList && id.endsWith("/__audit.js"))
            return `import React from 'react';import {createRoot} from 'react-dom/client';import {ModelTable} from '/src/pages/admin/ai/models/model-table.tsx';import {BatchBar} from '/src/pages/admin/ai/models/batch-bar.tsx';import '/src/index.css';const items=${JSON.stringify(modelListItems)},selected=[items[0].key];const list={items,total:items.length,state:'ready',filters:{},q:'',page:1,pageSize:20,filtering:false,setQ:()=>{}};createRoot(document.getElementById('root')).render(React.createElement('main',{id:'audit-model-panel',style:{position:'absolute',left:${panelBox.x},top:${panelBox.y},display:'flex',flexDirection:'column',width:${panelBox.width},height:${panelBox.height}}},React.createElement(ModelTable,{list,selected,onDelete:()=>{},onReorder:()=>{},onSelectedChange:()=>{}}),React.createElement(BatchBar,{selected,catalog:{channels:[],plugins:[],pluginsStatus:'ready'},batch:{running:null,result:null},onClear:()=>{}})));`;
          if (deleteVersion && id.endsWith("/__audit.js"))
            return `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router';import {DialogHost} from '/src/components/dialog-host.tsx';import {PluginDialog} from '/src/pages/admin/ai/plugins/plugin-dialog.tsx';import '/src/index.css';const plugin=${JSON.stringify(fixture)};createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,null,React.createElement(DialogHost),React.createElement(PluginDialog,{open:true,pluginKey:plugin.key,summary:plugin,detail:plugin,tab:'versions',canWrite:true,onChanged:()=>{},onClose:()=>{}})));`;
          if (humanDetail && id.endsWith("/__audit.js"))
            return `import React from 'react';import {createRoot} from 'react-dom/client';import {HumanDetailDialog} from '/src/components/virtual-human/human-detail-dialog.tsx';import '/src/index.css';const human=${JSON.stringify(detailHuman)};createRoot(document.getElementById('root')).render(React.createElement(HumanDetailDialog,{human,humans:[human],filingReady:true,onClose:()=>{},onChange:()=>{},onRemoved:()=>{}}));`;
          if (enroll && id.endsWith("/__audit.js"))
            return `import React from 'react';import {createRoot} from 'react-dom/client';import {EnrollDialog} from '/src/components/virtual-human/enroll-dialog.tsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(EnrollDialog,{asset:{id:'1',kind:'image',fileName:${JSON.stringify(enrollName)},url:'/enroll-image.png'},humans:${JSON.stringify(humans)},onClose:()=>{},onDone:()=>{}}));`;
          if (pluginDelete && id.endsWith("/__audit.js"))
            return `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router';import {DialogHost} from '/src/components/dialog-host.tsx';import {openDeleteDialog} from '/src/pages/admin/ai/delete-dialog.tsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,null,React.createElement(DialogHost),React.createElement('button',{onClick:()=>openDeleteDialog({target:'plugin',objectKey:${JSON.stringify(fixture.key)},name:'OpenAI',onDeleted:()=>{}})},'删除插件')));`;
          if (deleteChannel && id.endsWith("/__audit.js"))
            return `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router';import {DialogHost} from '/src/components/dialog-host.tsx';import {openDeleteDialog} from '/src/pages/admin/ai/delete-dialog.tsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,null,React.createElement(DialogHost),React.createElement('button',{onClick:()=>openDeleteDialog({target:'channel',objectKey:'audit',name:'测试渠道',channels:[{key:'next',name:'目标渠道',health:{label:'未设 Key'}}],onDeleted:()=>{}})},'删除渠道')));`;
          if (catalogPanel && id.endsWith("/__audit.js"))
            return `import React from 'react';import {createRoot} from 'react-dom/client';import {PluginTable} from '/src/pages/admin/ai/plugins/plugin-table.tsx';import '/src/index.css';const list={items:${JSON.stringify(catalogItems)},total:${catalogItems.length},state:'${catalogState}',filters:{},q:${JSON.stringify(catalogQuery)},page:1,pageSize:20,filtering:${!!catalogQuery}};createRoot(document.getElementById('root')).render(React.createElement('main',{style:{width:${panelBox.width},height:${panelBox.height},display:'flex',flexDirection:'column'}},React.createElement(PluginTable,{list,canWrite:true,toggling:null})));`;
          if (toggleState && id.endsWith("/__audit.js"))
            return `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router';import {DialogHost} from '/src/components/dialog-host.tsx';import {Toaster} from '/src/components/ui/sonner.tsx';import {usePluginActions} from '/src/pages/admin/ai/plugins/use-plugin-actions.tsx';import '/src/index.css';function Page(){const {toggle}=usePluginActions({onChanged:()=>{}});return React.createElement('button',{onClick:()=>toggle({key:'fixture-upgrade',name:'OpenAI',enabled:true,model_count:2,online_model_count:1},false)},'停用插件')}createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,null,React.createElement(DialogHost),React.createElement(Toaster),React.createElement(Page)));`;
          if (upgrade && id.endsWith("/__audit.js"))
            return `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router';import {DialogHost} from '/src/components/dialog-host.tsx';import {Toaster} from '/src/components/ui/sonner.tsx';import {confirmUpgradeModels} from '/src/pages/admin/ai/plugins/upgrade-models.tsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,null,React.createElement(DialogHost),React.createElement(Toaster),React.createElement('button',{onClick:()=>confirmUpgradeModels({plugin:${JSON.stringify(fixture)},onDone:()=>{}})},'升级模型')));`;
          if (pull && id.endsWith("/__audit.js"))
            return `import React from 'react';import {createRoot} from 'react-dom/client';import {PullModelsDialog} from '/src/pages/admin/ai/channels/pull-models-dialog.tsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(PullModelsDialog,{channel:{key:'audit',name:'测试渠道'},canWriteChannel:true,onImported:()=>{},open:true,onClose:()=>{},onExited:()=>{}}));`;
          if (batchProgress && id.endsWith("/__audit.js"))
            return `import React from 'react';import {createRoot} from 'react-dom/client';import {BatchBar} from '/src/pages/admin/ai/models/batch-bar.tsx';import '/src/index.css';function Audit(){const [selected,setSelected]=React.useState(['audit-model','changed-model']);return React.createElement('main',{style:{width:${panelBox.width}}},React.createElement(BatchBar,{selected,catalog:{channels:[],plugins:[],pluginsStatus:'ready'},batch:{running:${JSON.stringify(progressKind)},progress:{done:${progressDone},total:2},result:null},onClear:()=>setSelected([])}))}createRoot(document.getElementById('root')).render(React.createElement(Audit));`;
          if (batch && id.endsWith("/__audit.js"))
            return `import React from 'react';import {createRoot} from 'react-dom/client';import {BatchBar} from '/src/pages/admin/ai/models/batch-bar.tsx';import '/src/index.css';function Audit(){const [result,setResult]=React.useState(${JSON.stringify(batchResult ? mixedResult : null)});return React.createElement(BatchBar,{selected:${batchResult ? "[]" : "['audit-model']"},catalog:{channels:${JSON.stringify(batchChannels)},plugins:[${JSON.stringify(fixture)}],pluginsStatus:'ready'},batch:{running:null,result,clearResult:()=>setResult(null)},onClear:()=>{}})}createRoot(document.getElementById('root')).render(React.createElement(Audit));`;
          if ((trialTab || dirtyTrial) && id.endsWith("/__audit.js"))
            return `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router';import {ModelEditorDialogs} from '/src/pages/admin/ai/models/model-editor-dialogs.tsx';import {useModelWorkspace} from '/src/pages/admin/ai/models/use-model-workspace.ts';import '/src/index.css';const key=${JSON.stringify(channelId)},catalog={channels:[{key,name:'测试渠道',enabled:true,secret_set:true}],plugins:[${JSON.stringify(fixture)}],pluginsStatus:'ready'},route={key:'audit-model',isNew:false,presetChannel:key,close:()=>{},openModel:()=>{window.auditTrialOpened=true}};function Audit(){const ws=useModelWorkspace(catalog,route);return React.createElement(ModelEditorDialogs,{ws,catalog,testOnly:${!dirtyTrial}})}createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,null,React.createElement(Audit)));`;
          if (modelTab && id.endsWith("/__audit.js"))
            return `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router';import {ModelEditorDialogs} from '/src/pages/admin/ai/models/model-editor-dialogs.tsx';import {useModelWorkspace} from '/src/pages/admin/ai/models/use-model-workspace.ts';import '/src/index.css';const key=${JSON.stringify(channelId)},seed=${JSON.stringify(priceFixture)},catalog={channels:[{key,name:'测试渠道',base_url:'https://example.invalid',enabled:true,secret_set:false}],plugins:[${JSON.stringify(fixture)}],pluginsStatus:'ready'},route={key:null,isNew:true,presetChannel:key,close:()=>{},openNew:()=>{},openModel:()=>{}};function Audit(){const ws=useModelWorkspace(catalog,route);const opened=React.useRef(false);React.useEffect(()=>{if(seed&&ws.body&&!ws.body.label) ws.editBody(body=>({...body,...seed}));if(${modelTab === "json"}&&ws.body&&!opened.current){opened.current=true;ws.switchMode('json')}},[ws.body,ws.mode]);return React.createElement(ModelEditorDialogs,{ws,catalog})}createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,null,React.createElement(Audit)));`;
          if (channelEdit && id.endsWith("/__audit.js"))
            return `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router';import {DialogHost} from '/src/components/dialog-host.tsx';import {ChannelDialog} from '/src/pages/admin/ai/channels/channel-dialog.tsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,null,React.createElement(DialogHost),React.createElement(ChannelDialog,{open:true,channel:{key:'sample',name:'测试渠道',base_url:${JSON.stringify(channelFixtureUrl)},headers:{},enabled:true},onClose:()=>{},onExited:()=>{},onSaved:()=>{}})));`;
          if (channel && id.endsWith("/__audit.js"))
            return `import React from 'react';import {createRoot} from 'react-dom/client';import {ChannelDialog} from '/src/pages/admin/ai/channels/channel-dialog.tsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(ChannelDialog,{open:true,onClose:()=>{},onExited:()=>{},onSaved:()=>{}}));`;
          if (id.endsWith("/__audit.js"))
            return keys
              ? `import React from 'react';import {createRoot} from 'react-dom/client';import {SecretDialog} from '/src/pages/admin/ai/channels/secret-dialog.tsx';import '/src/index.css';function Audit(){const [open,setOpen]=React.useState(true);return React.createElement(SecretDialog,{open,channelName:'测试渠道',channelKey:${JSON.stringify(channelId)},secretSet:${keysReplace},secretKeySet:${keysReplace},onClose:()=>setOpen(false),onExited:()=>{},onSaved:()=>{}})}createRoot(document.getElementById('root')).render(React.createElement(Audit));`
              : entry();
        },
      },
    ],
  });
  await server.listen();
  process.chdir(root);
  browser = await chromium.launch({
    channel: "chrome",
    ...((pickerMenu ||
      batchProgress ||
      batchResult ||
      upload ||
      pluginDetails ||
      upgrade ||
      pluginDelete ||
      deleteVersion ||
      deleteChannel) && { headless: false }),
    ...((channelFiling ||
      pickerMore ||
      batchResult ||
      upload ||
      pluginDetails ||
      upgrade ||
      pluginDelete ||
      deleteVersion ||
      deleteChannel) && { ignoreDefaultArgs: ["--hide-scrollbars"] }),
  });
  const env = { ...process.env, LINK_STUDIO_TEST_USER_DATA: join(work, "device") };
  if (enroll) {
    env.LINK_STUDIO_TEST_PROJECT_PARENT = work;
    env.LINK_STUDIO_TEST_MEDIA_FILES = join(work, enrollName);
    await copyFile(join(root, "resources/icons/icon-32.png"), env.LINK_STUDIO_TEST_MEDIA_FILES);
  }
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ args: [root], env });
  const studio = await app.firstWindow({ timeout: 30000 });
  if (detailLoading)
    await app.evaluate(({ ipcMain }) => {
      const method = "link-studio:settings:pluginDetail";
      ipcMain.removeHandler(method);
      ipcMain.handle(method, () => new Promise(() => {}));
    });
  studio.setDefaultTimeout(30000);
  if (pickerUpload)
    await app.evaluate(({ ipcMain }, state) => {
      const method = "link-studio:library:filingUpload";
      ipcMain.removeHandler(method);
      ipcMain.handle(method, () =>
        state === "queue"
          ? new Promise(() => {})
          : { ok: false, error: { message: "无法登记此图片" } },
      );
    }, filingPicker);
  if (["folders", "error", "loading"].includes(filingPicker))
    await app.evaluate(
      ({ ipcMain }, { state, folder }) => {
        const method = "link-studio:library:filingPage";
        ipcMain.removeHandler(method);
        let failed = false;
        ipcMain.handle(method, () => {
          if (state === "loading") return new Promise(() => {});
          if (state === "error" && !failed) {
            failed = true;
            return { ok: false, error: { code: "INTERNAL_ERROR", message: "个人库暂不可用" } };
          }
          return {
            ok: true,
            value: {
              page: crypto.randomUUID(),
              session: crypto.randomUUID(),
              destination: crypto.randomUUID(),
              folders: state === "folders" ? [folder] : [],
              items: [],
            },
          };
        });
      },
      { state: filingPicker, folder: pickerFolder },
    );
  if (detailPreview) {
    const urls = await studio.evaluate(() =>
      ["#8b3a46", "#246379"].map((color) => {
        const canvas = document.createElement("canvas");
        canvas.width = 300;
        canvas.height = 180;
        const context = canvas.getContext("2d");
        const fill = context.createLinearGradient(0, 0, 300, 180);
        fill.addColorStop(0, color);
        fill.addColorStop(1, "#ddd1ae");
        context.fillStyle = fill;
        context.fillRect(0, 0, 300, 180);
        context.fillStyle = "rgba(250,242,211,.7)";
        context.beginPath();
        context.arc(112, 72, 39, 0, Math.PI * 2);
        context.fill();
        return canvas.toDataURL("image/png");
      }),
    );
    detailHuman.images.forEach((image, index) => {
      image.asset = { id: image.id, kind: "image", fileName: `预览${index}.png`, url: urls[index] };
    });
    await app.evaluate(({ ipcMain }, urls) => {
      const method = "link-studio:settings:filingPreview";
      ipcMain.removeHandler(method);
      ipcMain.handle(method, (_event, input) => ({
        ok: true,
        value: urls[Number(input.assetId.split("-").at(-1))],
      }));
    }, urls);
  }
  if (pickerMixed)
    await app.evaluate(
      ({ ipcMain }, data) => {
        const method = "link-studio:settings:filingPreview";
        ipcMain.removeHandler(method);
        ipcMain.handle(method, (_event, input) => ({
          ok: true,
          value: input.assetId === "fixture-0" ? data : null,
        }));
      },
      `data:image/png;base64,${pickerImage.toString("base64")}`,
    );
  if (uploadDown)
    await app.evaluate(({ ipcMain }) => {
      const method = "link-studio:settings:pluginUpload";
      ipcMain.removeHandler(method);
      ipcMain.handle(method, () => ({ ok: false, code: "PLUGIN_RUNNER_CRASHED" }));
    });
  if (deleteVersion || (pluginDelete && pluginDelete !== "blocked")) {
    const upload = await studio.evaluate(async (source) => {
      const result = await window.desktop.settings.pluginUpload({ source });
      if (!result.ok) throw new Error(result.code);
      return result.value.plugin;
    }, `${source}\nmodule.exports.meta.key='fixture-delete';`);
    fixture.key = upload.key;
    fixture.source = "uploaded";
    Object.assign(fixture.versions[0], {
      plugin_key: upload.key,
      version: upload.version,
      created_by: 1,
      sha256: upload.hash,
    });
    if (pluginDelete === "refs") {
      await studio.evaluate(async (pluginHash) => {
        const api = window.desktop.settings;
        const channel = await api.channelSave({
          expectedRevision: 0,
          approve: true,
          fields: {
            name: "依赖",
            endpoint: "https://example.invalid",
            allowLocal: false,
            enabled: true,
            sort: 0,
            headers: [],
          },
        });
        if (!channel.ok) throw Error(channel.code);
        for (const name of ["示例甲", "示例乙"]) {
          const model = await api.modelSave({
            expectedRevision: 0,
            channelId: channel.value.id,
            channelRevision: channel.value.revision,
            enabled: false,
            pluginHash,
            upstreamModel: name === "示例甲" ? "alpha" : "beta",
            config: { kind: "text", name, sort: 0, description: "" },
            settings: {},
          });
          if (!model.ok) throw Error(model.code);
        }
      }, upload.hash);
      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(join(work, "device/settings/settings.sqlite"));
      try {
        database
          .prepare("INSERT INTO plugin_job_pins VALUES (?,?,?)")
          .run("audit", "one", upload.hash);
      } finally {
        database.close();
      }
    }
  }
  if (catalogState !== "ready")
    await app.evaluate(({ ipcMain }, state) => {
      const channel = "link-studio:settings:list";
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () =>
        state === "loading" ? new Promise(() => {}) : { ok: false, code: "SETTINGS_ACTION_FAILED" },
      );
    }, catalogState);
  const handle = await app.browserWindow(studio);
  await handle.evaluate(
    (win, size) => win.setContentSize(...size),
    compact ? [1024, 700] : [1280, 800],
  );
  if (
    channelEdit ||
    channelOverview ||
    kindConfirm ||
    disableConfirm ||
    modelList ||
    keys ||
    modelTab ||
    trialTab ||
    batch ||
    pull ||
    upgrade ||
    deleteChannel
  )
    channelId = await studio.evaluate(
      async ({
        trial,
        upgradeFailed,
        endpoint,
        mixed,
        resultKind,
        onlineNames,
        modelList,
        keysReplace,
        trialRefMenu,
        voiceMenu,
        channelFixtureUrl,
        dryView,
      }) => {
        const result = await window.desktop.settings.channelSave({
          expectedRevision: 0,
          approve: true,
          ...((trial || upgradeFailed) && { secret: "parity-credential" }),
          ...(keysReplace && { secret: "fixture-api", secretKey: "fixture-secondary" }),
          fields: {
            name: "测试渠道",
            endpoint: endpoint || channelFixtureUrl,
            allowLocal: Boolean(endpoint),
            enabled: true,
            sort: 100,
            headers: [],
          },
        });
        if (!result.ok) throw new Error(result.code);
        if (trial) {
          const catalog = await window.desktop.settings.list({});
          const plugin = catalog.value.plugins.find(
            (item) =>
              item.key === (voiceMenu ? "doubao-video" : trialRefMenu ? "openai-image" : "openai"),
          );
          const model = await window.desktop.settings.modelSave({
            channelId: result.value.id,
            channelRevision: result.value.revision,
            expectedRevision: 0,
            upstreamModel: voiceMenu ? "doubao-seedance-2-0" : "audit-model",
            pluginHash: plugin.hash,
            config: {
              name: "试跑样例",
              kind: voiceMenu ? "video" : trialRefMenu ? "image" : "text",
              sort: 100,
              description: "",
              ...(dryView && { logo: "openai", promptLimit: 16000 }),
              ...(trialRefMenu && { modes: ["i2i"], refs: { image: { max: 2, mb: 1 } } }),
              ...(voiceMenu && {
                modes: ["omni"],
                refs: {
                  image: { max: 0, mb: 1 },
                  video: { max: 0, mb: 1 },
                  audio: { max: 2, mb: 10 },
                },
              }),
              ...(modelList && { logo: "qwen", tags: ["推理"] }),
            },
            enabled: modelList || resultKind === "disable",
            settings: {},
          });
          if (!model.ok) throw new Error(model.code);
          if (modelList) {
            const imported = await window.desktop.settings.modelImport({
              id: result.value.id,
              expectedRevision: result.value.revision,
              models: ["待配置样例"],
            });
            if (!imported.ok) throw new Error(imported.code);
          }
          if (mixed)
            for (const name of [...onlineNames, "changed-model"]) {
              const skipped = name === "skip-model";
              const added =
                skipped && resultKind === "edit"
                  ? await window.desktop.settings.modelImport({
                      id: result.value.id,
                      expectedRevision: result.value.revision,
                      models: [name],
                    })
                  : await window.desktop.settings.modelSave({
                      channelId: result.value.id,
                      channelRevision: result.value.revision,
                      expectedRevision: 0,
                      upstreamModel: name,
                      pluginHash: plugin.hash,
                      config: {
                        name,
                        kind: "text",
                        sort: 100,
                        description: "",
                        ...(skipped &&
                          resultKind === "protocol" && { pricing: { unit: "request", input: 3 } }),
                      },
                      enabled: resultKind
                        ? skipped
                          ? resultKind === "enable"
                          : resultKind === "disable"
                        : name !== "changed-model",
                      settings: {},
                    });
              if (!added.ok) throw new Error(added.code);
            }
        }
        return result.value.id;
      },
      {
        trial: Boolean(
          kindConfirm || trialTab || dirtyTrial || batch || pull || migrate || modelList,
        ),
        modelList,
        dryView: dryView || trialRun,
        upgradeFailed: upgradeFailed || !!toggleState,
        mixed: batchProgress || allFailed || deleteResult || mixedAction,
        resultKind: progressKind ?? resultKind,
        onlineNames: batchProgress || allFailed ? [] : mixedAction ? ["skip-model"] : onlineNames,
        keysReplace,
        trialRefMenu,
        voiceMenu,
        channelFixtureUrl,
        endpoint:
          pull || trialRun || dirtyTrial
            ? `http://127.0.0.1:${server.httpServer.address().port}`
            : "",
      },
    );
  if (upgrade) {
    const versions = await studio.evaluate(
      async ({ channelId, source, models, multiple, failOne }) => {
        const api = window.desktop.settings;
        const first = await api.draft({ source });
        if (!first.ok) throw new Error(first.code);
        const middle = multiple
          ? await api.draft({ source: `${source}\n// previous revision` })
          : undefined;
        if (middle && !middle.ok) throw new Error(middle.code);
        for (const name of models) {
          const item = await api.modelSave({
            channelId,
            channelRevision: 1,
            expectedRevision: 0,
            upstreamModel: name,
            pluginHash: middle && name === models[1] ? middle.value.hash : first.value.hash,
            config: { name, kind: "text", sort: 100, description: "" },
            enabled: failOne && name === models[0],
            settings: {},
          });
          if (!item.ok) throw new Error(item.code);
        }
        const added = await api.draft({ source: `${source}\n// parity capture` });
        if (!added.ok) throw new Error(added.code);
        return [middle?.value, added.value]
          .filter(Boolean)
          .map(({ hash, version }) => ({ hash, version }));
      },
      {
        channelId,
        source,
        models: upgradeModels,
        multiple: upgradeMultiple,
        failOne: upgradeFailed || !!toggleState,
      },
    );
    for (const { hash, version } of versions)
      fixture.versions.push({
        ...fixture.versions[0],
        id: fixture.versions.length + 1,
        version,
        sha256: hash,
      });
  }
  if (migrate || batchChannel)
    await studio.evaluate(async () => {
      const added = await window.desktop.settings.channelSave({
        fields: {
          name: "目标渠道",
          endpoint: "https://example.invalid",
          enabled: true,
          allowLocal: false,
          sort: 200,
          headers: [],
        },
        approve: true,
        expectedRevision: 0,
      });
      if (!added.ok) throw new Error(added.code);
    });
  if (batchChannel)
    batchChannels = await studio.evaluate(async (long) => {
      const api = window.desktop.settings;
      if (long)
        for (let index = 1; index <= 5; index++) {
          const saved = await api.channelSave({
            expectedRevision: 0,
            approve: true,
            fields: {
              name: `备用渠道 ${index}`,
              endpoint: "https://example.invalid",
              enabled: true,
              allowLocal: false,
              sort: 200 + index,
              headers: [],
            },
          });
          if (!saved.ok) throw Error(saved.code);
        }
      return (await api.channelList({})).value.map((channel) => ({
        key: channel.id,
        name: channel.name,
        enabled: channel.enabled,
        secret_set: channel.hasSecret,
      }));
    }, batchChannel === "long");
  if (historyPins) {
    fixture.versions[0].model_count = historyNames.length;
    await studio.evaluate(
      async ({ names, hash }) => {
        const api = window.desktop.settings,
          channel = await api.channelSave({
            expectedRevision: 0,
            approve: true,
            fields: {
              name: "引用样例",
              endpoint: "https://example.invalid",
              enabled: true,
              allowLocal: false,
              sort: 0,
              headers: [],
            },
          });
        if (!channel.ok) throw Error(channel.code);
        for (const [sort, name] of names.entries()) {
          const saved = await api.modelSave({
            expectedRevision: 0,
            channelId: channel.value.id,
            channelRevision: channel.value.revision,
            enabled: false,
            settings: {},
            pluginHash: hash,
            upstreamModel: `fixture-${sort}`,
            config: { kind: "text", name, sort, description: "" },
          });
          if (!saved.ok) throw Error(saved.code);
        }
      },
      { names: historyNames, hash: fixture.versions[0].sha256 },
    );
  }
  if (!enroll && !humanDetail) await studio.getByRole("button", { name: "模型设置" }).click();
  if (
    !kindConfirm &&
    !channelOverview &&
    !disableConfirm &&
    !modelList &&
    !enroll &&
    !humanDetail &&
    !keys &&
    !channel &&
    !modelTab &&
    !trialTab &&
    !batch &&
    !pull &&
    !deleteChannel
  )
    await studio.getByRole("button", { name: "适配器管理", exact: true }).click();
  if (enroll || humanDetail) {
    const filingChannel = await studio.evaluate(async () => {
      const saved = await window.desktop.settings.channelSave({
        expectedRevision: 0,
        approve: true,
        fields: {
          name: "方舟",
          endpoint: "https://ark.cn-beijing.volces.com",
          enabled: true,
          allowLocal: false,
          sort: 1,
          headers: [],
          filing: { enabled: true, groupId: "sample", projectName: "" },
        },
        filingKeys: { accessKey: "audit", secretKey: "audit-secret" },
      });
      if (!saved.ok) throw new Error(saved.code);
      return saved.value.id;
    });
    if (enrollExisting || humanDetail) {
      const { DatabaseSync } = await import("node:sqlite");
      const previewSource =
        (detailPreview || pickerMixed) &&
        Buffer.from(
          await app.evaluate(({ safeStorage }) => [
            ...safeStorage.encryptString("https://fixture.invalid/preview.png"),
          ]),
        );
      const db = new DatabaseSync(join(work, "device/settings/settings.sqlite"));
      const scope = createHash("sha256")
        .update(
          JSON.stringify([filingChannel, "https://ark.cn-beijing.volces.com", "sample", "default"]),
        )
        .digest("hex");
      try {
        for (const person of humanDetail ? [detailHuman] : [...humans].reverse())
          for (const index of person.images.keys()) {
            const key = `${person.id}-${index}`;
            db.prepare("INSERT INTO ark_assets VALUES (?,?,?,?,?)").run(
              scope,
              key,
              key,
              key,
              person.images[index].status ?? "active",
            );
            db.prepare("INSERT INTO ark_members VALUES (?,?,?,?)").run(
              scope,
              key,
              person.id,
              person.name,
            );
            for (const ref of detailRefs.filter((ref) => ref.image_id === person.images[index].id))
              db.prepare("INSERT INTO ark_character_refs VALUES (?,?,?,?,?,?)").run(
                ref.canvas_id,
                ref.node_id,
                scope,
                key,
                ref.canvas_title,
                ref.node_name,
              );
            if (previewSource && (!pickerMixed || index === 0))
              db.prepare("INSERT INTO ark_sources VALUES (?,?,?,?)").run(
                scope,
                key,
                previewSource,
                key,
              );
          }
      } finally {
        db.close();
      }
    }
    if (humanDetail) {
      if (pickerImage)
        await studio.evaluate(
          async ({ channelId, image, mixed }) => {
            const api = window.desktop.projects,
              scope = { channelId, channelRevision: 1 };
            const loaded = await api.filingLibraryPage(scope);
            if (!loaded.ok) throw Error(loaded.error.message);
            const { page, session, destination } = loaded.value;
            try {
              for (const name of mixed ? ["角色图.png", "已备案.png"] : ["角色图.png"]) {
                const stored = await api.filingLibraryUpload({
                  ...scope,
                  session,
                  destination,
                  name,
                  bytes: new Uint8Array(image),
                });
                if (!stored.ok) throw Error(stored.error.message);
              }
            } finally {
              await api.filingLibraryClose({ page });
            }
          },
          { channelId: filingChannel, image: [...pickerImage], mixed: pickerMixed },
        );
      if (pickerMixed) {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(join(work, "device/settings/settings.sqlite"));
        try {
          db.prepare("ATTACH DATABASE ? AS personal").run(
            join(work, "device/personal-library/items.sqlite"),
          );
          const scope = createHash("sha256")
            .update(
              JSON.stringify([
                filingChannel,
                "https://ark.cn-beijing.volces.com",
                "sample",
                "default",
              ]),
            )
            .digest("hex");
          const row = db
            .prepare(
              "SELECT source_project,source_asset,json_extract(record,'$.sha256') AS hash FROM personal.library_items WHERE json_extract(record,'$.displayName')='已备案.png'",
            )
            .get();
          db.prepare("INSERT INTO ark_library_origins VALUES (?,?,?,?)").run(
            scope,
            "fixture-0",
            row.source_project,
            row.source_asset,
          );
          db.prepare("INSERT INTO ark_image_hashes VALUES (?,?,?)").run(
            scope,
            "fixture-0",
            row.hash,
          );
        } finally {
          db.close();
        }
      }
      if (pickerMore) {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(join(work, "device/personal-library/items.sqlite"));
        try {
          const source = JSON.parse(
            db.prepare("SELECT record FROM library_items LIMIT 1").get().record,
          );
          const insert = db.prepare("INSERT INTO library_items VALUES(?,?,?,?)");
          for (let index = 1; index <= 40; index++) {
            const assetId = crypto.randomUUID();
            insert.run(
              assetId,
              "fixture",
              assetId,
              JSON.stringify({ ...source, assetId, displayName: `分镜_${index}.png` }),
            );
          }
        } finally {
          db.close();
        }
      }
      await studio.getByRole("button", { name: "模型设置" }).click();
      await studio.getByRole("button", { name: "虚拟人像库" }).click();
      await studio.getByRole("button", { name: "查看详情" }).click();
    } else {
      await studio.getByRole("button", { name: "新建项目" }).click();
      await studio.getByRole("button", { name: "素材库", exact: true }).click();
      await studio.getByRole("button", { name: "导入素材", exact: true }).click();
      await studio.getByRole("button", { name: "加入真人库", exact: true }).click();
    }
  } else if (upgrade) {
    await studio.getByRole("searchbox", { name: "搜索插件" }).fill(fixture.key);
    const row = studio
      .getByRole("row")
      .filter({ has: studio.getByText(fixture.key, { exact: true }) });
    await (toggleState
      ? row.getByRole("switch", { name: "停用插件 OpenAI" })
      : row.getByRole("button", { name: "升级模型 OpenAI", exact: true })
    ).click();
    if (upgradeFailed) {
      await studio.evaluate(async (id) => {
        const cleared = await window.desktop.settings.channelKeys({
          id,
          expectedRevision: 1,
          clearSecret: true,
        });
        if (!cleared.ok) throw new Error(cleared.code);
      }, channelId);
    }
  } else if (channelEdit) {
    await studio.getByRole("button", { name: "编辑渠道", exact: true }).click();
    if (channelSaving)
      await app.evaluate(({ ipcMain }) => {
        const method = "link-studio:settings:channelSave";
        ipcMain.removeHandler(method);
        ipcMain.handle(method, async () => {
          await new Promise((resolve) => ipcMain.once("release-channel-save", resolve));
          return { ok: false, code: "SETTINGS_REVISION_CONFLICT" };
        });
      });
  } else if (channelOverview) {
    const header = studio.getByRole("region", { name: "渠道详情" });
    await header.waitFor();
    panelBox = await header.boundingBox();
  } else if (kindConfirm) {
    await studio.getByRole("button", { name: /^试跑样例/ }).click();
    await studio
      .getByRole("dialog", { name: "编辑模型" })
      .getByRole("button", { name: "Agent", exact: true })
      .click();
  } else if (disableConfirm) {
    await studio
      .getByRole("region", { name: "渠道详情" })
      .getByRole("button", { name: "停用", exact: true })
      .click();
  } else if (pluginDelete) {
    if (["error", "loading", "pending"].includes(pluginDelete))
      await app.evaluate(({ ipcMain }, state) => {
        const method = `link-studio:settings:${state === "pending" ? "pluginRemove" : "pluginDeleteCheck"}`;
        ipcMain.removeHandler(method);
        ipcMain.handle(method, () =>
          state === "error" ? { ok: false, code: "PLUGIN_VERSION_MISSING" } : new Promise(() => {}),
        );
      }, pluginDelete);
    await studio.getByRole("searchbox", { name: "搜索插件" }).fill(fixture.key);
    await studio
      .getByRole("row")
      .filter({ hasText: fixture.key })
      .getByRole("button", { name: "OpenAI 的更多操作", exact: true })
      .click();
    await studio.getByRole("menuitem", { name: "删除插件", exact: true }).click();
  } else if (deleteChannel) {
    await studio
      .getByRole("region", { name: "渠道详情" })
      .getByRole("button", { name: "删除", exact: true })
      .click();
  } else if (modelList) {
    await studio.getByRole("checkbox", { name: "选择 试跑样例" }).check();
    panelBox = await studio.locator(".channel-table").boundingBox();
    modelListItems = await studio.evaluate(async () => {
      const catalog = await window.desktop.settings.list({});
      if (!catalog.ok) throw Error(catalog.code);
      return catalog.value.providers
        .sort((left, right) => Number(right.enabled) - Number(left.enabled))
        .map((item) => {
          const plugin = catalog.value.plugins.find((entry) => entry.hash === item.pluginHash);
          return {
            key: item.id,
            name: item.config?.name ?? item.model,
            kind: item.config?.kind ?? "",
            vendor: item.config?.logo,
            tags: item.config?.tags,
            plugin: plugin?.key,
            plugin_name: plugin?.name,
            plugin_version: plugin?.version,
            enabled: item.enabled,
            health: item.enabled
              ? { status: "online" }
              : { status: "pending", reason: "还没有选择能力" },
          };
        });
    });
  } else if (catalogPanel) {
    await studio.getByRole("searchbox", { name: "搜索插件" }).fill(catalogQuery);
    await studio.getByRole("searchbox", { name: "搜索插件" }).blur();
    if (catalogState === "loading") await studio.getByLabel("加载中").first().waitFor();
    else if (catalogState === "error")
      await studio.getByText("加载失败", { exact: true }).waitFor();
    else if (catalogEmpty) await studio.getByText("没有匹配的插件", { exact: true }).waitFor();
    else
      await studio.waitForFunction(
        () =>
          document.querySelectorAll(".adapter-catalog tbody tr").length === 3 &&
          [...document.querySelectorAll(".adapter-catalog tbody tr")].every((row) =>
            row.firstElementChild?.textContent?.toLowerCase().includes("openai"),
          ),
      );
    await studio.evaluate(() => document.fonts.ready);
    panelBox = await studio.locator(".adapter-catalog").boundingBox();
  } else if (pull) {
    await studio
      .locator(".channel-model-heading")
      .getByRole("button", { name: "拉取模型", exact: true })
      .click();
    await (pullStatus
      ? studio.getByText(pullStatus, { exact: true })
      : studio.getByRole("checkbox", { name: "whisper-fixture" })
    ).waitFor();
  } else if (batch) {
    await studio.getByRole("checkbox", { name: "选择 试跑样例" }).check();
    if (allFailed || deleteResult || mixedAction)
      for (const name of [
        ...(allFailed ? [] : mixedAction ? ["skip-model"] : onlineNames),
        "changed-model",
      ])
        await studio.getByRole("checkbox", { name: `选择 ${name}`, exact: true }).check();
    if (allFailed || mixedAction || batchProgress)
      await studio.evaluate(
        async (names) => {
          const api = window.desktop.settings,
            listing = await api.list({});
          for (const name of names) {
            const stale = listing.value.providers.find((model) => model.model === name);
            const toggled = await api.modelToggle({
              id: stale.id,
              expectedRevision: stale.revision,
              enabled: stale.enabled,
            });
            if (!toggled.ok) throw Error(toggled.code);
          }
        },
        allFailed || batchProgress ? ["audit-model", "changed-model"] : ["changed-model"],
      );
    if (batchProgress) {
      await studio.getByRole("checkbox", { name: "选择 changed-model", exact: true }).check();
      await app.evaluate(
        ({ ipcMain }, { kind, done }) => {
          const method = `link-studio:settings:${{ enable: "modelToggle", disable: "modelToggle", edit: "modelSave", protocol: "modelSave", delete: "modelRemove" }[kind]}`;
          const original = ipcMain._invokeHandlers.get(method);
          if (typeof original !== "function") throw Error(`未注册 ${method}`);
          ipcMain.removeHandler(method);
          let calls = 0;
          ipcMain.handle(method, async (...args) => {
            if (calls++ === done)
              await new Promise((resolve) => ipcMain.once("release-batch-progress", resolve));
            return original(...args);
          });
        },
        { kind: progressKind, done: progressDone },
      );
      await studio.getByRole("button", { name: progressLabels[progressKind], exact: true }).click();
      if (progressKind === "edit" || progressKind === "protocol") {
        const form = studio.getByRole("dialog");
        if (progressKind === "edit") {
          await form.getByRole("checkbox", { name: "任务时限" }).check();
          await form.getByRole("textbox", { name: "任务时限" }).fill("90s");
        } else await form.getByRole("button", { name: "Agent", exact: true }).click();
        await form.getByRole("button", { name: "应用到 2 个模型" }).click();
      } else if (progressKind === "delete")
        await studio
          .getByRole("alertdialog")
          .getByRole("button", { name: "删除", exact: true })
          .click();
      const progress = studio.getByRole("status").filter({ hasText: progressText });
      await progress.waitFor();
      panelBox = await progress.boundingBox();
      assert.ok(
        await studio
          .locator(".channel-table")
          .evaluate(
            (table) =>
              table.getBoundingClientRect().bottom <=
              document.querySelector(".batch-progress").getBoundingClientRect().top,
          ),
        "progress follows the model table",
      );
    } else if (!batchToolbar)
      await studio.getByRole("button", { name: batchAction, exact: true }).click();
    if (resultKind === "edit" || resultKind === "protocol") {
      const form = studio.getByRole("dialog");
      if (resultKind === "edit") {
        await form.getByRole("checkbox", { name: "任务时限" }).check();
        await form.getByRole("textbox", { name: "任务时限" }).fill("90s");
      } else await form.getByRole("button", { name: "Agent", exact: true }).click();
      await form
        .getByRole("button", { name: `应用到 ${allFailed ? 2 : mixedAction ? 3 : 1} 个模型` })
        .click();
    }
    if (deleteResult) {
      if (!allFailed)
        await studio.evaluate(async () => {
          const api = window.desktop.settings;
          const listing = await api.list({});
          const stale = listing.value.providers.find((model) => model.model === "changed-model");
          const removed = await api.modelRemove({ id: stale.id, expectedRevision: stale.revision });
          if (!removed.ok) throw Error(removed.code);
        });
      await studio
        .getByRole("alertdialog")
        .getByRole("button", { name: "删除", exact: true })
        .click();
    }
  } else if (trialTab) {
    await studio.getByRole("button", { name: "测试 试跑样例", exact: true }).click();
    if (dryView) {
      await studio.clock.setFixedTime(dryTime);
      await studio.getByLabel("测试提示词").fill(dryPrompt);
      await studio.getByRole("button", { name: "只看请求（不发送）" }).click();
      await studio.getByRole("tabpanel", { name: "请求描述" }).locator("pre").waitFor();
    }
    if (trialRun) {
      const dialog = studio.getByRole("dialog");
      await dialog.getByLabel("测试提示词").fill(trialPrompt);
      await dialog.getByRole("button", { name: "开始测试" }).click();
      await dialog.locator('[role="tab"][aria-label="追踪"][aria-selected="true"]').waitFor();
      const readTrace = studio.waitForEvent("console", {
        predicate: (message) => message.text().startsWith("audit-trace:"),
      });
      await studio.evaluate(() =>
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (text) => console.log("audit-trace:" + text) },
        }),
      );
      await dialog.getByRole("button", { name: "复制全部（JSON）" }).click();
      const steps = JSON.parse((await readTrace).text().slice("audit-trace:".length));
      assert.deepEqual(
        steps.map((step) => step.hook ?? step.method),
        ["buildSubmitRequest", "POST", "parseSubmitResponse"],
      );
      trialSteps = steps.map((step) => ({
        kind: step.kind,
        name: step.phase,
        seq: step.seq,
        duration_ms: step.durationMs,
        ...(step.hook
          ? { hook: { name: step.hook } }
          : {
              request: {
                method: step.method,
                url: step.endpoint,
                headers: JSON.parse(step.requestHeaders.text),
                body: step.requestBody.text,
              },
              response: {
                status: step.status,
                body: step.responseBody.text,
                truncated: step.responseBody.truncated,
              },
            }),
      }));
    }
    await studio
      .getByRole("dialog")
      .getByRole("tab", { name: trialTabs[trialTab], exact: true })
      .click();
    if (trialRun) {
      await studio.getByText(trialFailed ? failureReason : trialText, { exact: true }).waitFor();
      trialTask = (await studio.getByRole("heading", { name: /试跑任务 #/ }).innerText()).split(
        "#",
      )[1];
      if (trialTimeline) await studio.getByRole("tab", { name: "追踪", exact: true }).click();
    }
  } else if (dirtyTrial) {
    await studio.getByRole("button", { name: /^试跑样例/ }).click();
  } else if (modelTab) {
    await studio
      .locator(".channel-model-heading")
      .getByRole("button", { name: /^(新增模型|新建模型)$/ })
      .click();
    if (priceFixture) {
      await studio.getByRole("button", { name: "配置 JSON" }).click();
      const input = studio.getByRole("textbox", { name: "配置 JSON" });
      await input.fill(
        JSON.stringify({ ...JSON.parse(await input.inputValue()), ...priceFixture }),
      );
      await studio.getByRole("button", { name: "回到表单" }).click();
    }
    if (priceState === "token-cost")
      await studio.getByRole("button", { name: "文本", exact: true }).click();
    if (contextHint) {
      await studio
        .getByRole("button", { name: contextAgent ? "Agent" : "文本", exact: true })
        .click();
      await studio.getByLabel("上游模型标识", { exact: true }).fill(contextName);
    }
    if (modelTab === "agent")
      await studio.getByRole("button", { name: "Agent", exact: true }).click();
    else if (modelTab !== "basic")
      await studio
        .getByRole(modelTab === "json" ? "button" : "tab", {
          name: modelTabs[modelTab],
          exact: true,
        })
        .click();
  } else if (channel)
    await studio
      .getByRole("complementary", { name: "模型渠道列表" })
      .getByRole("button", { name: "新增渠道", exact: true })
      .click();
  else if (keys) {
    await studio.getByRole("button", { name: "设置 Key", exact: true }).click();
    if (keysSaving || keysPartial)
      await app.evaluate(({ ipcMain }, partial) => {
        const method = "link-studio:settings:channelKeys";
        ipcMain.removeHandler(method);
        ipcMain.handle(method, async (_event, input) => {
          if (partial && !input.secret) return { ok: false, code: "SETTINGS_REVISION_CONFLICT" };
          if (!partial) await new Promise((resolve) => ipcMain.once("release-keys", resolve));
          return { ok: true, value: { revision: input.expectedRevision + 1 } };
        });
      }, keysPartial);
  } else if (upload) await studio.getByRole("button", { name: "上传插件", exact: true }).click();
  else {
    await studio.getByRole("searchbox", { name: "搜索插件" }).fill(fixture.key);
    await studio
      .getByRole("row")
      .filter({ hasText: fixture.key })
      .getByRole("button", { name: `查看 ${fixture.name}`, exact: true })
      .click();
    if (deleteVersion) {
      await studio.getByRole("tab", { name: /版本历史/ }).click();
      await studio
        .getByRole("button", { name: `删除 ${fixture.versions[0].version}`, exact: true })
        .click();
    }
  }
  if (history) {
    await studio.getByRole("tab", { name: /版本历史/ }).click();
    const registeredAt = await studio
      .locator(".adapter-uploader time")
      .first()
      .getAttribute("datetime");
    if (!registeredAt) throw new Error("缺少测试版本登记时间");
    fixture.versions[0].created_at = registeredAt;
  }
  const size = await studio.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const upstream = await browser.newPage({
    viewport: size,
    deviceScaleFactor: await studio.evaluate(() => devicePixelRatio),
    colorScheme: "dark",
  });
  upstream.on("pageerror", (err) => console.error("browser", err.message));
  upstream.setDefaultTimeout(30000);
  if (contextHint)
    await upstream.route(
      (url) => url.pathname.endsWith("/models/limits"),
      (route) =>
        route.fulfill({
          json: {
            code: 0,
            msg: "ok",
            data: {
              found: true,
              source: "builtin",
              context_window: contextAgent ? 1048576 : 128000,
              max_output: contextAgent ? 65536 : 16384,
              vision: true,
              video: contextAgent,
            },
          },
        }),
    );
  if (dryView) {
    await upstream.clock.setFixedTime(dryTime);
    await upstream.route("**/audit-model/dry-run", (route) =>
      route.fulfill({ json: { code: 0, msg: "ok", data: dryDescriptor } }),
    );
  }
  if (humanDetail)
    await upstream.route("**/virtual-humans/*/references", (route) =>
      route.fulfill({ json: { code: 0, msg: "ok", data: { items: detailRefs } } }),
    );
  if (filingPicker) {
    let failed = false;
    if (pickerHistory)
      await upstream.route(
        (url) => url.pathname.endsWith("/assets/generated"),
        (route) =>
          route.fulfill({ json: { code: 0, msg: "ok", data: { items: [], next_cursor: null } } }),
      );
    await upstream.route("**/asset-folders", (route) =>
      route.fulfill({
        json: {
          code: 0,
          msg: "ok",
          data: {
            items:
              filingPicker === "folders"
                ? [{ ...pickerFolder, item_count: 0, created_at: pickerFolder.createdAt }]
                : [],
          },
        },
      }),
    );
    await upstream.route("**/asset-library/items*", (route) => {
      if (pickerUpload && route.request().method() === "POST") {
        if (filingPicker === "queue") return;
        return route.fulfill({ json: { code: 500, msg: "无法登记此图片" } });
      }
      if (filingPicker === "loading") return;
      if (
        (filingPicker === "error" ||
          (pickerSearchError && new URL(route.request().url()).searchParams.get("q"))) &&
        !failed
      ) {
        failed = true;
        return route.fulfill({ status: 503, json: { msg: "个人库暂不可用" } });
      }
      const items = pickerImage
        ? [
            {
              id: "test",
              created_at: pickerFolder.createdAt,
              asset: {
                id: 123,
                kind: "image",
                file_name: "角色图.png",
                mime_type: "image/png",
                url: "/picker-image.png",
                width: 256,
                height: 256,
              },
            },
          ]
        : [];
      if (pickerMixed)
        items.unshift({
          ...items[0],
          id: "bound",
          asset: { ...items[0].asset, id: 124, file_name: "已备案.png" },
        });
      if (pickerMore) {
        if (!new URL(route.request().url()).searchParams.get("cursor"))
          return route.fulfill({
            json: {
              code: 0,
              msg: "ok",
              data: {
                items: Array.from({ length: 40 }, (_, index) => ({
                  ...items[0],
                  id: String(40 - index),
                  asset: { ...items[0].asset, id: 40 - index, file_name: `分镜_${40 - index}.png` },
                })),
                next_cursor: "next",
              },
            },
          });
        if (!failed) {
          failed = true;
          return route.fulfill({ status: 503, json: { msg: "暂不可用" } });
        }
      }
      return route.fulfill({ json: { code: 0, msg: "ok", data: { items, next_cursor: null } } });
    });
    if (pickerImage)
      await upstream.route("**/picker-image.png*", (route) =>
        route.fulfill({ contentType: "image/png", body: pickerImage }),
      );
    if (pickerUpload) {
      await upstream.route("**/assets/upload-intents", (route) =>
        route.fulfill({ json: { code: 0, msg: "ok", data: {} } }),
      );
      await upstream.route("**/assets", (route) =>
        route.fulfill({
          json: {
            code: 0,
            msg: "ok",
            data: { id: 123, file_name: "角色图.png", kind: "image", url: "/picker-image.png" },
          },
        }),
      );
    }
  }
  if (enroll)
    await upstream.route("**/enroll-image.png*", (route) =>
      route.fulfill({ contentType: "image/png", body: enrollImage }),
    );
  if (trialRun) {
    const view = {
      id: trialTask,
      model_id: "audit-model",
      kind: "text",
      ...(trialFailed
        ? {
            status: "failed",
            error_code: "PROVIDER_TEST_FAILED",
            error_message: failureReason,
            outputs: [],
          }
        : { status: "succeeded", outputs: [{ media_type: "text", text: trialText }] }),
    };
    for (const pattern of ["**/audit-model/test-run", `**/test-runs/${trialTask}`])
      await upstream.route(pattern, (route) =>
        route.fulfill({ json: { code: 0, msg: "ok", data: view } }),
      );
    await upstream.route(`**/test-runs/${trialTask}/trace`, (route) =>
      route.fulfill({ json: { code: 0, msg: "ok", data: { steps: trialSteps } } }),
    );
  }
  if (pull)
    await upstream.route("**/pull-models", (route) => {
      if (pullState === "loading") return;
      const models = pullState === "empty" ? [] : pulled;
      return route.fulfill({
        json:
          pullState === "error"
            ? { code: 50023, msg: "此端点没有提供兼容的模型目录，可以手动添加。" }
            : { code: 0, msg: "ok", data: { models, total: models.length } },
      });
    });
  if (voiceMenu) {
    const sql = await readFile(join(web, "../backend/migrations/0044_official_voices.sql"), "utf8");
    const voices = [
      ...sql.matchAll(
        /^ {2}\('(official-voices\/[^']+)', '[^']+', '[^']+', \d+, '((?:[^']|'')+)',/gm,
      ),
    ]
      .reverse()
      .map(([, key, name], index) => ({
        id: 181 - index,
        kind: "audio",
        file_name: name.replaceAll("''", "'"),
        url: `https://img.vbing.site/${key}`,
      }));
    assert.equal(voices.length, 181);
    assert.deepEqual(
      JSON.parse(await readFile(join(root, "src/renderer/settings/official-voices.json"), "utf8")),
      voices.map((entry) => ({ name: entry.file_name, url: entry.url })),
    );
    await upstream.route("**/assets/official?*", (route) => {
      const query = new URL(route.request().url()).searchParams;
      assert.deepEqual(
        [query.get("kind"), query.get("offset"), query.get("limit")],
        ["audio", "0", "100"],
      );
      return route.fulfill({
        json: { code: 0, msg: "ok", data: { total: 181, items: voices.slice(0, 100) } },
      });
    });
  }
  if (trialTab || dirtyTrial)
    await upstream.route("**/audit-model", (route) =>
      route.fulfill({
        json: {
          code: 0,
          msg: "ok",
          data: {
            key: "audit-model",
            target: "model",
            enabled: false,
            body: {
              key: "audit-model",
              kind: voiceMenu ? "video" : trialRefMenu ? "image" : "text",
              label: "试跑样例",
              ...((dryView || trialRun) && { vendor: "openai" }),
              capabilities: {
                prompt: { max_length: 16000 },
                ...(trialRefMenu && {
                  ops: ["i2i"],
                  refs: {
                    image: { on: true, max: 2, max_mb: 1 },
                    video: { on: false, max: 0, max_mb: 0 },
                    audio: { on: false, max: 0, max_mb: 0 },
                  },
                }),
                ...(voiceMenu && {
                  ops: ["omni"],
                  refs: {
                    image: { on: false, max: 0, max_mb: 1 },
                    video: { on: false, max: 0, max_mb: 1 },
                    audio: { on: true, max: 2, max_mb: 10 },
                  },
                }),
              },
              channels: [
                {
                  channel: channelId,
                  upstream_model: "audit-model",
                  protocol: { plugin: meta.key, version: meta.version, settings: {} },
                },
              ],
            },
          },
        },
      }),
    );
  await upstream.route("**/models/options*", (route) =>
    route.fulfill({
      json: {
        code: 0,
        msg: "ok",
        data: historyPins
          ? historyNames.map((label, index) => ({
              key: `fixture-${index}`,
              label,
              channel: "fixture",
              plugin: meta.key,
              plugin_version: meta.version,
            }))
          : upgrade
            ? upgradeModels.map((key) => ({
                key,
                label: key,
                channel: channelId,
                plugin: meta.key,
                plugin_version:
                  upgradeMultiple && key === upgradeModels[1]
                    ? fixture.versions[1].version
                    : meta.version,
              }))
            : [],
      },
    }),
  );
  if (upgrade)
    await upstream.route("**/channels/options*", (route) =>
      route.fulfill({ json: { code: 0, msg: "ok", data: [{ key: channelId, name: "测试渠道" }] } }),
    );
  await upstream.route("**/parity.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="zh-CN" class="admin-theme dark"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await import('/src/__audit.js');</script></body></html>`,
    }),
  );
  if (pluginDelete) {
    const blockers =
      pluginDelete === "blocked"
        ? [{ kind: "builtin_plugin", message: "内置插件不能删除，只能停用", refs: [] }]
        : pluginDelete === "refs"
          ? [
              {
                kind: "plugin_models",
                message: "2 个模型在用这个插件",
                refs: [
                  { key: "alpha", name: "示例甲" },
                  { key: "beta", name: "示例乙" },
                ],
              },
              { kind: "active_tasks", message: "1 个进行中的任务在用这个插件", refs: [] },
            ]
          : [];
    await upstream.route("**/delete-check", (route) =>
      pluginDelete === "loading"
        ? undefined
        : route.fulfill({
            json:
              pluginDelete === "error"
                ? { code: 404, msg: "插件不存在" }
                : { code: 0, msg: "ok", data: { blockers } },
          }),
    );
    if (pluginDelete === "pending") await upstream.route(`**/plugins/${fixture.key}`, () => {});
  }
  if (deleteChannel)
    await upstream.route("**/delete-check", (route) =>
      route.fulfill({
        json: {
          code: 0,
          msg: "ok",
          data: {
            blockers: migrate
              ? [
                  {
                    kind: "channel_models",
                    message: "1 个模型在用这个渠道",
                    refs: [{ key: "audit-model", name: "试跑样例" }],
                  },
                ]
              : [],
          },
        },
      }),
    );
  const upstreamWrites = [];
  if (dirtyTrial)
    upstream.on("request", (request) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method()))
        upstreamWrites.push(request.url());
    });
  await upstream.goto(`http://127.0.0.1:${server.httpServer.address().port}/parity.html`);
  if (dirtyTrial) {
    const { expect } = require("@playwright/test");
    const savedModel = () =>
      studio.evaluate(async () => {
        const result = await window.desktop.settings.list({});
        if (!result.ok) throw Error(result.code);
        const model = result.value.providers.find((item) => item.model === "audit-model");
        return { revision: model.revision, name: model.config.name };
      });
    const original = await savedModel();
    for (const page of [studio, upstream]) {
      const dialog = page.getByRole("dialog");
      const name = dialog.getByRole("textbox", { name: /展示名称/ });
      const trial = dialog.getByRole("button", { name: "测试模型" });
      await expect(name).toHaveValue(original.name);
      await expect(trial).toBeEnabled();
      await name.fill("未保存样例");
      await expect(trial).toBeDisabled();
      const wrapper = trial.locator("..");
      const box = await trial.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await dialog.getByRole("button", { name: "取消", exact: true }).focus();
      await page.keyboard.press("Shift+Tab");
      await expect(wrapper).toBeFocused();
      await expect(
        page.getByText("有未保存的修改，先保存", { exact: true }).filter({ visible: true }).first(),
      ).toBeVisible();
      await wrapper.press("Enter");
      await wrapper.press("Space");
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await name.fill("");
      await dialog.getByRole("tab", { name: /能力与参数/ }).click();
      await dialog
        .getByRole("button", { name: page === studio ? "保存模型" : "保存", exact: true })
        .click();
      await expect(name).toBeFocused();
      await expect(name).toHaveValue("");
      await expect(trial).toBeDisabled();
      await name.fill(original.name);
      await expect(trial).toBeEnabled();
    }
    assert.deepEqual(await savedModel(), original);
    assert.deepEqual(upstreamWrites, []);
    assert.deepEqual(providerCalls, []);
    assert.ok(!(await upstream.evaluate(() => window.auditTrialOpened)));
    await upstream.getByRole("button", { name: "测试模型" }).click();
    assert.equal(await upstream.evaluate(() => window.auditTrialOpened), true);
    await studio.getByRole("button", { name: "测试模型" }).click();
    await expect(studio.getByRole("dialog", { name: "测试 试跑样例" })).toBeVisible();
    assert.deepEqual(providerCalls, []);
    console.log(
      "M4",
      size,
      "脏草稿未触发试跑；手动保存校验失败后聚焦名称；还原后可进入试跑，零供应商请求",
    );
    break comparison;
  }
  if (history)
    for (const page of [studio, upstream]) {
      const timeline = page.locator('.adapter-history,[data-slot="timeline"]');
      const version = timeline.getByText(`v${meta.version}`, { exact: true });
      await version.click();
      assert.equal(
        await version.evaluate((element) =>
          Boolean(element.closest('button,a,[role="button"],[tabindex="0"]')),
        ),
        false,
      );
      assert.equal(await timeline.isVisible(), true);
      if (historyPins) {
        await timeline.getByText("等 10 个", { exact: true }).waitFor();
        assert.deepEqual(
          await timeline
            .getByRole("link")
            .allTextContents()
            .then((names) => names.map((name) => name.trim())),
          historyNames.slice(0, 8),
        );
      }
      await page.mouse.move(0, 0);
    }
  if (deleteVersion)
    await upstream
      .getByRole("button", { name: `删除 ${fixture.versions[0].version}`, exact: true })
      .click();
  if (deleteVersionState) {
    const {
        key,
        versions: [version],
      } = fixture,
      message = `版本 ${key}@${version.version} 被 0 个模型、1 个进行中的任务使用，无法删除`;
    await upstream.route(`**/plugins/${key}/versions/${version.version}`, (route) =>
      deleteVersionState === "error"
        ? route.fulfill({ json: { code: 50007, msg: message } })
        : undefined,
    );
    if (deleteVersionState === "error") {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(join(work, "device/settings/settings.sqlite"));
      try {
        database
          .prepare("INSERT INTO plugin_job_pins VALUES (?,?,?)")
          .run("audit", "race", version.sha256);
      } finally {
        database.close();
      }
    } else
      await app.evaluate(({ ipcMain }) => {
        const name = "link-studio:settings:pluginRemove";
        ipcMain.removeHandler(name);
        ipcMain.handle(name, () => new Promise(() => {}));
      });
    for (const page of [studio, upstream]) {
      const modal = page.getByRole("alertdialog");
      await modal.getByRole("button", { name: "删除", exact: true }).click();
      if (deleteVersionState === "error")
        await modal.getByText(message, { exact: true }).first().waitFor();
      else {
        assert.ok(await modal.getByRole("button", { name: "取消" }).isDisabled());
        await modal.getByRole("button", { name: "删除", exact: true }).locator("svg").waitFor();
      }
      await page.mouse.move(0, 0);
    }
  }
  if (uploadPending) {
    await upstream.route("**/plugins", () => {});
    for (const page of [studio, upstream]) {
      const input = page.getByLabel("选择插件文件");
      if (page === studio)
        await input.evaluate((element) => {
          element.addEventListener(
            "change",
            () => {
              element.files[0].text = () => new Promise(() => {});
            },
            { capture: true, once: true },
          );
        });
      await input.setInputFiles({
        name: "fixture.js",
        mimeType: "text/javascript",
        buffer: Buffer.from(source),
      });
      await page.getByRole("button", { name: "上传", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("status").filter({ hasText: "预检中…" }).waitFor();
      assert.equal(await dialog.getByRole("button", { name: "预检中…" }).isDisabled(), true);
      assert.equal(await dialog.getByRole("button", { name: "取消" }).isEnabled(), true);
      await page.addStyleTag({
        content: '[role="dialog"] svg, dialog svg { animation-play-state:paused !important; }',
      });
    }
  }
  if (uploadSuccess) {
    const key = "fixture-upload";
    const initialSource = `${source}\nmodule.exports.meta.key='${key}';`;
    const contents =
      initialSource +
      (uploadInvalidVersion
        ? "\nmodule.exports.meta.version='v1.0';"
        : uploadAdjusted
          ? "\n// revision"
          : "");
    if (uploadAdjusted && !uploadInvalidVersion)
      await studio.evaluate(async (source) => {
        const result = await window.desktop.settings.pluginUpload({ source });
        if (!result.ok) throw new Error(result.code);
      }, initialSource);
    const version = uploadInvalidVersion ? "1.0.0" : uploadAdjusted ? "1.2.2" : meta.version;
    const sha256 = createHash("sha256").update(contents).digest("hex");
    await upstream.route("**/plugins", (route) =>
      route.fulfill({
        json: {
          code: 0,
          msg: "ok",
          data: {
            accepted: true,
            version: { version, plugin_key: key, sha256 },
            ...(uploadAdjusted && {
              version_adjusted: { from: uploadInvalidVersion ? "" : meta.version, to: version },
            }),
          },
        },
      }),
    );
    for (const page of [studio, upstream]) {
      await page
        .getByLabel("选择插件文件")
        .setInputFiles({
          name: "fixture.js",
          mimeType: "text/javascript",
          buffer: Buffer.from(contents),
        });
      await page.getByRole("button", { name: "上传", exact: true }).click();
      await page.getByText(`预检通过，已登记 ${key}@${version}`, { exact: true }).waitFor();
      await page.getByText(`${sha256.slice(0, 8)}…`, { exact: true }).waitFor();
      if (uploadInvalidVersion)
        await page
          .getByText("代码里没有写合法的版本号，已自动登记为 v1.0.0", { exact: true })
          .waitFor();
    }
  }
  if (uploadDown || uploadLimit) {
    if (uploadDown)
      await upstream.route("**/plugins", (route) =>
        route.fulfill({ status: 503, json: { code: 50021, msg: "暂时不可用" } }),
      );
    for (const page of [studio, upstream]) {
      const dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("选择插件文件")
        .setInputFiles({
          name: "fixture.js",
          mimeType: "text/javascript",
          buffer: uploadLimit ? Buffer.alloc(524289, 32) : Buffer.from(source),
        });
      const submit = dialog.getByRole("button", { name: "上传", exact: true });
      if (uploadDown) await submit.click();
      await dialog
        .getByRole("alert")
        .getByText(uploadDown ? "稍后重试" : "文件 512.0KB，超过 512KB 上限", { exact: true })
        .waitFor();
      assert.equal(await submit.isEnabled(), uploadDown);
      await page.mouse.move(0, 0);
    }
  }
  if (uploadIssue) {
    const path = "meta.channelSettings.api.options";
    const message = "enum 必须提供非空的 options";
    await upstream.route("**/plugins", (route) =>
      route.fulfill({
        json: {
          code: 0,
          msg: "ok",
          data: {
            accepted: false,
            issues: [
              { path, message },
              { path: "meta.channelSettings.api.default", message: "默认值与类型 enum 不匹配" },
            ],
          },
        },
      }),
    );
    for (const page of [studio, upstream]) {
      await page.getByLabel("选择插件文件").setInputFiles({
        name: "broken.js",
        mimeType: "text/javascript",
        buffer: Buffer.from(
          source.replace('options: ["responses", "chat_completions"]', "options: []"),
        ),
      });
      await page.getByRole("button", { name: "上传", exact: true }).click();
      await page.getByText(path, { exact: true }).waitFor();
    }
  }
  if (uploadDuplicate) {
    const contents = `${source}\nmodule.exports.meta.key='duplicate-sample';`;
    const initial = await studio.evaluate(
      (source) => window.desktop.settings.pluginUpload({ source }),
      contents,
    );
    assert.ok(initial.ok);
    const message = `代码与 v${initial.value.plugin.version} 完全相同，没有产生新版本`;
    await upstream.route("**/plugins", (route) =>
      route.fulfill({
        json: {
          code: 0,
          msg: "ok",
          data: { accepted: false, issues: [{ path: "meta", message }] },
        },
      }),
    );
    for (const page of [studio, upstream]) {
      const form = page.getByRole("dialog");
      await form
        .getByLabel("选择插件文件")
        .setInputFiles({
          name: "duplicate.js",
          mimeType: "text/javascript",
          buffer: Buffer.from(contents),
        });
      await form.getByRole("button", { name: "上传", exact: true }).click();
      await form
        .getByText(message, { exact: true })
        .waitFor({ timeout: 10000 })
        .catch(async (error) => {
          throw new Error(`${page === studio ? "studio" : "upstream"}: ${await form.innerText()}`, {
            cause: error,
          });
        });
      assert.equal(await form.getByRole("button", { name: "复制修复信息" }).count(), 0);
      await form.getByRole("button", { name: "复制路径" }).waitFor();
      await page.mouse.move(0, 0);
    }
  }
  if (pluginDelete) {
    await upstream.getByRole("button", { name: "删除插件", exact: true }).click();
    for (const page of [studio, upstream]) {
      const dialog = page.getByRole("dialog");
      if (pluginDelete === "blocked")
        await dialog.getByText("内置插件不能删除，只能停用").waitFor();
      else if (pluginDelete === "refs")
        await dialog.getByText("1 个进行中的任务在用这个插件").waitFor();
      else if (pluginDelete === "error")
        await dialog.getByRole("button", { name: "重试" }).waitFor();
      else if (pluginDelete === "loading")
        await dialog.getByText("正在检查引用…", { exact: true }).waitFor();
      else {
        const input = dialog.getByLabel("输入名称确认删除"),
          button = dialog.getByRole("button", { name: "删除", exact: true });
        assert.ok(await button.isDisabled());
        await input.fill(fixture.key);
        assert.ok(await button.isEnabled());
        if (pluginDelete === "pending") {
          await button.click();
          assert.ok(await dialog.getByRole("button", { name: "取消" }).isDisabled());
        } else await input.blur();
      }
      await page.mouse.move(0, 0);
    }
  }
  if (deleteChannel) await upstream.getByRole("button", { name: "删除渠道", exact: true }).click();
  if (upgrade)
    await upstream.getByRole("button", { name: toggleState ? "停用插件" : "升级模型" }).click();
  if (toggleState && toggleState !== "confirm") {
    await upstream.route("**/plugins/fixture-upgrade/enabled", (route) =>
      toggleState === "pending"
        ? undefined
        : route.fulfill({ json: { code: 404, msg: "插件不存在" } }),
    );
    await app.evaluate(({ ipcMain }, state) => {
      const method = "link-studio:settings:pluginToggle";
      ipcMain.removeHandler(method);
      ipcMain.handle(method, () =>
        state === "pending" ? new Promise(() => {}) : { ok: false, code: "PLUGIN_VERSION_MISSING" },
      );
    }, toggleState);
    for (const page of [studio, upstream]) {
      const modal = page.getByRole("alertdialog"),
        action = modal.getByRole("button", { name: "停用", exact: true });
      await action.click();
      if (toggleState === "pending") {
        await action.locator("svg").waitFor();
        assert.ok(await modal.getByRole("button", { name: "取消" }).isDisabled());
        assert.ok(await action.isDisabled());
        await page.keyboard.press("Escape");
        assert.ok(await modal.isVisible());
        await action.locator("svg").evaluate((icon) => {
          for (const animation of icon.getAnimations()) {
            animation.pause();
            animation.currentTime = 0;
          }
        });
      } else {
        await modal.getByRole("alert").getByText("插件不存在").waitFor();
        assert.ok(await action.isEnabled());
      }
    }
  }
  if (upgradePending || upgradeDisabled) {
    if (upgradePending) {
      await upstream.route("**/upgrade-models", () => {});
      await app.evaluate(({ ipcMain }) => {
        const method = "link-studio:settings:pluginUpgradeAll";
        ipcMain.removeHandler(method);
        ipcMain.handle(method, () => new Promise(() => {}));
      });
    } else {
      await upstream.route("**/upgrade-models", (route) =>
        route.fulfill({ json: { code: 409, msg: "插件已停用" } }),
      );
      await studio.evaluate(async (key) => {
        const api = window.desktop.settings;
        const versions = await api.list({});
        const hash = versions.value.plugins.find((entry) => entry.key === key).hash;
        const result = await api.pluginToggle({ hash, enabled: false });
        if (!result.ok) throw Error(result.code);
      }, fixture.key);
    }
    for (const page of [studio, upstream]) {
      const modal = page.getByRole("alertdialog"),
        confirm = modal.getByRole("button", { name: "全部升级" });
      await confirm.click();
      if (upgradePending) {
        await confirm.locator("svg").waitFor();
        assert.ok(await confirm.isDisabled());
        assert.ok(await modal.getByRole("button", { name: "取消" }).isDisabled());
        await page.keyboard.press("Escape");
        assert.ok(await modal.isVisible());
        await confirm.locator("svg").evaluate((icon) => {
          for (const animation of icon.getAnimations()) {
            animation.pause();
            animation.currentTime = 0;
          }
        });
      } else {
        await modal.getByRole("alert").getByText("插件已停用").waitFor();
        assert.ok(await confirm.isEnabled());
      }
    }
  }
  if (upgradeFailed) {
    let expectedNotice;
    await upstream.route("**/upgrade-models", (route) =>
      route.fulfill({
        json: {
          code: 0,
          msg: "ok",
          data: {
            to_version: fixture.versions.at(-1).version,
            upgraded: ["beta-chat"],
            failed: [
              {
                key: "alpha-chat",
                reason: `渠道 "${channelId}" 的 Key 尚未设置，请联系超级管理员设置后再试`,
              },
            ],
          },
        },
      }),
    );
    for (const [label, page] of [
      ["studio", studio],
      ["upstream", upstream],
    ]) {
      await page.getByRole("button", { name: "全部升级" }).click();
      await page.getByRole("button", { name: "重试失败项" }).waitFor();
      await page.getByRole("list", { name: "升级失败的模型" }).getByText("alpha-chat").waitFor();
      if (upgradeNotice) {
        const notice = page
          .locator("[data-sonner-toast]")
          .filter({ hasText: `1 个模型已升级到 v${fixture.versions.at(-1).version}` });
        await notice.waitFor();
        await page.waitForFunction(() => {
          const toast = document.querySelector("[data-sonner-toast]");
          return (
            toast &&
            toast.getBoundingClientRect().y === 24 &&
            !toast.getAnimations().some((animation) => animation.playState === "running") &&
            getComputedStyle(toast).opacity === "1"
          );
        });
        const controls = await notice.evaluate((el) =>
          [el, el.querySelector("svg"), el.querySelector("[data-title]")].map((node) => {
            const box = node.getBoundingClientRect();
            return [box.x, box.y, box.width, box.height];
          }),
        );
        assert.equal(controls[0][2], 356);
        if (expectedNotice)
          assert.deepEqual(controls, expectedNotice, "toast bounds, icon and title should match");
        expectedNotice = controls;
        console.log("upgrade-notice", label, JSON.stringify(controls));
        await notice.screenshot({ path: join(work, `${captureName}-${label}.png`), scale: "css" });
      }
    }
  }
  if (pull)
    await (pullStatus
      ? upstream.getByText(pullStatus, { exact: true })
      : upstream.getByRole("checkbox", { name: "whisper-fixture" })
    ).waitFor();
  if (batch && !batchResult && !batchToolbar && !batchProgress) {
    await upstream.getByRole("button", { name: batchAction, exact: true }).click();
    let protocolControlBounds;
    if (batchProtocolEmpty)
      for (const page of [studio, upstream]) {
        const dialog = page.getByRole("dialog");
        await dialog.getByRole("button", { name: "文本", exact: true }).click();
        await dialog.getByRole("searchbox").fill("not-a-protocol");
        const empty = dialog.getByText("没有匹配的协议", { exact: true });
        const detail = dialog.getByText("未选择协议", { exact: true });
        assert.equal(await dialog.getByRole("radio").count(), 0);
        assert.ok(await dialog.getByRole("button", { name: "应用到 1 个模型" }).isDisabled());
        const controls = [];
        for (const control of [dialog.getByRole("searchbox"), empty, detail])
          controls.push(
            await control.evaluate((el) => {
              const box = el.getBoundingClientRect(),
                origin = el.closest("dialog,[role=dialog]").getBoundingClientRect();
              return [box.x - origin.x, box.y - origin.y, box.width, box.height];
            }),
          );
        if (protocolControlBounds)
          assert.deepEqual(
            controls,
            protocolControlBounds,
            "empty protocol search, empty row and detail",
          );
        protocolControlBounds = controls;
        await page.mouse.move(0, 0);
      }
    if (batchSelectedProtocol)
      for (const page of [studio, upstream]) {
        const dialog = page.getByRole("dialog");
        await dialog.getByRole("button", { name: "文本", exact: true }).click();
        await dialog.getByLabel("搜索协议").fill("openai");
        const option = dialog.getByRole("radio", { name: /^OpenAI / }).first();
        await option.click();
        assert.equal(await option.getAttribute("aria-checked"), "true");
        const controls = await dialog.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return [
            ...el.querySelectorAll(
              '[aria-label="搜索协议"], [role="radio"], [role="combobox"], input[type="text"]',
            ),
          ].map((element) => {
            const box = element.getBoundingClientRect();
            return [box.x - rect.x, box.y - rect.y, box.width, box.height];
          });
        });
        assert.equal(controls.length, 6, "search, radio, version and three protocol settings");
        if (protocolControlBounds)
          controls.forEach((bounds, index) =>
            bounds.forEach((value, axis) => {
              assert.ok(
                Math.abs(value - protocolControlBounds[index][axis]) <= 1 / 64,
                `protocol control ${index}, axis ${axis}`,
              );
            }),
          );
        protocolControlBounds = controls;
        await page.mouse.move(0, 0);
      }
    if (batchAgent)
      for (const page of [studio, upstream]) {
        const dialog = page.getByRole("dialog");
        await dialog.getByRole("button", { name: "Agent", exact: true }).click();
        assert.ok(await dialog.getByRole("button", { name: "应用到 1 个模型" }).isEnabled());
        assert.equal(await dialog.getByRole("searchbox").count(), 0);
        await page.mouse.move(0, 0);
      }
    if (batchTimeout)
      for (const page of [studio, upstream])
        await page.getByRole("checkbox", { name: "任务时限" }).check();
    if (batchChannel)
      for (const page of [studio, upstream]) {
        await page.getByRole("checkbox", { name: "所属渠道" }).check();
        await page.getByRole("combobox", { name: "所属渠道" }).click();
        const list = page.getByRole("listbox");
        await list.getByRole("option", { name: "目标渠道" }).waitFor();
        assert.deepEqual(await list.getByRole("option").allTextContents(), [
          "选择渠道",
          ...batchChannels.map((channel) => channel.name),
        ]);
        if (batchChannel === "selected")
          await list.getByRole("option", { name: "目标渠道" }).click();
        await page.mouse.move(0, 0);
      }
  }
  if (trialTab) {
    const dialog = upstream.getByRole("dialog", { name: "测试 试跑样例" });
    if (dryView) {
      await dialog.locator("textarea").fill(dryPrompt);
      await dialog.getByRole("button", { name: "只看请求（不发送）" }).click();
      await dialog.getByRole("tabpanel", { name: "请求描述" }).locator("pre").waitFor();
    } else if (trialRun) {
      await dialog.locator("textarea").fill(trialPrompt);
      await dialog.getByRole("button", { name: /开始测试/ }).click();
      await dialog
        .getByRole("tab", { name: /追踪/ })
        .and(dialog.locator('[aria-selected="true"]'))
        .waitFor();
      await dialog.getByRole("tab", { name: /结果/ }).click();
      await dialog.getByText(trialFailed ? failureReason : trialText, { exact: true }).waitFor();
      if (trialFailed)
        for (const page of [upstream, studio]) {
          const panel = page.getByRole("tabpanel");
          assert.ok(
            await panel
              .getByRole("heading", { name: `试跑任务 #${trialTask}`, exact: true })
              .isVisible(),
          );
          await panel.getByText("failed", { exact: true }).waitFor();
          await panel.getByRole("alert").getByText("测试失败", { exact: true }).waitFor();
          await panel.getByRole("alert").getByRole("button", { name: "复制修复信息" }).waitFor();
        }
      if (trialTimeline) {
        await dialog.getByRole("tab", { name: /追踪/ }).click();
        let expected;
        let expectedBlocks;
        for (const page of [upstream, studio]) {
          if (timelineState) {
            if (page === studio)
              await app.evaluate(({ ipcMain }, state) => {
                const method = "link-studio:settings:modelTrialTrace";
                ipcMain.removeHandler(method);
                ipcMain.handle(method, () =>
                  state === "empty"
                    ? { ok: true, value: [] }
                    : { ok: false, code: "SETTINGS_ACTION_FAILED" },
                );
              }, timelineState);
            else
              await page.route(`**/test-runs/${trialTask}/trace`, (route) =>
                route.fulfill({
                  json:
                    timelineState === "empty"
                      ? { code: 0, msg: "ok", data: { steps: [] } }
                      : { code: 50007, msg: "无法读取" },
                }),
              );
          }
          await page.getByRole("button", { name: "刷新", exact: true }).click();
          if (timelineState) {
            const panel = page.getByRole("tabpanel");
            await panel
              .getByRole("status")
              .getByText(timelineState === "empty" ? "暂无追踪" : "没能取到追踪", { exact: true })
              .waitFor();
            assert.equal(await panel.getByRole("button", { name: "复制全部（JSON）" }).count(), 0);
            const badge = page.getByRole("tab", { name: /追踪/ });
            assert.equal(
              (await badge.innerText()).replace(/\s/g, ""),
              timelineState === "empty" ? "追踪0" : "追踪",
            );
            if (timelineState === "error") {
              const notice = panel.getByRole("status");
              await notice.getByRole("button", { name: "刷新", exact: true }).waitFor();
              const bounds = await notice.evaluate((root) =>
                [
                  root,
                  root.querySelector("svg"),
                  [...root.querySelectorAll("strong,span")].find(
                    (el) => el.textContent === "没能取到追踪",
                  ),
                  root.querySelector("button"),
                ].map((el) => {
                  const rect = el.getBoundingClientRect();
                  return [rect.x, rect.y, rect.width, rect.height];
                }),
              );
              if (expected)
                assert.deepEqual(bounds, expected, "追踪读取失败的图标、提示和重试按钮位置及尺寸");
              expected = bounds;
            }
            continue;
          }
          await page.getByRole("button", { name: /parseSubmitResponse/ }).waitFor();
          const timeline = page.getByRole("heading", { name: /追踪 · 试跑/ }).locator("../..");
          const rects = await timeline.evaluate((section) =>
            [
              section.querySelector("h3"),
              section.querySelector("button"),
              ...section.querySelectorAll("ol > li"),
            ].map((node) => {
              const rect = node.getBoundingClientRect();
              return [rect.x, rect.y, rect.width, rect.height];
            }),
          );
          console.log(
            page === studio ? "studio timeline" : "upstream timeline",
            JSON.stringify(rects),
          );
          if (expected)
            assert.deepEqual(
              rects.slice(1),
              expected.slice(1),
              "刷新按钮及时间线各步骤的位置、尺寸",
            );
          expected = rects;
          if (expandedTimeline) {
            await timeline.getByRole("button", { name: /http.*POST/ }).press("Enter");
            const blocks = await timeline.locator("pre").allTextContents();
            assert.equal(blocks.length, 3);
            if (page === upstream) expectedBlocks = blocks;
            else assert.deepEqual(blocks, expectedBlocks, "同一脱敏请求头、请求体和响应体");
          }
        }
      }
    } else await dialog.getByRole("tab", { name: trialTabs[trialTab], exact: true }).click();
  }
  if (priceState === "token-cost")
    await upstream.getByRole("button", { name: "文本", exact: true }).click();
  if (contextHint) {
    await upstream
      .getByRole("button", { name: contextAgent ? "Agent" : "文本", exact: true })
      .click();
    await upstream.locator("#model-upstream").fill(contextName);
  }
  if (modelTab === "agent")
    await upstream.getByRole("button", { name: "Agent", exact: true }).click();
  else if (modelTab && !["basic", "json"].includes(modelTab))
    await upstream.getByText(modelTabs[modelTab], { exact: true }).first().click();
  let catalogEntries;
  let catalogGeometry;
  let selectGeometry;
  let tierControlGeometry;
  let logoItems;
  let tagGeometry;
  let detailGeometry;
  let basicControls;
  let modelChrome;
  let enrollGeometry;
  let voiceGeometry;
  let pullGeometry;
  let approvalRegion;
  for (const [label, page] of [
    ["studio", studio],
    ["upstream", upstream],
  ]) {
    if (pull) {
      const modal = page.getByRole("dialog", { name: "选择要导入的模型" });
      if (pullState === "nomatch") {
        await modal.getByRole("searchbox").fill("no-model-match");
        await modal.getByRole("button", { name: "取消全选" }).press("Space");
        await modal.getByText("没有匹配的模型", { exact: true }).waitFor();
        assert.equal(await modal.getByRole("checkbox").count(), 0);
        await modal.getByText("已选择 3 / 3 个模型").waitFor();
      }
      if (pullState === "loading")
        await modal
          .getByText(pullStatus, { exact: true })
          .locator("svg")
          .evaluate((icon) => {
            for (const animation of icon.getAnimations()) {
              animation.pause();
              animation.currentTime = 0;
            }
          });
      assert.equal(
        await modal.getByRole("button", { name: "手动新增模型" }).count(),
        ["error", "empty"].includes(pullState) ? 1 : 0,
      );
      assert.equal(
        await modal.getByRole("button", { name: "重试" }).count(),
        pullState === "error" ? 1 : 0,
      );
      const geometry = await modal.evaluate((el) => {
        const origin = el.getBoundingClientRect();
        return [
          el,
          ...el.querySelectorAll(
            "input[type=search],label:has(code),label:has([role=checkbox]),[role=alert],button",
          ),
        ]
          .filter(
            (node) =>
              node.getBoundingClientRect().width &&
              (node.tagName !== "BUTTON" ||
                ["手动新增模型", "取消", "确认导入", "重试", "全选", "取消全选"].includes(
                  node.textContent.trim(),
                )),
          )
          .map((node) => {
            const box = node.getBoundingClientRect();
            return [box.x - origin.x, box.y - origin.y, box.width, box.height];
          });
      });
      if (pullGeometry) {
        assert.equal(geometry.length, pullGeometry.length);
        geometry.forEach((rect, index) =>
          rect.forEach((value, axis) =>
            assert.ok(
              Math.abs(value - pullGeometry[index][axis]) < 0.1,
              `${label} ${rect} vs ${pullGeometry[index]}`,
            ),
          ),
        );
      }
      pullGeometry = geometry;
      await page.mouse.move(0, 0);
    }
    if (humanRemove) await page.getByRole("button", { name: "移除真人" }).click();
    if (channelEdit) {
      const editor = page.getByRole("dialog", { name: "编辑渠道", exact: true });
      assert.equal(await editor.getByLabel("渠道名称", { exact: false }).inputValue(), "测试渠道");
      assert.equal(await editor.locator("input[type=password]").count(), 0);
      await editor.getByRole("switch", { name: "启用", exact: true }).waitFor();
      if (channelApproval) {
        if (channelApproval === "endpoint")
          await editor.getByLabel("Base URL", { exact: false }).fill("https://example.invalid/v2");
        if (channelApproval === "network" && label === "studio")
          await editor.getByLabel("允许本机或内网端点").check();
        const approval = editor.getByRole("checkbox", {
          name:
            channelApproval === "endpoint"
              ? "确认更换端点，原有 Key 将清除"
              : "确认更改本机或内网授权，原有 Key 将清除",
          exact: true,
        });
        if (label === "studio") {
          await approval.waitFor();
          assert.equal(await approval.isChecked(), false);
          await approval.focus();
          await page.keyboard.press("Space");
          assert.ok(await approval.isChecked());
          await page.keyboard.press("Space");
          assert.equal(await approval.isChecked(), false);
        } else assert.equal(await approval.count(), 0);
      }
      if (channelSaving) {
        if (label === "upstream") await page.route("**/channels/sample", () => {});
        await editor.getByLabel("渠道名称", { exact: false }).fill("更新中");
        await editor.getByRole("button", { name: "保存", exact: true }).click();
        await editor.getByRole("button", { name: "保存", disabled: true }).waitFor();
        for (const field of await editor.locator("input:visible,button:visible").all())
          assert.ok(await field.isDisabled(), `${label}: controls should be disabled while saving`);
        await editor
          .getByRole("button", { name: "保存", disabled: true })
          .locator("svg")
          .evaluate((icon) => {
            for (const animation of icon.getAnimations()) {
              animation.pause();
              animation.currentTime = 0;
            }
          });
      }
      if (channelFiling) {
        await editor.getByRole("switch", { name: "虚拟人像库", exact: true }).press("Space");
        await editor.getByLabel("素材组 ID", { exact: false }).fill("sample");
        await editor.getByLabel("素材组 ID", { exact: false }).evaluate((node) => {
          let container = node.parentElement;
          while (container && !["auto", "scroll"].includes(getComputedStyle(container).overflowY))
            container = container.parentElement;
          if (!container) throw new Error("scroll container missing");
          container.scrollTop = container.scrollHeight;
        });
      }
      if (channelInvalid) {
        await editor.getByLabel("渠道名称", { exact: false }).fill("");
        await editor.getByLabel("Base URL", { exact: false }).fill("");
        await editor.getByRole("button", { name: "保存", exact: true }).click();
        assert.deepEqual(await editor.getByRole("alert").allTextContents(), [
          "请填写渠道名称",
          "请填写 Base URL",
        ]);
      }
      if (channelDiscard) {
        await editor.getByLabel("渠道名称", { exact: false }).fill("未保存");
        await editor.getByRole("button", { name: "取消", exact: true }).click();
        await page.getByRole("alertdialog", { name: "放弃未保存的修改？" }).waitFor();
      }
      await page.bringToFront();
      await page
        .getByRole(channelDiscard ? "alertdialog" : "dialog")
        .last()
        .evaluate((el) => {
          if (el.contains(document.activeElement)) document.activeElement.blur();
        });
      await page.mouse.move(0, 0);
    }
    if (filingPicker) {
      if (pickerUpload || filingPicker === "loading")
        await page.emulateMedia({ reducedMotion: "reduce" });
      await page.getByRole("button", { name: "添加图片" }).click();
      if (pickerHistory) {
        const modal = page.getByRole("dialog").last();
        await modal.getByRole("tab", { name: "生成历史" }).click();
        await modal.getByText("暂无相关资产", { exact: true }).waitFor();
        if (filingPicker === "history-filtered") {
          await modal.getByPlaceholder("搜索提示词").fill("分镜");
          await modal.getByRole("button", { name: "清除筛选" }).waitFor();
          await modal.getByPlaceholder("搜索提示词").blur();
        }
      } else if (filingPicker === "loading")
        await page.getByRole("status", { name: "加载中" }).waitFor();
      else if (pickerUpload) {
        const modal = page.getByRole("dialog").last();
        await modal.getByText("还没有资产", { exact: true }).waitFor();
        const count = filingPicker === "queue" ? 4 : 1,
          buffer = await readFile(join(root, "resources/icons/icon-32.png"));
        await modal
          .locator('input[type="file"]')
          .setInputFiles(
            Array.from({ length: count }, (_, index) => ({
              name: `角色图${index + 1}.png`,
              mimeType: "image/png",
              buffer,
            })),
          );
        await modal
          .getByText(filingPicker === "queue" ? "处理中…" : "无法登记此图片", { exact: true })
          .nth(filingPicker === "queue" ? 2 : 0)
          .waitFor();
        if (filingPicker === "queue") await modal.getByText("等待上传", { exact: true }).waitFor();
      } else if (pickerMore) {
        const modal = page.getByRole("dialog").last();
        await modal.getByRole("button", { name: "分镜_40.png", exact: true }).waitFor();
        const { DatabaseSync } = await import("node:sqlite");
        const db =
          label === "studio"
            ? new DatabaseSync(join(work, "device/personal-library/items.sqlite"))
            : undefined;
        try {
          db?.exec("ALTER TABLE removed_library_items RENAME TO unavailable_items");
          await modal.locator(moreFooter).scrollIntoViewIfNeeded();
          await modal.locator(moreFooter).getByText("加载失败").waitFor();
        } finally {
          if (db) {
            db.exec("ALTER TABLE unavailable_items RENAME TO removed_library_items");
            db.close();
          }
        }
      } else if (pickerImage) {
        const modal = page.getByRole("dialog").last();
        const choice = modal.getByRole("button", { name: "角色图.png", exact: true });
        if (pickerMixed) {
          await modal.getByRole("button", { name: "已备案.png", exact: true }).waitFor();
          assert.ok(
            await modal.getByRole("button", { name: "已备案.png", exact: true }).isDisabled(),
          );
          await modal.getByText("已在真人库", { exact: true }).waitFor();
          await choice.focus();
          await choice.press("Space");
          await modal.getByRole("button", { name: "取消选择 角色图.png" }).waitFor();
          await choice.evaluate((el) => el.blur());
        } else await choice.click();
        if (pickerSearchError) {
          const { DatabaseSync } = await import("node:sqlite");
          const db =
            label === "studio"
              ? new DatabaseSync(join(work, "device/personal-library/items.sqlite"))
              : undefined;
          try {
            db?.exec("ALTER TABLE folder_members RENAME TO unavailable_members");
            const input = modal.getByPlaceholder("搜索文件名");
            await input.fill("角色");
            await input.evaluate((node) => node.blur());
            await modal.getByText("加载失败", { exact: true }).waitFor();
            assert.ok(await modal.getByRole("button", { name: "取消选择 角色图.png" }).isVisible());
            assert.ok(await modal.getByRole("button", { name: "添加并提交备案" }).isEnabled());
            assert.ok(await modal.getByRole("button", { name: "上传", exact: true }).isEnabled());
          } finally {
            if (db) {
              db.exec("ALTER TABLE unavailable_members RENAME TO folder_members");
              db.close();
            }
          }
        }
        await modal.getByRole("button", { name: "添加并提交备案" }).waitFor();
        await modal
          .locator("img")
          .evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
      } else
        await page
          .getByText(
            filingPicker === "folders"
              ? "这里还没有素材"
              : filingPicker === "error"
                ? "加载失败"
                : "还没有资产",
            { exact: true },
          )
          .waitFor();
      await page.mouse.move(0, 0);
    }
    const dialog = batchProgress
      ? page.getByRole("status").filter({ hasText: progressText })
      : humanRemove
        ? page.getByRole("alertdialog", { name: "移除真人「角色乙」？" })
        : channelOverview
          ? page.locator(label === "studio" ? ".channel-overview" : '[data-slot="channel-header"]')
          : modelList
            ? page.locator(
                label === "studio" ? ".channel-table" : "#audit-model-panel > div:first-child",
              )
            : batchToolbar
              ? page.getByRole("toolbar", { name: "已选 1 个模型的批量操作" })
              : catalogPanel
                ? page.locator(label === "studio" ? ".adapter-catalog" : '[data-slot="data-panel"]')
                : page.getByRole(smallConfirm || upgrade ? "alertdialog" : "dialog").last();
    await dialog.waitFor({ timeout: 35000 });
    if (detailSettings) {
      const body = dialog.locator('.adapter-dialog-body,[data-slot="detail-dialog-body"]');
      const rows = body.locator("section li");
      await rows.last().waitFor();
      assert.deepEqual(
        await rows.locator("code").allTextContents(),
        Object.keys(meta.channelSettings),
      );
      await body.hover();
      await page.mouse.wheel(0, 1400);
      await page.waitForFunction(() => {
        const body = document.querySelector(
          '.adapter-dialog-body,[data-slot="detail-dialog-body"]',
        );
        return (
          body && body.scrollTop > 0 && body.scrollTop + body.clientHeight >= body.scrollHeight - 1
        );
      });
      await page.mouse.move(0, 0);
      const scroll = await body.evaluate((node) => [
        node.scrollTop,
        node.clientHeight,
        node.scrollHeight,
      ]);
      console.log(label, "overview-scroll", JSON.stringify(scroll));
      const overviewTab = dialog.getByRole("tab", { name: "概览" });
      await overviewTab.click();
      await overviewTab.press("Enter");
      assert.equal(
        await body.evaluate((node) => node.scrollTop),
        scroll[0],
        `${label} 重选概览应保留协议设置的阅读位置`,
      );
      await page.evaluate(() => document.activeElement?.blur());
      await page.mouse.move(0, 0);
    }
    if (dryView) {
      const current = dialog.getByRole("tabpanel", { name: "请求描述" }),
        code = current.locator("pre"),
        text = await code.innerText();
      assert.deepEqual(JSON.parse(text), dryDescriptor, `${label} 应显示同一份脱敏请求描述`);
      const hide = current.getByRole("button", { name: "收起", exact: true });
      if (dryView === "short") assert.equal(await hide.count(), 0);
      else {
        await hide.press("Enter");
        assert.equal(
          await code.innerText(),
          text.split("\n").slice(0, 12).join("\n").slice(0, 1500) + "\n…",
        );
        const show = current.getByRole("button", { name: `展开全部（${text.length} 字符）` });
        if (dryView === "long") {
          await show.press("Space");
          assert.equal(await code.innerText(), text);
        }
      }
      await page.evaluate(() => document.activeElement?.blur());
      await page.mouse.move(0, 0);
      const left = dialog.locator(
        '.model-trial-input,div.overflow-y-auto:has(> [data-slot="test-node"])',
      );
      await left.evaluate((el) => {
        el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 4);
      });
      const layout = await dialog.evaluate((root) => {
        const origin = root.getBoundingClientRect();
        const measure = (el) => {
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return [
            rect.x - origin.x,
            rect.y - origin.y,
            rect.width,
            rect.height,
            el.scrollTop,
            el.scrollHeight,
            el.clientHeight,
          ];
        };
        return Object.fromEntries(
          Object.entries({
            prompt: "textarea",
            action: '.model-trial-card footer button,[data-slot="test-node"] button:last-child',
            pre: '[role="tabpanel"] pre',
            time: '[role="tabpanel"] time,[role="tabpanel"] p',
            fold: '[role="tabpanel"] button',
            panel: '[role="tabpanel"]',
          }).map(([name, selector]) => [name, measure(root.querySelector(selector))]),
        );
      });
      console.log(label, "dry-layout", JSON.stringify(layout));
      if (dryGeometry)
        assert.deepEqual(
          layout,
          dryGeometry,
          "同一滚动位置的输入、执行、时间、正文、折叠按钮和结果面板应对齐",
        );
      else dryGeometry = layout;
    }
    let validJson;
    if (jsonExtension) {
      const input = dialog.getByRole("textbox", { name: "配置 JSON" });
      await page.waitForFunction(() =>
        document.querySelector('textarea[aria-label="配置 JSON"]')?.value.includes('"channels"'),
      );
      const text = JSON.stringify(
        {
          kind: "text",
          label: "离线扩展草稿",
          enabled: false,
          sort: 10,
          channels: [{ channel: channelId, upstream_model: "fixture-text" }],
          extension: { note: "保留原文" },
        },
        null,
        2,
      );
      await input.fill(text);
      await dialog.getByText("JSON 语法正确", { exact: true }).waitFor();
      assert.equal(await input.getAttribute("aria-invalid"), "false");
      assert.equal(await dialog.getByRole("alert").count(), 0);
      await input.evaluate((field) => field.blur());
      await page.mouse.move(0, 0);
    }
    if (jsonInvalidReturn) {
      const input = dialog.getByRole("textbox", { name: "配置 JSON" });
      await page.waitForFunction(() =>
        document.querySelector('textarea[aria-label="配置 JSON"]')?.value.includes('"channels"'),
      );
      validJson = await input.inputValue();
      const raw = jsonNonObject ? "[]" : '{\n  "label": trux\n}';
      await input.fill(raw);
      const back = dialog.getByRole("button", { name: "回到表单" });
      await back.press("Enter");
      await dialog
        .getByRole("alert")
        .filter({ hasText: "无法切回表单" })
        .getByText(
          jsonNonObject
            ? "正文必须是 JSON 对象，才能切回表单。"
            : /JSON 有语法错误（第 2 行 第 12 列）/,
        )
        .waitFor();
      assert.equal(await input.getAttribute("aria-invalid"), String(!jsonNonObject));
      if (jsonNonObject) await dialog.getByText("JSON 语法正确", { exact: true }).waitFor();
      assert.equal(await input.inputValue(), raw);
      await dialog.getByText("未选渠道 · 未填写", { exact: true }).waitFor();
      await back.evaluate((button) => button.blur());
      await page.mouse.move(0, 0);
    }
    if (priceState === "token-cost") {
      await dialog.getByLabel("输入价", { exact: true }).fill("2000");
      await dialog.getByLabel("输出价", { exact: true }).fill("3000");
      await dialog.getByRole("switch", { name: "积分成本", exact: true }).click();
      for (const [name, value] of [
        ["输入成本", "3000"],
        ["输出成本", "1500"],
      ]) {
        const input = dialog.getByLabel(name, { exact: true });
        if (name === "输入成本") assert.equal(await input.inputValue(), "");
        await input.fill(value);
        assert.equal((await input.boundingBox()).width, 256);
      }
      await dialog.getByText("利润率 -50%", { exact: true }).waitFor();
      await dialog.getByText("利润率 50%", { exact: true }).waitFor();
      await dialog
        .getByText(/1000 字提示词.*8192 Token 输出：最多冻结\s*27\s*积分/)
        .last()
        .waitFor();
      await dialog.getByLabel("输出成本", { exact: true }).evaluate((input) => input.blur());
      await page.mouse.move(0, 0);
    }
    if (priceState === "second") {
      const table = dialog.getByRole("table");
      const prices = await table
        .locator("tr")
        .evaluateAll((rows) =>
          rows.map((row) => [...row.cells].map((cell) => cell.textContent.trim())),
        );
      assert.deepEqual(prices, [
        ["精度", "每秒", "最短 2秒", "默认 6秒", "最长 10秒"],
        ["标准", "2", "4", "12", "20"],
        ["高", "7", "14", "42", "70"],
      ]);
      assert.equal(
        await table
          .getByLabel("默认参数")
          .evaluate((star) => star.closest("td").textContent.trim()),
        "7",
      );
      await dialog.getByText("aspect_ratio", { exact: true }).waitFor();
      await dialog.getByText(/条件里的「aspect_ratio」已不能作为规格维度/).waitFor();
    }
    if (priceState === "stale") {
      await dialog.getByText(/条件里的「legacy」已不能作为规格维度/).waitFor();
      const staleControls = [
        dialog.getByText("legacy", { exact: true }),
        dialog.getByText("退役档", { exact: true }),
        dialog.getByRole("button", { name: "移除条件" }),
      ];
      const boxes = await Promise.all(staleControls.map((control) => control.boundingBox()));
      console.log(label, "stale-controls", JSON.stringify(boxes));
      if (tierControlGeometry)
        assert.deepEqual(
          boxes,
          tierControlGeometry,
          "失效维度、取值标签及移除按钮的位置和尺寸应相同",
        );
      tierControlGeometry = boxes;
    }
    if (priceState === "tiers") {
      const table = dialog.getByRole("table");
      assert.deepEqual(
        await table
          .locator("tr")
          .evaluateAll((rows) =>
            rows.map((row) => [...row.cells].map((cell) => cell.textContent.trim())),
          ),
        [
          ["精度 \\ 降噪", "开", "关"],
          ["标准", "4", "2"],
          ["高", "9", "2"],
        ],
      );
      assert.equal(await table.getByLabel("默认参数").count(), 1);
      const cells = await table.locator("tbody tr").evaluateAll((rows) =>
        rows.map((row) =>
          [...row.cells].map((cell) => {
            const rect = cell.getBoundingClientRect();
            return [rect.width, rect.height];
          }),
        ),
      );
      if (selectGeometry)
        cells.forEach((row, index) =>
          row.forEach((rect, column) =>
            assert.ok(
              rect.every(
                (value, coord) => Math.abs(value - selectGeometry[index][column][coord]) <= 1,
              ),
              "规格报价行高及列宽偏差不可超过 1 CSS px",
            ),
          ),
        );
      selectGeometry = cells;
      const controls = [
        dialog.getByRole("switch", { name: "第 1 条规格价格可供用户使用" }),
        dialog.getByRole("button", { name: "任意", exact: true }).first(),
        dialog.getByRole("spinbutton", { name: "第 1 条规格价格", exact: true }),
        dialog.getByRole("switch", { name: "第 1 条规格价格积分成本" }),
        dialog.getByRole("button", { name: "删除第 1 条规格价格" }),
      ];
      const boxes = await Promise.all(controls.map((control) => control.boundingBox()));
      console.log(label, "tier-controls", JSON.stringify(boxes));
      if (tierControlGeometry)
        boxes.forEach((box, index) => {
          for (const dimension of ["x", "y", "width", "height"])
            assert.ok(
              Math.abs(box[dimension] - tierControlGeometry[index][dimension]) < 0.1,
              `规格卡控件 ${index} 的 ${dimension} 未对齐`,
            );
        });
      tierControlGeometry = boxes;
    }
    if (detailLoading) {
      await dialog.getByRole("tab", { name: /版本历史/ }).click();
      const skeleton = dialog.locator(
        '[aria-busy="true"] :is(.adapter-detail-skeleton span,[data-slot="skeleton"])',
      );
      assert.equal(await skeleton.count(), 11);
      const geometry = await skeleton.evaluateAll((nodes) =>
        nodes.map((el) => {
          for (const animation of el.getAnimations()) {
            animation.pause();
            animation.currentTime = 0;
          }
          const rect = el.getBoundingClientRect();
          return [rect.x, rect.y, rect.width, rect.height];
        }),
      );
      if (detailGeometry)
        assert.deepEqual(geometry, detailGeometry, "all eleven skeleton rectangles must match");
      detailGeometry = geometry;
      await page.mouse.move(0, 0);
    }
    if (upgrade) await page.mouse.move(0, 0);
    if (batchProgress) {
      const toolbar = page.getByRole("toolbar", { name: "已选 2 个模型的批量操作" });
      assert.equal(await toolbar.locator("button:disabled").count(), 5);
      await toolbar.getByRole("button", { name: "清除选择" }).click();
      await toolbar.waitFor({ state: "hidden" });
      await dialog.locator("svg").evaluate((icon) => {
        for (const animation of icon.getAnimations()) {
          animation.pause();
          animation.currentTime = 0;
        }
      });
      const geometry = await dialog.evaluate((el) => {
        const rect = el.getBoundingClientRect(),
          icon = el.querySelector("svg").getBoundingClientRect();
        return [
          rect.width,
          rect.height,
          icon.width,
          icon.height,
          getComputedStyle(el).gap,
          getComputedStyle(el).padding,
          el.textContent.trim(),
        ];
      });
      if (detailGeometry) assert.deepEqual(geometry, detailGeometry);
      detailGeometry = geometry;
    }
    if (upload) {
      await page.bringToFront();
      await page.mouse.move(0, 0);
      if (uploadPrompt) {
        const active = () =>
          page.evaluate(
            () =>
              document.activeElement?.getAttribute("aria-label") ??
              document.activeElement?.textContent?.trim().slice(0, 30),
          );
        assert.equal(await active(), "选择插件文件");
        await page.keyboard.press("Tab");
        assert.equal(await active(), "复制提示词");
        await page.keyboard.press("Tab");
        assert.equal(await active(), "预览提示词");
        await page.keyboard.press("Enter");
        const prompt = dialog.locator("details[open] pre");
        await prompt.waitFor();
        const geometry = await prompt.evaluate((el) => [
          el.clientWidth,
          el.clientHeight,
          el.scrollHeight,
          el.textContent,
        ]);
        assert.equal(geometry[1], 222);
        if (selectGeometry) assert.deepEqual(geometry, selectGeometry);
        selectGeometry = geometry;
      }
    }
    if (voiceMenu) {
      const trigger = dialog.getByRole("button", { name: "音色库" });
      await trigger.click();
      const menu = page.getByRole("menu");
      const items = menu.getByRole("menuitem");
      await items.last().waitFor();
      assert.equal(await items.count(), 100);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(200);
      const anchor = await trigger.boundingBox(),
        popup = await menu.boundingBox(),
        first = await items.first().boundingBox();
      console.log("voice-menu", label, JSON.stringify({ anchor, popup, first }));
      const geometry = [anchor, popup, first].flatMap((rect) => [
        rect.x,
        rect.y,
        rect.width,
        rect.height,
      ]);
      if (voiceGeometry)
        assert.ok(
          geometry.every((value, index) => Math.abs(value - voiceGeometry[index]) < 0.5),
          "voice picker viewport bounds must match to within half a CSS pixel",
        );
      voiceGeometry = geometry;
      assert.ok(
        await menu.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(rect.x + 30, rect.bottom - 10));
        }),
        "visible options outside the dialog must be clickable",
      );
      assert.deepEqual([anchor.height, popup.width, first.width, first.height], [28, 240, 228, 36]);
      assert.ok(
        Math.abs(popup.x - anchor.x) < 1 &&
          Math.abs(popup.y - anchor.y - anchor.height - 6) < 1 &&
          popup.height >= 138,
      );
      assert.deepEqual([first.x - popup.x, first.y - popup.y], [6, 30]);
    }
    if (trialRefMenu) {
      const trigger = dialog.getByRole("button", { name: "画布素材" });
      await trigger.click();
      const menu = page.getByRole("menu");
      await menu.getByText("画布里还没有可用的参考图片", { exact: true }).waitFor();
      await page.waitForTimeout(200);
      const anchor = await trigger.boundingBox(),
        popup = await menu.boundingBox();
      console.log(
        "trial-ref-menu",
        label,
        JSON.stringify([
          anchor.width,
          anchor.height,
          popup.width,
          popup.height,
          popup.x - anchor.x,
          popup.y - anchor.y - anchor.height,
        ]),
      );
      assert.deepEqual([anchor.width, anchor.height, popup.width, popup.height], [86, 28, 224, 68]);
      assert.ok(
        Math.abs(popup.x - anchor.x) < 1 && Math.abs(popup.y - anchor.y - anchor.height - 6) < 1,
      );
      const rows = await menu.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return [...el.querySelector('[role="group"]').children].map((child) => {
          const rect = child.getBoundingClientRect();
          const style = getComputedStyle(child);
          return [
            rect.x - box.x,
            rect.y - box.y,
            rect.width,
            rect.height,
            style.fontSize,
            style.fontWeight,
            style.color,
            style.fontFamily,
          ];
        });
      });
      console.log("trial-ref-rows", label, JSON.stringify(rows));
      assert.deepEqual(
        rows.map((row) => row.slice(0, 4)),
        [
          [6, 6, 212, 24],
          [6, 30, 212, 32],
        ],
      );
    }
    if (modelTab === "agent") {
      await dialog.getByRole("combobox", { name: "接口格式" }).waitFor();
      await dialog.getByPlaceholder("/v1", { exact: true }).waitFor();
      await dialog.locator('input[placeholder="用户在画布里看到的名字"]').evaluate((input) => {
        input.scrollIntoView({ block: "center" });
        input.blur();
      });
      await page.mouse.move(0, 0);
    }
    if (modelList) {
      assert.equal(await dialog.locator("tbody tr").count(), 2);
      assert.equal(await dialog.locator('tbody tr[data-state="selected"]').count(), 1);
      await dialog.getByText("推理", { exact: true }).waitFor();
      await dialog.getByText("还没有选择能力", { exact: true }).waitFor();
    }
    if (batchResult) {
      await dialog.getByRole("heading", { name: `${batchAction}完成` }).waitFor();
      await dialog
        .getByText(
          `成功 ${mixedResult.done.length} 项，跳过 ${mixedResult.skipped.length} 项，失败 ${mixedResult.failed.length} 项。`,
        )
        .waitFor();
      if (allFailed) {
        assert.deepEqual(
          await dialog.getByRole("alert").locator("li").allTextContents(),
          mixedResult.failed.map((item) => `${item.key}：${item.reason}`),
        );
        assert.equal(await dialog.getByRole("status").count(), 0);
        if (label === "studio") {
          const models = await page.evaluate(
            async () => (await window.desktop.settings.list({})).value.providers,
          );
          for (const { key } of mixedResult.failed) {
            const saved = models.find((model) => model.model === key);
            assert.ok(saved);
            assert.equal(saved.enabled, resultKind === "disable");
            assert.equal(saved.config.kind, "text");
            assert.notEqual(saved.config.timeoutSeconds, 90);
          }
        }
      }
      if (deleteResult || mixedAction)
        await dialog.getByRole("alert").getByText("changed-model", { exact: true }).waitFor();
      if (mixedAction)
        await dialog.getByText(`skip-model：${skipReason[resultKind]}`, { exact: true }).waitFor();
      if (!deleteResult && !allFailed) {
        await dialog.getByRole("status").getByText("audit-model", { exact: true }).waitFor();
        if (label === "studio") {
          const saved = await page.evaluate(async () =>
            (await window.desktop.settings.list({})).value.providers.find(
              (model) => model.model === "audit-model",
            ),
          );
          if (resultKind === "edit") assert.equal(saved.config.timeoutSeconds, 90);
          else if (resultKind === "protocol") assert.equal(saved.config.kind, "agent");
          else assert.equal(saved.enabled, resultKind === "enable");
        }
      }
      assert.ok(
        await dialog
          .getByRole("button", { name: "知道了" })
          .evaluate((el) => el === document.activeElement),
        "result summary must initially focus acknowledgement",
      );
      await page.keyboard.press("Tab");
      assert.ok(
        await dialog
          .getByRole("button", { name: "关闭", exact: true })
          .evaluate((el) => el === document.activeElement),
      );
      await page.keyboard.press("Shift+Tab");
      assert.ok(
        await dialog
          .getByRole("button", { name: "知道了" })
          .evaluate((el) => el.matches(":focus-visible")),
      );
      if (longResult) {
        const body = dialog
          .locator(".batch-outcomes,div.overflow-y-auto")
          .filter({ has: dialog.page().getByText("changed-model", { exact: true }) })
          .last();
        assert.equal(await body.evaluate((el) => el.clientHeight), 288);
        const bounds = await body.boundingBox();
        if (firstResultPage) {
          assert.equal(await body.evaluate((el) => el.scrollTop), 0);
          const failure = await body.getByText("changed-model", { exact: true }).boundingBox();
          assert.ok(
            failure.y >= bounds.y && failure.y + failure.height <= bounds.y + bounds.height,
          );
          assert.ok(
            (await body.getByText("audit-model", { exact: true }).boundingBox()).y >=
              bounds.y + bounds.height,
          );
        } else {
          await body.hover();
          await page.mouse.wheel(0, 800);
          await page.waitForFunction(() =>
            [...document.querySelectorAll(".batch-outcomes,div.overflow-y-auto")].some(
              (el) => el.scrollTop > 0 && el.clientHeight + el.scrollTop >= el.scrollHeight - 1,
            ),
          );
          const final = await body.getByText("audit-model", { exact: true }).boundingBox();
          assert.ok(final.y >= bounds.y && final.y + final.height <= bounds.y + bounds.height);
        }
      }
      await page.mouse.move(0, 0);
    }
    if (keys) {
      await page.bringToFront();
      if (keysReplace) {
        const clear = dialog.getByRole("checkbox");
        const api = dialog.getByLabel("API Key", { exact: true }),
          secondary = dialog.getByLabel("Secret Key（可选）");
        if (!keysSaving && !keysPartial) await clear.check();
        await api.fill("test-replacement");
        if (keysSaving || keysPartial) {
          if (label === "upstream") {
            await page.route("**/channels/*/secret", (route) =>
              keysPartial ? route.fulfill({ json: { code: 0, msg: "ok", data: {} } }) : undefined,
            );
            await page.route("**/channels/*/secret-key", (route) =>
              route.fulfill({ status: 409, json: { code: 409, msg: "冲突" } }),
            );
          }
          if (keysPartial) await secondary.fill("sample-secondary");
          const save = dialog.getByRole("button", { name: "保存", exact: true });
          await save.click();
          if (keysSaving) {
            await save.locator("svg").waitFor();
            for (const field of [
              api,
              secondary,
              clear,
              save,
              dialog.getByRole("button", { name: "取消" }),
            ])
              assert.ok(await field.isDisabled());
            await save.locator("svg").evaluate((icon) => {
              for (const animation of icon.getAnimations()) {
                animation.pause();
                animation.currentTime = 0;
              }
            });
          } else {
            await dialog
              .getByText(
                "API Key 已保存，但 Secret Key 没有保存成功，请重新输入 Secret Key 再保存。",
              )
              .waitFor();
            assert.ok((await secondary.isEnabled()) && (await save.isDisabled()));
          }
          assert.deepEqual(await Promise.all([api.inputValue(), secondary.inputValue()]), ["", ""]);
          await page.mouse.move(0, 0);
        }
      }
      await dialog.getByLabel("API Key", { exact: true }).evaluate((el) => el.blur());
    }
    if (enrollExisting) {
      await dialog.getByRole("tab", { name: "加到已有真人" }).click();
      assert.ok(await dialog.getByRole("button", { name: /角色甲/ }).isDisabled());
      assert.ok(await dialog.getByRole("button", { name: "加入并提交备案" }).isDisabled());
      await dialog.getByRole("button", { name: /角色乙/ }).click();
      assert.equal(
        await dialog.getByRole("button", { name: /角色乙/ }).getAttribute("aria-pressed"),
        "true",
      );
      assert.ok(await dialog.getByRole("button", { name: "加入并提交备案" }).isEnabled());
      await page.mouse.move(0, 0);
    }
    if (enroll || humanDetail) await page.bringToFront();
    if (humanDetail && !humanRemove && !filingPicker) {
      await dialog.getByLabel("真人名称", { exact: true }).evaluate((el) => el.blur());
      await dialog.getByRole("button", { name: "添加图片" }).waitFor();
      if (detailPreview) {
        await dialog.locator("li img").nth(1).waitFor();
        assert.equal(await dialog.getByRole("button", { name: "重新提交" }).isEnabled(), true);
        await dialog.locator("li img").evaluateAll(async (images) => {
          for (const image of images) {
            await image.decode();
            const bounds = image.getBoundingClientRect();
            if (
              image.naturalWidth !== 300 ||
              image.naturalHeight !== 180 ||
              Math.abs(bounds.width - bounds.height) > 0.1 ||
              getComputedStyle(image).objectFit !== "cover"
            )
              throw Error("预览图比例／裁切不一致");
          }
        });
      }
      await page.mouse.move(0, 0);
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    const metric = await dialog.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const css = getComputedStyle(el);
      const title = el.querySelector('h2,[data-slot="dialog-title"]');
      return {
        ...(el.querySelector(
          '.plugin-upgrade-list,ul[aria-label="要升级的模型"],ul[aria-label="升级失败的模型"]',
        ) && {
          upgradeControls: [
            ...el.querySelectorAll(
              'h2,[data-slot="alert-dialog-description"],.model-dialog-head p,ul,li > *,[role="alert"],button,button svg',
            ),
          ]
            .filter((control) => !control.closest("[data-sonner-toaster]"))
            .map((control) => {
              const rect = control.getBoundingClientRect();
              return [
                control.textContent.trim(),
                rect.x - box.x,
                rect.y - box.y,
                rect.width,
                rect.height,
              ];
            }),
        }),
        ...(title?.textContent === "上传插件" &&
          el.querySelector("dl") && {
            uploadResultControls: [
              ...el.querySelectorAll(
                '[role="status"] svg,[role="status"] strong,[role="status"] span.font-medium,[role="status"] dt,[role="status"] dd,[role="status"] p,[role="status"] .opacity-80:not(:has(dl)),button',
              ),
            ].map((control) => {
              const rect = control.getBoundingClientRect();
              return [rect.x - box.x, rect.y - box.y, rect.width, rect.height];
            }),
          }),
        ...(title?.textContent.startsWith("批量设置能力与协议") && {
          kindButtons: [...el.querySelectorAll("button[aria-pressed]")].map((button) => {
            const rect = button.getBoundingClientRect();
            return [
              button.textContent.trim(),
              rect.x - box.x,
              rect.y - box.y,
              rect.width,
              rect.height,
            ];
          }),
        }),
        ...(el.getAttribute("role") === "toolbar" && {
          buttons: [...el.querySelectorAll("button")].map((button) => {
            const rect = button.getBoundingClientRect();
            return [rect.x - box.x, rect.y - box.y, rect.width, rect.height];
          }),
        }),
        ...(el.getAttribute("role") === "toolbar" && {
          toolbarStyles: [
            el.firstElementChild?.matches("div") ? el.firstElementChild : el,
            ...el.querySelectorAll("button"),
          ].map((control) => {
            const css = getComputedStyle(control);
            const icon = control.querySelector("svg")?.getBoundingClientRect();
            return [
              css.backgroundColor,
              css.color,
              css.borderRadius,
              css.backgroundClip,
              icon && [icon.x - box.x, icon.y - box.y, icon.width, icon.height],
            ];
          }),
        }),
        ...(el.querySelector('[data-slot="notice"],.batch-outcomes') && {
          notices: [...el.querySelectorAll('[data-slot="notice"],.batch-outcomes section')].map(
            (notice) => {
              const rect = notice.getBoundingClientRect();
              return [
                notice.getAttribute("role"),
                rect.x - box.x,
                rect.y - box.y,
                rect.width,
                rect.height,
              ];
            },
          ),
        }),
        ...(el.querySelector('.adapter-avatar,[data-slot="initial-avatar"]') && {
          detailControls: [
            '.adapter-avatar,[data-slot="initial-avatar"]',
            '[role="tablist"]',
            '[role="tab"]',
            "section h3",
          ].map((selector) => {
            const rect = el.querySelector(selector)?.getBoundingClientRect();
            return rect && [rect.x - box.x, rect.y - box.y, rect.width, rect.height];
          }),
        }),
        ...(el.querySelector(
          'section dl.adapter-info,section dl[data-slot="description-list"]',
        ) && {
          overviewRows: [
            ...el.querySelectorAll(
              "section .adapter-capability-grid > div,section .grid.grid-cols-2 > div:not([data-slot]),section dt,section dd,section .adapter-field,section li,section li p",
            ),
          ].map((control) => {
            const rect = control.getBoundingClientRect();
            return [
              control.textContent.trim().slice(0, 8),
              rect.x - box.x,
              rect.y - box.y,
              rect.width,
              rect.height,
            ];
          }),
        }),
        ...(el.querySelector('.adapter-history,[data-slot="timeline"]') && {
          historyRows: [
            '.adapter-history-indicator,[data-slot="timeline-indicator"]',
            '.adapter-history-title,[data-slot="timeline-header"]',
            '.adapter-history-title .adapter-badge,[data-slot="timeline-header"] [data-slot="badge"]',
            '.adapter-history-card,[data-slot="timeline-header"] + div',
            '.adapter-history-card code,[data-slot="timeline-content"] [title][class*="font-mono"]',
            'button[aria-label="复制完整 sha256"]',
            '.adapter-history-note svg,[data-slot="timeline-content"] .lucide-lock',
          ].map((selector) => {
            const rect = el.querySelector(selector)?.getBoundingClientRect();
            return rect && [rect.x - box.x, rect.y - box.y, rect.width, rect.height];
          }),
        }),
        ...(title?.textContent === "加入真人库" && {
          enrollControls: [...el.querySelectorAll("h2,img,input,button")].map((control) => {
            const rect = control.getBoundingClientRect();
            const style = getComputedStyle(control);
            return [
              control.tagName,
              control.textContent.trim(),
              rect.x - box.x,
              rect.y - box.y,
              rect.width,
              rect.height,
              style.backgroundColor,
              style.color,
              style.borderRadius,
            ];
          }),
        }),
        ...(el.querySelector('[aria-label="用 AI 生成插件"]') && {
          uploadControls: [...el.querySelectorAll("button")].map((button) => {
            const style = getComputedStyle(button);
            return [
              button.textContent.trim(),
              button.offsetWidth,
              button.offsetHeight,
              style.borderRadius,
              style.color,
              style.backgroundColor,
              style.fontSize,
              style.paddingInline,
              style.opacity,
            ];
          }),
        }),
        width: box.width,
        height: box.height,
        top: box.top,
        left: box.left,
        radius: css.borderTopLeftRadius,
        ...(el.querySelector("table") && {
          tableEntries: [...el.querySelectorAll("tbody tr")].map(
            (row) => row.firstElementChild?.textContent,
          ),
          cellTypography: [...el.querySelectorAll("tbody tr:nth-child(2) :is(button,code,span)")]
            .filter((child) => child.textContent.trim() && !child.querySelector("span,button,code"))
            .slice(0, 10)
            .map((child) => {
              const style = getComputedStyle(child);
              return [
                child.textContent.trim(),
                child.offsetWidth,
                style.fontFamily,
                style.fontSize,
                style.fontWeight,
              ];
            }),
          tableRows: [...el.querySelectorAll("table tr")]
            .slice(0, el.matches(".channel-table,#audit-model-panel > div:first-child") ? 3 : 2)
            .map((row) =>
              [...row.children].map((cell) => [
                Math.round(cell.getBoundingClientRect().width),
                cell.getBoundingClientRect().height,
              ]),
            ),
        }),
        titleFont: title && getComputedStyle(title).fontSize,
        ...(el.querySelector('input[placeholder="/v1"]') && {
          agentFormat: (() => {
            const rect = el
              .querySelector('[role="combobox"][aria-label="接口格式"],#model-api-format')
              .getBoundingClientRect();
            return [rect.x - box.x, rect.y - box.y, rect.width, rect.height];
          })(),
        }),
        ...(el.querySelector('input[placeholder="用户在画布里看到的名字"]') && {
          basicFields: [...el.querySelectorAll("input,textarea,h3,legend,button")]
            .filter(
              (field) =>
                field.matches("input,textarea,h3,legend") ||
                ["文本", "图片", "视频", "模型身份", "能力与协议", "展示信息"].includes(
                  field.textContent.trim(),
                ),
            )
            .filter((field) => field.getBoundingClientRect().height)
            .map((field) => {
              const rect = field.getBoundingClientRect();
              return [
                field.getAttribute("placeholder") || field.id || field.textContent.trim(),
                rect.x - box.x,
                rect.y - box.y,
                rect.width,
                rect.height,
              ];
            }),
        }),
        ...(el.querySelector('input[aria-label="默认价格"]') && {
          priceFields: [
            ...el.querySelectorAll(
              'h3,[aria-label="计费方式"],[aria-label="适用范围"],button[aria-pressed],input[aria-label="默认价格"],[role="switch"],aside',
            ),
          ]
            .filter((node) => node.getBoundingClientRect().height)
            .map((node) => {
              const rect = node.getBoundingClientRect();
              return [
                node.getAttribute("aria-label") || node.textContent.trim(),
                rect.x - box.x,
                rect.y - box.y,
                rect.width,
                rect.height,
              ];
            }),
        }),
        ...(el.querySelector('input[aria-label="自定义超时"]') && {
          parameterFields: [...el.querySelectorAll("input,button,p,h3,label,span")]
            .filter(
              (field) =>
                field.matches("input") ||
                [
                  "任务设置",
                  "任务超时",
                  "提示词",
                  "生成参数",
                  "暂无生成参数",
                  "未配置 capabilities",
                  "5 分钟",
                ].includes(field.textContent.trim()),
            )
            .filter((field) => field.getBoundingClientRect().height)
            .map((field) => {
              const rect = field.getBoundingClientRect();
              return [
                field.getAttribute("aria-label") || field.id || field.textContent.trim(),
                rect.x - box.x,
                rect.y - box.y,
                rect.width,
                rect.height,
              ];
            }),
        }),
        ...(el.querySelector('textarea[aria-label="配置 JSON"]') && {
          jsonEditor: (() => {
            const bounds = el
              .querySelector('textarea[aria-label="配置 JSON"]')
              .getBoundingClientRect();
            return [bounds.x - box.x, bounds.y - box.y, bounds.width, bounds.height];
          })(),
        }),
        ...(el.querySelector("textarea") &&
          el.querySelector('[role="tablist"]') && {
            controls: [
              ...el.querySelectorAll(
                'textarea,[role="tablist"],[role="tabpanel"] h3,[role="tabpanel"] p,button',
              ),
            ]
              .filter(
                (child) => !child.matches("button") || /开始测试|只看请求/.test(child.textContent),
              )
              .map((child) => {
                const bounds = child.getBoundingClientRect();
                return [
                  child.tagName,
                  child.getAttribute("role"),
                  bounds.x - box.x,
                  bounds.y - box.y,
                  bounds.width,
                  bounds.height,
                  getComputedStyle(child).fontSize,
                ];
              }),
          }),
        rows: [...el.children]
          .filter((child) => child.getBoundingClientRect().height)
          .map((child) => [
            child.tagName,
            Math.round(child.getBoundingClientRect().top - box.top),
            child.getBoundingClientRect().height,
          ]),
        viewport: [innerWidth, innerHeight],
        dpr: devicePixelRatio,
      };
    });
    if (pluginDelete || deleteChannel) {
      await page.evaluate(() => document.fonts.ready);
      await dialog
        .locator('.delete-check-skeleton,[data-slot="skeleton"],.settings-spin,.animate-spin')
        .evaluateAll((nodes) =>
          nodes.forEach((node) =>
            node.getAnimations().forEach((animation) => {
              animation.pause();
              animation.currentTime = 0;
            }),
          ),
        );
      const geometry = await dialog.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return [
          box.width,
          box.height,
          ...[
            el.querySelector("h2"),
            el.querySelector('[data-slot="dialog-description"],.model-dialog-head p'),
            el.querySelector("input"),
            ...[...el.querySelectorAll("button,a")].filter(
              (button) =>
                button.textContent.trim() &&
                !button.matches('[data-slot="dialog-close"]') &&
                button.getBoundingClientRect().height,
            ),
            el.querySelector('[data-slot="dialog-close"],.model-dialog-head > button'),
          ]
            .filter(Boolean)
            .map((child) => {
              const rect = child.getBoundingClientRect();
              return [rect.x - box.x, rect.y - box.y, rect.width, rect.height];
            }),
        ];
      });
      console.log("delete-landmarks", label, JSON.stringify(geometry));
      if (label === "studio") panelBox = { width: metric.width, height: metric.height };
      if (detailGeometry) assert.deepEqual(geometry, detailGeometry);
      detailGeometry = geometry;
    }
    console.log(label, JSON.stringify(metric));
    if (channelEdit && !channelDiscard) {
      const controls = await dialog.evaluate((el) => {
        const origin = el.getBoundingClientRect();
        return [
          ...el.querySelectorAll(
            'input[type=url],input[placeholder="https://api.example.com"],input[placeholder="例如：OpenAI 官方渠道"],input[type=number],button',
          ),
        ]
          .filter(
            (node) =>
              node.tagName === "INPUT" ||
              ["添加 User-Agent", "添加请求头", "取消", "保存"].includes(node.textContent.trim()),
          )
          .map((node) => {
            const rect = node.getBoundingClientRect();
            return [rect.x - origin.x, rect.y - origin.y, rect.width, rect.height];
          });
      });
      assert.equal(controls.length, 9);
      if (channelApproval) {
        const track =
          label === "studio"
            ? dialog.locator(".channel-access-row .settings-switch-track")
            : dialog.getByRole("switch", { name: "启用", exact: true });
        const bounds = await track.boundingBox();
        controls.push([
          metric.width,
          metric.height,
          bounds.x - metric.left,
          bounds.y - metric.top,
          bounds.width,
          bounds.height,
        ]);
        if (label === "studio") {
          const box = await dialog.locator(".channel-approval-field").boundingBox();
          assert.ok(
            box.x > bounds.x + bounds.width &&
              box.x + box.width <= metric.left + metric.width &&
              box.height <= 21 &&
              box.width < 300 &&
              Math.abs(box.y - bounds.y) <= 1,
            "授权文案须完整且不挤占启用开关",
          );
          approvalRegion = {
            x: box.x - metric.left,
            y: box.y - metric.top,
            width: box.width,
            height: box.height,
          };
        }
      }
      if (channelFiling) {
        for (const selector of [
          'input[placeholder="default"]',
          'input[placeholder="Access Key"]',
          'input[placeholder="Secret Key"]',
        ]) {
          const bounds = await dialog.locator(selector).evaluate((node) => {
            const rect = node.getBoundingClientRect(),
              origin = node.closest('dialog,[role="dialog"]').getBoundingClientRect();
            return [rect.x - origin.x, rect.y - origin.y, rect.width, rect.height];
          });
          controls.push(bounds);
        }
        console.log("channel filing controls", label, JSON.stringify(controls));
      }
      if (detailGeometry)
        controls.forEach((bounds, index) =>
          bounds.forEach((value, axis) =>
            assert.ok(
              Math.abs(value - detailGeometry[index][axis]) <= 0.1,
              `channel field ${index}:${axis}: ${value} vs ${detailGeometry[index][axis]}`,
            ),
          ),
        );
      detailGeometry = controls;
    }
    if (keys) {
      const geometry = await dialog.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return [
          ...el.querySelectorAll(
            "h2,input[type=password],[role=checkbox],input[type=checkbox],[role=status],[role=alert],button",
          ),
        ]
          .filter(
            (item) =>
              !["Close", "关闭"].includes(item.textContent.trim()) &&
              !item.matches('[aria-label="关闭弹窗"],input[aria-hidden=true]'),
          )
          .map((item) => {
            const rect = item.getBoundingClientRect();
            return [
              item.getAttribute("placeholder") || item.textContent.trim(),
              rect.x - box.x,
              rect.y - box.y,
              rect.width,
              rect.height,
            ];
          });
      });
      console.log("keys", label, JSON.stringify(geometry));
      if (detailGeometry)
        assert.deepEqual(geometry, detailGeometry, "key dialog control positions and sizes");
      detailGeometry = geometry;
    }
    if (humanRemove) {
      assert.equal(await dialog.getByRole("button", { name: "确认移除" }).isDisabled(), removeUsed);
      assert.equal(await dialog.getByRole("listitem").count(), removeUsed ? 2 : 0);
      const geometry = await dialog.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return [
          box.width,
          box.height,
          ...Array.from(el.querySelectorAll("li,button"), (item) => {
            const rect = item.getBoundingClientRect();
            return [
              item.textContent.trim(),
              rect.x - box.x,
              rect.y - box.y,
              rect.width,
              rect.height,
            ];
          }),
        ];
      });
      console.log("human-remove", label, JSON.stringify(geometry));
      if (detailGeometry) assert.deepEqual(geometry, detailGeometry, "removal bounds and buttons");
      detailGeometry = geometry;
    } else if (filingPicker) {
      const geometry = await dialog
        .getByRole("button", { name: pickerHistory ? "时间" : "上传", exact: true })
        .evaluate((el) => {
          const box = el.closest('dialog,[role="dialog"]').getBoundingClientRect(),
            button = el.getBoundingClientRect(),
            icon = el.querySelector("svg").getBoundingClientRect();
          return [
            box.width,
            box.height,
            button.x - box.x,
            button.y - box.y,
            button.width,
            button.height,
            icon.width,
            icon.height,
          ];
        });
      console.log("filing-picker", label, JSON.stringify(geometry));
      if (pickerMixed)
        for (const el of [
          dialog
            .locator("[data-disabled]")
            .filter({
              has: dialog.page().getByRole("button", { name: "已备案.png", exact: true }),
            }),
          dialog.getByText("已在真人库", { exact: true }),
        ]) {
          const box = await el.boundingBox(),
            outer = await dialog.boundingBox();
          geometry.push(box.x - outer.x, box.y - outer.y, box.width, box.height);
        }
      if (pickerMore) {
        const bounds = await dialog.locator(moreFooter).boundingBox(),
          button = await dialog.getByRole("button", { name: "重试" }).boundingBox();
        geometry.push(
          bounds.width,
          bounds.height,
          button.x - bounds.x,
          button.y - bounds.y,
          button.width,
          button.height,
        );
        console.log("filing-more", label, JSON.stringify(geometry.slice(8)));
      }
      if (filingPicker === "folders")
        assert.ok(
          await dialog
            .getByRole("button", { name: "打开文件夹 角色图" })
            .getByText("0 项 · 2025年8月21日")
            .isVisible(),
        );
      if (pickerUpload) {
        const card = dialog.locator('.asset-upload-card,[data-slot="upload-card"]').first();
        geometry.push(
          ...(await card.evaluate((el) => {
            const box = el.getBoundingClientRect(),
              dialog = el.closest('dialog,[role="dialog"]').getBoundingClientRect();
            return [box.x - dialog.x, box.y - dialog.y, box.width, box.height];
          })),
        );
      }
      if (detailGeometry)
        geometry.forEach((value, index) =>
          assert.ok(
            Math.abs(value - detailGeometry[index]) <= 0.1,
            `filing picker geometry ${index}: ${value} vs ${detailGeometry[index]}`,
          ),
        );
      detailGeometry = geometry;
    } else if (humanDetail) {
      const controls = await dialog.evaluate((el) => {
        const origin = el.getBoundingClientRect();
        return [...el.querySelectorAll("input,li,button")]
          .filter(
            (item) =>
              item.localName !== "button" ||
              ["移除", "重新提交", "设为封面", "添加图片", "移除真人", "完成"].includes(
                item.textContent.trim(),
              ),
          )
          .map((item) => {
            const bounds = item.getBoundingClientRect();
            return [
              item.localName === "button" ? item.textContent.trim() : item.localName,
              bounds.x - origin.x,
              bounds.y - origin.y,
              bounds.width,
              bounds.height,
            ];
          });
      });
      assert.deepEqual(
        controls.map(([key]) => key),
        [
          "input",
          "li",
          "移除",
          "li",
          "重新提交",
          "设为封面",
          "移除",
          "li",
          "添加图片",
          "移除真人",
          "完成",
        ],
      );
      if (detailGeometry)
        controls.forEach(([key, ...bounds], index) =>
          bounds.forEach((value, axis) =>
            assert.ok(
              Math.abs(value - detailGeometry[index][axis + 1]) <= 0.1,
              `human detail ${key} ${index}:${axis}`,
            ),
          ),
        );
      detailGeometry = controls;
      console.log("human-detail", label, JSON.stringify(controls));
    }
    if (uploadDown || uploadLimit) {
      const bounds = await dialog.boundingBox(),
        alert = await dialog.getByRole("alert").boundingBox();
      const geometry = [
        bounds.width,
        bounds.height,
        alert.x - bounds.x,
        alert.y - bounds.y,
        alert.width,
        alert.height,
      ];
      assert.deepEqual(geometry, [576, 381.5, 24, 254.5, 528, 38]);
      if (selectGeometry) assert.deepEqual(geometry, selectGeometry);
      selectGeometry = geometry;
    }
    if (uploadSuccess) {
      const controls = metric.uploadResultControls;
      assert.equal(controls.length, uploadAdjusted ? 12 : 9);
      if (detailGeometry)
        controls.forEach((bounds, index) =>
          bounds.forEach((value, axis) =>
            assert.ok(
              Math.abs(value - detailGeometry[index][axis]) <= 0.1,
              `upload result control ${index}:${axis}`,
            ),
          ),
        );
      detailGeometry = controls;
    }
    if (modelTab && label === "studio") panelBox = { width: metric.width, height: metric.height };
    if (channelOverview) {
      assert.deepEqual(
        await dialog
          .getByRole("button")
          .allTextContents()
          .then((labels) => labels.map((text) => text.trim())),
        ["编辑渠道", "设置 Key", "停用", "删除"],
      );
      await dialog.getByText("生成中 0/不限 · 排队 0", { exact: true }).waitFor();
      const geometry = [metric.height, ...metric.rows.flatMap((row) => row.slice(1))];
      if (detailGeometry) assert.deepEqual(geometry, detailGeometry, "channel header rows");
      detailGeometry = geometry;
    }
    if (modelList) {
      const sections = metric.rows.filter((row) => row[2] > 48).map((row) => row.slice(1));
      assert.equal(sections.length, 3);
      if (catalogGeometry) {
        assert.deepEqual(
          sections,
          catalogGeometry.sections,
          "model list toolbar, scroll body and pager",
        );
        metric.tableRows.forEach((row, index) =>
          row.forEach(([width, height], column) => {
            const [expectedWidth, expectedHeight] = catalogGeometry.cells[index][column];
            assert.ok(
              Math.abs(width - expectedWidth) <= 1 && height === expectedHeight,
              `model list cell ${index}:${column} dimensions`,
            );
          }),
        );
      }
      catalogGeometry = { sections, cells: metric.tableRows };
    }
    if (batchProtocol) {
      assert.equal(metric.kindButtons.length, 5);
      if (detailGeometry)
        assert.deepEqual(
          metric.kindButtons,
          detailGeometry,
          "five batch kind controls must match positions and sizes",
        );
      detailGeometry = metric.kindButtons;
    }
    if (batchToolbar || batchResult) {
      const geometry = [
        metric.width,
        metric.height,
        metric.top,
        metric.left,
        ...(batchToolbar
          ? metric.buttons.flat()
          : metric.notices.flatMap((notice) => notice.slice(1))),
      ];
      if (batchResult)
        for (const name of ["知道了", "关闭"]) {
          const box = await dialog.getByRole("button", { name, exact: true }).boundingBox();
          geometry.push(box.x - metric.left, box.y - metric.top, box.width, box.height);
        }
      if (detailGeometry) {
        assert.equal(geometry.length, detailGeometry.length);
        assert.deepEqual(geometry, detailGeometry, "batch component and control bounds must match");
      }
      detailGeometry = geometry;
    }
    if (smallConfirm) {
      if (deleteVersionState === "pending")
        await dialog.locator("button svg").evaluateAll((nodes) =>
          nodes.forEach((node) =>
            node.getAnimations().forEach((animation) => {
              animation.pause();
              animation.currentTime = 0;
            }),
          ),
        );
      if (channelDiscard)
        assert.deepEqual(await dialog.getByRole("button").allTextContents(), ["取消", "放弃修改"]);
      const rectangle = [metric.width, metric.height, ...metric.rows.map((row) => row.slice(1))];
      if (detailGeometry)
        assert.deepEqual(
          rectangle,
          detailGeometry,
          "delete confirmation header and footer must match",
        );
      detailGeometry = rectangle;
    }
    if (toggleState) {
      const geometry = await dialog.evaluate((el) =>
        [
          el,
          ...el.querySelectorAll(
            'h2,[data-slot="alert-dialog-description"],.model-dialog-head p,b,[role="alert"],footer button,[data-slot="alert-dialog-footer"] button,button svg',
          ),
        ].map((control) => {
          const rect = control.getBoundingClientRect();
          return [rect.x, rect.y, rect.width, rect.height];
        }),
      );
      assert.ok(geometry.length >= 6);
      assert.ok(
        (await dialog.textContent()).includes(
          "2 个模型（其中 1 个在线） 在用此插件，停用后不可用，进行中的任务不受影响。",
        ),
      );
      if (detailGeometry)
        assert.deepEqual(
          geometry,
          detailGeometry[2],
          "disable dialog, labels, notice and button bounds must match",
        );
      detailGeometry = [metric.width, metric.height, geometry];
    } else if (upgrade) {
      assert.ok(metric.upgradeControls?.length >= 7);
      const geometry = [metric.width, metric.height, metric.upgradeControls];
      if (detailGeometry)
        assert.deepEqual(geometry, detailGeometry, "upgrade dialog and control bounds must match");
      detailGeometry = geometry;
    }
    if (["overview", "history"].includes(captureName)) {
      assert.ok(metric.detailControls?.[0]);
      const pins = historyPins
        ? await dialog.getByRole("link").evaluateAll((nodes) =>
            nodes.map((node) => {
              const rect = node.getBoundingClientRect(),
                outer = node.closest('dialog,[role="dialog"]').getBoundingClientRect();
              return [rect.x - outer.x, rect.y - outer.y, rect.width, rect.height];
            }),
          )
        : undefined;
      const geometry = [metric.detailControls, metric.overviewRows, metric.historyRows, pins];
      if (history)
        assert.equal(
          metric.historyRows?.filter(Boolean).length,
          7,
          "expected all history row landmarks",
        );
      if (captureName === "overview") {
        const settingRows = Object.values(meta.channelSettings).reduce(
          (count, field) =>
            count +
            1 +
            Number(!!field.description) +
            Number(!!field.options?.length || (field.default != null && field.default !== "")),
          0,
        );
        assert.equal(
          metric.overviewRows?.length,
          18 + settingRows,
          "expected four capability cards, seven term/value pairs and all declared settings",
        );
      }
      if (detailGeometry)
        assert.deepEqual(
          geometry,
          detailGeometry,
          "detail header, section and field geometry must match",
        );
      detailGeometry = geometry;
    }
    if (enroll) {
      const controls = metric.enrollControls
        .filter(
          ([tag, text]) =>
            tag === "INPUT" ||
            tag === "IMG" ||
            [
              "取消",
              "加入并提交备案",
              "新建真人",
              "加到已有真人",
              "角色甲5/5",
              "角色乙1/5",
            ].includes(text),
        )
        .map((row) => row.slice(0, 6));
      const geometry = [metric.width, metric.height, controls];
      if (enrollGeometry)
        assert.deepEqual(
          geometry,
          enrollGeometry,
          "enrollment controls must match positions and sizes",
        );
      enrollGeometry = geometry;
    }
    if (modelTab === "json") {
      if (modelChrome)
        assert.deepEqual(metric.jsonEditor, modelChrome, "JSON editor bounds must match");
      modelChrome = metric.jsonEditor;
    } else if (modelTab) {
      const selectors = [
        '.model-dialog-identity .model-avatar,[data-slot="initial-avatar"],[data-slot="vendor-avatar"]',
        '[role="tablist"]',
        ...[1, 2, 3].map((index) => `[role="tablist"] > :nth-child(${index})`),
        '[aria-label="模型上线"]',
      ];
      const geometry = await dialog.evaluate(
        (el, selectors) =>
          selectors.map((selector) => {
            const rect = el.querySelector(selector).getBoundingClientRect(),
              outer = el.getBoundingClientRect();
            return [rect.x - outer.x, rect.y - outer.y, rect.width, rect.height];
          }),
        selectors,
      );
      console.log(label, "editor-chrome", JSON.stringify(geometry));
      if (modelChrome)
        geometry.forEach((rect, index) =>
          rect.forEach((value, coordinate) =>
            assert.ok(
              Math.abs(value - modelChrome[index][coordinate]) < 0.1,
              `${selectors[index]}: ${rect} vs ${modelChrome[index]}`,
            ),
          ),
        );
      modelChrome = geometry;
    }
    if (modelTab === "price" && !priceState) {
      const names = [
        "计费方式",
        "按次",
        "按秒",
        "Token",
        "适用范围",
        "统一价格",
        "按规格定价",
        "默认价格",
        "默认价格积分成本",
      ];
      const controls = names.map((name) => metric.priceFields.find(([label]) => label === name));
      assert.ok(controls.every(Boolean));
      if (basicControls)
        controls.forEach((row, index) =>
          row
            .slice(1)
            .forEach((value, coordinate) =>
              assert.ok(
                Math.abs(value - basicControls[index][coordinate + 1]) < 0.1,
                `price ${row[0]} coordinate ${coordinate}`,
              ),
            ),
        );
      basicControls = controls;
      for (const name of ["按秒", "Token", "按规格定价"])
        assert.ok(await dialog.getByRole("button", { name, exact: true }).isDisabled());
    }
    if (modelTab === "basic" || modelTab === "agent") {
      const names = [
        "用户在画布里看到的名字",
        "实际发给上游的模型名",
        "文本",
        "图片",
        "视频",
        "说明适用场景和注意事项",
      ];
      if (modelTab === "agent") names.push("/v1");
      const controls = names.map((name) => metric.basicFields.find(([text]) => text === name));
      assert.ok(controls.every(Boolean), `${label} basic controls must be present`);
      if (modelTab === "agent") {
        assert.ok(metric.notices?.length && metric.agentFormat);
        controls.push(metric.notices[0], metric.agentFormat);
      }
      if (basicControls)
        assert.deepEqual(controls, basicControls, "basic control positions and sizes must match");
      basicControls = controls;
    }
    if (catalogPanel) {
      assert.equal(
        metric.tableEntries.length,
        catalogEmpty || catalogState === "error" ? 1 : 3,
        `${label} catalog fixture size`,
      );
      const entries = metric.tableEntries.map((entry) => entry.replace(/\s/g, ""));
      if (catalogEntries) assert.deepEqual(entries, catalogEntries, "catalog fixtures must match");
      catalogEntries = entries;
      const geometry = metric.rows.map((row) => row.slice(1));
      if (catalogGeometry) {
        assert.deepEqual(
          geometry,
          catalogGeometry.sections,
          "toolbar, body and pagination bounds must match",
        );
        metric.tableRows.forEach((row, index) =>
          row.forEach(([width, height], column) => {
            const expected = catalogGeometry.cells[index][column];
            assert.ok(
              Math.abs(width - expected[0]) <= 1 && height === expected[1],
              "catalog cells must match within 1 CSS pixel",
            );
          }),
        );
      }
      catalogGeometry = { sections: geometry, cells: metric.tableRows };
    }
    if (catalogSelect) {
      const trigger = page.getByRole("combobox", { name: catalogSelectLabels[catalogSelect] });
      await trigger.click();
      const list = page.getByRole("listbox");
      await list.waitFor();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(150);
      const anchor = await trigger.boundingBox(),
        popup = await list.boundingBox();
      const gap =
        catalogSelect === "size"
          ? anchor.y - popup.y - popup.height
          : popup.y - anchor.y - anchor.height;
      const dimensions = [
        anchor.width,
        anchor.height,
        popup.width,
        popup.height,
        Math.round(gap),
        await list.getByRole("option", { selected: true }).innerText(),
      ];
      console.log("select", label, JSON.stringify(dimensions));
      if (selectGeometry)
        assert.deepEqual(
          dimensions,
          selectGeometry,
          "trigger, popup, offset and selected item must match",
        );
      selectGeometry = dimensions;
    }
    if (catalogMenu) {
      const trigger = dialog.getByRole("button", { name: "OpenAI 的更多操作", exact: true });
      await trigger.press("ArrowDown");
      const menu = page.getByRole("menu");
      const item = menu.getByRole("menuitem", { name: "删除插件", exact: true });
      await item.waitFor();
      await page.waitForTimeout(160);
      const anchor = await trigger.boundingBox(),
        popup = await menu.boundingBox(),
        action = await item.boundingBox();
      const dimensions = [
        anchor.width,
        anchor.height,
        popup.width,
        popup.height,
        popup.y - anchor.y - anchor.height,
        popup.x + popup.width - anchor.x - anchor.width,
        action.x - popup.x,
        action.y - popup.y,
        action.width,
        action.height,
      ];
      console.log("menu", label, JSON.stringify(dimensions));
      if (selectGeometry)
        assert.deepEqual(
          dimensions,
          selectGeometry,
          "menu anchor, popup and action bounds must match",
        );
      selectGeometry = dimensions;
    }
    if (batchChannel) {
      const bounds = await dialog.boundingBox(),
        anchor = await page.getByRole("combobox", { name: "所属渠道" }).boundingBox();
      const geometry = [
        bounds.width,
        bounds.height,
        anchor.x - bounds.x,
        anchor.y - bounds.y,
        anchor.width,
        anchor.height,
      ];
      if (batchChannel !== "selected") {
        const list = page.getByRole("listbox"),
          popup = await list.boundingBox();
        geometry.push(
          popup.x - anchor.x,
          popup.y - anchor.y - anchor.height,
          popup.width,
          popup.height,
          await list.getByRole("option", { selected: true }).innerText(),
        );
        assert.ok(
          batchChannel === "long"
            ? popup.y + popup.height > bounds.y + bounds.height
            : popup.y + popup.height <= bounds.y + bounds.height,
        );
        assert.equal(
          await list
            .getByRole("option")
            .last()
            .evaluate((el) => {
              const r = el.getBoundingClientRect();
              return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
            }),
          true,
          "last option must be hit-testable",
        );
      }
      console.log("batch-channel", label, JSON.stringify(geometry));
      if (selectGeometry)
        assert.deepEqual(geometry, selectGeometry, "batch dialog, trigger and popup bounds");
      selectGeometry = geometry;
    }
    const historyPopup = page.locator(
      label === "studio" ? ".asset-pick-menu" : '[data-slot="popover-content"]',
    );
    if (pickerMenu) {
      await dialog.getByRole("button", { name: "时间", exact: true }).click();
      await historyPopup.waitFor();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(180);
      const options = historyPopup.locator('button,[role="menuitemradio"]'),
        popup = await historyPopup.boundingBox();
      const geometry = [
        popup.x,
        popup.y,
        popup.width,
        popup.height,
        ...(await options.evaluateAll((nodes) =>
          nodes.flatMap((el) => {
            const rect = el.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height];
          }),
        )),
      ];
      console.log("time-menu", label, JSON.stringify(geometry));
      if (selectGeometry) assert.deepEqual(geometry, selectGeometry);
      selectGeometry = geometry;
    }
    const menuRect = pickerMenu
      ? await historyPopup.boundingBox()
      : trialMenu && (await page.getByRole("menu").boundingBox());
    if (logoMenu) {
      await page.bringToFront();
      const trigger = page.locator(label === "studio" ? ".model-logo-trigger" : "#model-vendor");
      const panel = page.locator(
        label === "studio" ? ".model-logo-popover" : '[data-slot="popover-content"]',
      );
      const search = panel.getByLabel("搜索厂商");
      await trigger.evaluate(
        (el) => (el.closest(".model-editor-form, .overflow-y-auto").scrollTop = 96),
      );
      await trigger.press("Enter");
      await search.waitFor();
      assert.ok(await search.evaluate((el) => el === document.activeElement));
      assert.equal(await panel.locator("button[title]").count(), 40);
      if (logoMenu === "selected") {
        await search.fill("通义");
        await panel.locator('button[title="通义千问"]').press("Enter");
        await panel.waitFor({ state: "hidden" });
        assert.match(await trigger.innerText(), /通义千问/);
        await trigger.press("Enter");
        await search.waitFor();
        assert.equal(await search.inputValue(), "通义");
        assert.equal(await panel.locator("button").count(), 1);
        assert.equal(await panel.locator("button").getAttribute("title"), "通义千问");
      }
      if (logoMenu === "empty") {
        await search.fill("不存在的厂商");
        await panel.getByText("没有匹配的厂商").waitFor();
      }
      await page.mouse.move(0, 0);
      await panel.evaluate(async (el) => {
        await new Promise(requestAnimationFrame);
        await Promise.all(
          el
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished.catch(() => {})),
        );
      });
      const rect = await panel.boundingBox(),
        anchor = await trigger.boundingBox(),
        box = await search.boundingBox();
      const geometry = [
        rect.x - anchor.x,
        rect.y - anchor.y - anchor.height,
        rect.width,
        rect.height,
        box.x - rect.x,
        box.y - rect.y,
        box.width,
        box.height,
      ];
      console.log(label, "logo-menu", geometry.join(","));
      assert.ok(
        rect.y >= 0 && rect.y + rect.height <= (await page.evaluate(() => innerHeight)),
        "截图应包含完整的厂商菜单",
      );
      const menuItems = await panel.evaluate((el) =>
        [...el.querySelectorAll("button[title]")]
          .slice(0, 5)
          .flatMap((button) => [button, button.firstElementChild, button.lastElementChild])
          .map((item) => {
            const bounds = item.getBoundingClientRect(),
              origin = el.getBoundingClientRect();
            return [bounds.x - origin.x, bounds.y - origin.y, bounds.width, bounds.height];
          }),
      );
      if (logoItems) assert.deepEqual(menuItems, logoItems, "厂商按钮、图标和名称的矩形应一致");
      logoItems = menuItems;
      if (selectGeometry)
        assert.deepEqual(geometry, selectGeometry, "厂商菜单相对于按钮的位置、尺寸和搜索框应一致");
      selectGeometry = geometry;
      await panel.screenshot({
        path: join(work, `${captureName}-${label}.png`),
        scale: "css",
        animations: "disabled",
      });
      await search.press("Escape");
      await panel.waitFor({ state: "hidden" });
      assert.ok(await trigger.evaluate((el) => el === document.activeElement));
      await trigger.press("Enter");
      await search.waitFor();
      assert.equal(await search.inputValue(), "");
      await search.press("Escape");
      await panel.waitFor({ state: "hidden" });
    }
    if (contextHint) {
      const section = dialog
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: "上下文能力", exact: true }) });
      const apply = section.getByRole("button", { name: "应用识别值" });
      await apply.waitFor({ timeout: 6000 }).catch(async (error) => {
        throw new Error(`${label}: ${await section.innerText()}`, { cause: error });
      });
      assert.equal(await section.getByLabel("最大输出", { exact: true }).inputValue(), "8192");
      await section.evaluate((el) => el.scrollIntoView({ block: "center" }));
      const bounds = await section.boundingBox();
      const metrics = await section.evaluate((el) =>
        [...el.querySelectorAll("input,button")].map((node) => {
          const rect = node.getBoundingClientRect(),
            box = el.getBoundingClientRect();
          return [rect.x - box.x, rect.y - box.y, rect.width, rect.height];
        }),
      );
      console.log(label, "context-controls", JSON.stringify(metrics), bounds.height);
      if (contextGeometry)
        metrics.forEach((rect, index) =>
          rect.forEach((value, axis) =>
            assert.ok(
              Math.abs(value - contextGeometry[index][axis]) < 0.1,
              `${label} ${index}: ${rect} vs ${contextGeometry[index]}`,
            ),
          ),
        );
      contextGeometry = metrics;
      panelBox = { width: 550, height: Math.ceil(bounds.height) };
      await page.screenshot({
        clip: { x: Math.round(bounds.x), y: Math.round(bounds.y), ...panelBox },
        path: join(work, `${captureName}-${label}.png`),
        scale: "css",
      });
      await apply.press("Enter");
      assert.equal(
        await section.getByLabel("最大输出", { exact: true }).inputValue(),
        contextAgent ? "65536" : "16384",
      );
      await apply.waitFor({ state: "hidden" });
    }
    if (!upgradeNotice && !logoMenu && !contextHint)
      await (trialMenu || pickerMenu
        ? page
        : pickerMore
          ? dialog.locator(moreFooter)
          : batchChannel === "long"
            ? page.getByRole("listbox")
            : dialog
      ).screenshot({
        ...(menuRect && {
          clip: {
            ...menuRect,
            x: Math.round(menuRect.x),
            y: Math.round(menuRect.y),
            height: Math.round(menuRect.height),
          },
        }),
        path: join(work, `${captureName}-${label}.png`),
        scale: "css",
      });
    if (jsonInvalidReturn) {
      const repaired = jsonNonObject
        ? { ...JSON.parse(validJson), label: "原稿名称", vendor_extension: { retain: true } }
        : undefined;
      await dialog
        .getByRole("textbox", { name: "配置 JSON" })
        .fill(repaired ? JSON.stringify(repaired) : validJson);
      await dialog.getByText("JSON 语法正确", { exact: true }).waitFor();
      await dialog.getByRole("button", { name: "回到表单" }).press("Enter");
      await dialog
        .getByRole("tab", { name: "基本信息" })
        .waitFor({ timeout: 5000 })
        .catch(async (error) => {
          throw new Error(`${label}: ${await dialog.innerText()}`, { cause: error });
        });
      assert.equal(await dialog.getByRole("alert").filter({ hasText: "无法切回表单" }).count(), 0);
      if (repaired) {
        await dialog.getByRole("tab", { name: "基本信息" }).click();
        const name = dialog.getByRole("textbox", { name: "展示名称" });
        assert.equal(await name.inputValue(), repaired.label);
        await name.fill("表单修改");
        await dialog.getByRole("tab", { name: "能力与参数" }).click();
        await dialog.getByRole("tab", { name: "基本信息" }).click();
        assert.equal(await name.inputValue(), "表单修改");
        if (label === "studio") {
          await dialog.getByRole("button", { name: "配置 JSON" }).press("Enter");
          assert.deepEqual(
            JSON.parse(await dialog.getByRole("textbox", { name: "配置 JSON" }).inputValue()),
            { ...repaired, label: "表单修改" },
          );
        }
      }
    }
    if (modelTab === "json" && !jsonInvalidReturn && !jsonExtension) {
      const input = dialog.getByRole("textbox", { name: "配置 JSON" });
      const raw = (await input.inputValue()) + "  ";
      await input.fill(raw);
      await dialog.getByText("有未保存修改", { exact: true }).waitFor();
      await dialog.getByRole("button", { name: "格式化" }).press("Enter");
      assert.equal(await input.inputValue(), JSON.stringify(JSON.parse(raw), null, 2));
      await dialog
        .getByText("有未保存修改", { exact: true })
        .waitFor({ state: "hidden", timeout: 3000 });
      await input.fill(raw);
      await dialog.getByRole("button", { name: "回到表单" }).press("Enter");
      await dialog.getByText("有未保存修改", { exact: true }).waitFor();
      if (label === "studio") {
        await dialog.getByRole("button", { name: "配置 JSON" }).press("Enter");
        assert.equal(await input.inputValue(), raw);
      }
    }
    if (uploadDuplicate) {
      await dialog
        .getByLabel("选择插件文件")
        .setInputFiles({
          name: "duplicate.js",
          mimeType: "text/javascript",
          buffer: Buffer.from(source),
        });
      assert.equal(await dialog.getByText("预检未通过：1 个问题").count(), 0);
      assert.ok(await dialog.getByRole("button", { name: "上传", exact: true }).isEnabled());
    }
    if (modelTab === "basic" || modelTab === "agent") {
      const help = "插件把这个值作为 model 参数发给上游网关。";
      await page.bringToFront();
      const trigger = dialog.locator(`[aria-label="${help}"]`);
      await trigger.hover();
      await page
        .getByText(help, { exact: true })
        .waitFor({ timeout: 5000 })
        .catch(async (error) => {
          throw new Error(`${label} hover: ${await trigger.evaluate((el) => el.outerHTML)}`, {
            cause: error,
          });
        });
      await page.mouse.move(0, 0);
      await page.getByText(help, { exact: true }).waitFor({ state: "hidden" });
    }
    if (modelTab === "basic" && !logoMenu) {
      const sort = dialog.getByRole("spinbutton", { name: "排序", exact: true });
      await sort.fill("");
      assert.equal(await sort.inputValue(), "0");
      const input = dialog.getByRole("textbox", { name: "展示标签" });
      for (const text of ["推理", "推理", "图片", "音频", "视频", "长文"]) {
        await input.fill(text);
        await input.press(",");
      }
      assert.ok(await input.isDisabled());
      assert.equal(await input.getAttribute("placeholder"), "最多 5 个标签");
      const remove = dialog.getByRole("button", { name: "删除标签 长文" });
      const chip = remove.locator("..");
      await chip.click({ position: { x: 8, y: 10 } });
      assert.ok(await remove.isVisible());
      const geometry = await remove.evaluate((el) =>
        [el.parentElement, el, el.firstElementChild].map((item) => {
          const box = item.getBoundingClientRect();
          return [box.width, box.height];
        }),
      );
      console.log(label, "tag-chip", JSON.stringify(geometry));
      if (tagGeometry) assert.deepEqual(geometry, tagGeometry, "标签、移除按钮和叉号应同尺寸");
      tagGeometry = geometry;
      await remove.press("Enter");
      assert.ok(await input.isEnabled());
      await input.press("Backspace");
      assert.equal(await dialog.getByRole("button", { name: /^删除标签 / }).count(), 3);
    }
    if (priceState === "second") {
      const table = dialog.getByRole("table");
      await dialog.getByRole("spinbutton", { name: "第 1 条规格价格", exact: true }).fill("5");
      assert.deepEqual(
        await table
          .locator("tbody tr")
          .evaluateAll((rows) =>
            rows.map((row) => [...row.cells].map((cell) => cell.textContent.trim())),
          ),
        [
          ["标准", "5", "10", "30", "50"],
          ["高", "5", "10", "30", "50"],
        ],
      );
      await dialog.getByRole("button", { name: "移除条件" }).click();
      assert.equal(await dialog.getByText("aspect_ratio", { exact: true }).count(), 0);
      assert.equal(await dialog.getByText(/条件里的「aspect_ratio」已不能作为规格维度/).count(), 0);
      assert.equal(
        await dialog.getByRole("spinbutton", { name: "第 1 条规格价格", exact: true }).inputValue(),
        "5",
      );
    }
    if (priceState === "tiers") {
      const toggle = dialog.getByRole("switch", { name: "第 2 条规格价格可供用户使用" });
      const high = dialog.getByRole("table").getByRole("row").filter({ hasText: "高" });
      const caption = dialog.getByText("可供用户使用", { exact: true }).nth(1);
      for (const activate of [
        () => caption.click({ position: { x: 4, y: 8 } }),
        () => toggle.press("Space"),
      ]) {
        for (const [checked, expected] of [
          [false, ["4", "4"]],
          [true, ["9", "4"]],
        ]) {
          await activate();
          assert.equal(await toggle.getAttribute("aria-checked"), String(checked));
          assert.deepEqual(
            await high.evaluate((row) => [...row.cells].map((cell) => cell.textContent.trim())),
            ["高", ...expected],
          );
        }
      }
      const cost = dialog.getByRole("switch", { name: "第 2 条规格价格积分成本" });
      const amount = dialog.getByRole("spinbutton", { name: "第 2 条规格价格积分成本" });
      await cost.click();
      await amount.fill("3");
      await dialog.getByText("利润率 67%", { exact: true }).waitFor();
      await cost.press("Space");
      assert.equal(await amount.count(), 0);
      assert.equal(await dialog.getByText("利润率 67%", { exact: true }).count(), 0);
    }
    if (priceState === "stale") {
      await dialog.getByRole("button", { name: "移除条件" }).click();
      assert.equal(await dialog.getByText("退役档", { exact: true }).count(), 0);
      assert.equal(await dialog.getByText(/条件里的「legacy」已不能作为规格维度/).count(), 0);
      assert.equal(
        await dialog.getByRole("spinbutton", { name: "第 1 条规格价格", exact: true }).inputValue(),
        "4",
      );
      assert.equal(
        await dialog.getByRole("spinbutton", { name: "第 2 条规格价格", exact: true }).inputValue(),
        "9",
      );
      assert.deepEqual(
        await dialog
          .getByRole("table")
          .locator("tbody tr")
          .evaluateAll((rows) =>
            rows.map((row) => [...row.cells].map((cell) => cell.textContent.trim())),
          ),
        [
          ["标准", "4", "4"],
          ["高", "9", "4"],
        ],
      );
    }
    if (modelTab === "params" && !contextHint) {
      const short = dialog.getByRole("button", { name: "5 分钟", exact: true }),
        long = dialog.getByRole("button", { name: "60 分钟", exact: true });
      await short.press("Space");
      await long.press("Enter");
      assert.equal(await long.getAttribute("aria-pressed"), "true");
      assert.equal(await short.getAttribute("aria-pressed"), "false");
      assert.equal(await long.locator("svg").count(), 1);
      assert.equal(await short.locator("svg").count(), 0);
      await dialog.getByRole("textbox", { name: "自定义超时" }).fill("90s");
      assert.equal(await long.getAttribute("aria-pressed"), "false");
    }
    if (batchProtocolEmpty) {
      const search = dialog.getByRole("searchbox");
      await search.fill("openai");
      await dialog
        .getByRole("radio", { name: /^OpenAI / })
        .first()
        .press("Enter");
      assert.ok(await dialog.getByRole("button", { name: "应用到 1 个模型" }).isEnabled());
    }
    if (uploadPrompt) {
      const preview = dialog.locator("details[open] pre");
      await preview.hover();
      await page.mouse.wheel(0, 8000);
      await page.waitForFunction(() => {
        const pane = document.querySelector("details[open] pre");
        return pane && pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 1;
      });
      await dialog.locator("summary").press("Enter");
      await preview.waitFor({ state: "hidden" });
      assert.equal(await dialog.locator("details[open]").count(), 0);
    }
    if (pickerMenu) {
      await historyPopup.getByText("今天", { exact: true }).click();
      await historyPopup.waitFor({ state: "hidden" });
      await dialog.getByRole("button", { name: "清除筛选" }).click();
      await dialog.getByText("暂无相关资产", { exact: true }).waitFor();
    }
    if (pickerMore) {
      await dialog.getByRole("button", { name: "重试" }).click();
      await dialog.getByRole("button", { name: "角色图.png", exact: true }).waitFor();
      assert.equal(await dialog.locator(moreFooter).count(), 0);
    }
    if (pickerMixed) {
      await dialog.getByRole("button", { name: "取消选择 角色图.png" }).press("Enter");
      assert.ok(await dialog.getByRole("button", { name: "添加并提交备案" }).isDisabled());
    }
    if (pickerSearchError) {
      await dialog.getByRole("button", { name: "重试" }).click();
      await dialog.getByRole("button", { name: "角色图.png", exact: true }).waitFor();
      await dialog.getByRole("button", { name: "取消选择 角色图.png" }).press("Enter");
      assert.ok(await dialog.getByRole("button", { name: "添加并提交备案" }).isDisabled());
    }
    if (batchResult) {
      await page.keyboard.press(compact ? "Escape" : "Enter");
      await dialog.waitFor({ state: "hidden" });
    }
    if (batchProgress && label === "studio") {
      await app.evaluate(({ ipcMain }) => ipcMain.emit("release-batch-progress"));
      const result = page.getByRole("dialog", { name: `${progressLabels[progressKind]}完成` });
      await result.getByText("成功 0 项，跳过 0 项，失败 2 项。").waitFor();
      assert.equal(await result.getByText(/配置已更新，请重新载入后再保存。/).count(), 2);
    }
    if (keysSaving) {
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      if (label === "studio") {
        await page.getByRole("button", { name: "编辑渠道", exact: true }).click();
        const edit = page.getByRole("dialog", { name: "编辑渠道", exact: true });
        await edit.waitFor();
        const channels = await page.evaluate(() => window.desktop.settings.channelList({}));
        assert.ok(channels.ok);
        await app.evaluate(({ ipcMain }, channels) => {
          ipcMain.removeHandler("link-studio:settings:channelList");
          ipcMain.handle("link-studio:settings:channelList", () => ({
            ok: true,
            value: channels.map((channel) => ({ ...channel, name: "已刷新渠道" })),
          }));
          ipcMain.emit("release-keys");
        }, channels.value);
        await page
          .getByRole("complementary", { name: "模型渠道列表", includeHidden: true })
          .getByText("已刷新渠道", { exact: true })
          .waitFor({ state: "attached" });
        assert.ok(await edit.isVisible());
      }
    }
    if (channelSaving && label === "studio") {
      await app.evaluate(({ ipcMain }) => ipcMain.emit("release-channel-save"));
      await dialog.getByRole("alert").getByText("配置已更新，请重新载入后再保存。").waitFor();
      assert.ok(await dialog.getByRole("button", { name: "保存" }).isEnabled());
      assert.equal(await dialog.getByLabel("渠道名称", { exact: false }).inputValue(), "更新中");
    }
    if (filingPicker === "error") {
      await dialog.getByRole("button", { name: "重试" }).click();
      await dialog.getByText("还没有资产", { exact: true }).waitFor();
    }
    if (filingPicker === "rejected") {
      await dialog.getByRole("button", { name: "移除", exact: true }).click();
      await dialog.getByText("还没有资产", { exact: true }).waitFor();
    }
  }
  const proof = await browser.newPage({
    viewport: logoMenu
      ? { width: 2 * selectGeometry[2] + 40, height: selectGeometry[3] + 76 }
      : pluginDelete
        ? { width: 2 * panelBox.width + 40, height: Math.ceil(panelBox.height) + 76 }
        : batchProgress
          ? { width: 2 * panelBox.width + 40, height: panelBox.height + 72 }
          : pickerMenu
            ? { width: 2 * selectGeometry[2] + 40, height: selectGeometry[3] + 72 }
            : pickerMore
              ? { width: 2 * detailGeometry[8] + 40, height: detailGeometry[9] + 72 }
              : filingPicker
                ? { width: 2 * detailGeometry[0] + 40, height: detailGeometry[1] + 72 }
                : voiceMenu
                  ? { width: 520, height: Math.ceil(voiceGeometry[7]) + 72 }
                  : trialRefMenu
                    ? { width: 488, height: 140 }
                    : humanRemove
                      ? { width: 808, height: removeUsed ? 325 : 257 }
                      : humanDetail
                        ? { width: 1384, height: 555 }
                        : smallConfirm
                          ? {
                              width: 936,
                              height: deleteVersion ? Math.ceil(detailGeometry[1]) + 76 : 290,
                            }
                          : enroll
                            ? { width: 936, height: enrollExisting ? 435 : 360 }
                            : deleteChannel
                              ? { width: 1180, height: 530 }
                              : catalogPanel || modelList || channelOverview
                                ? {
                                    width: Math.ceil(panelBox.width) * 2 + 40,
                                    height: Math.ceil(panelBox.height) + 70,
                                  }
                                : upgrade
                                  ? upgradeNotice
                                    ? { width: 752, height: 125 }
                                    : { width: 936, height: Math.ceil(detailGeometry[1]) + 76 }
                                  : pull
                                    ? { width: 1384, height: 430 }
                                    : batchToolbar
                                      ? { width: 820, height: 145 }
                                      : batchResult
                                        ? { width: 1064, height: Math.ceil(detailGeometry[1]) + 80 }
                                        : batchProtocol
                                          ? {
                                              width: 1576,
                                              height: batchSelectedProtocol
                                                ? compact
                                                  ? 720
                                                  : 820
                                                : batchProtocolEmpty
                                                  ? 530
                                                  : 380,
                                            }
                                          : batch
                                            ? {
                                                width: 936,
                                                height: batchChannel || batchTimeout ? 390 : 305,
                                              }
                                            : trialTab
                                              ? { width: 2088, height: compact ? 689 : 777 }
                                              : modelTab
                                                ? {
                                                    width: Math.ceil(panelBox.width) * 2 + 40,
                                                    height: Math.ceil(panelBox.height) + 72,
                                                  }
                                                : channel
                                                  ? {
                                                      width: 1194,
                                                      height: channelFiling
                                                        ? compact
                                                          ? 702
                                                          : 792
                                                        : channelInvalid
                                                          ? 644
                                                          : channelEdit
                                                            ? 606
                                                            : compact
                                                              ? 702
                                                              : 800,
                                                    }
                                                  : keys
                                                    ? {
                                                        width: 940,
                                                        height: keysReplace ? 485 : 407,
                                                      }
                                                    : upload
                                                      ? {
                                                          width: 1194,
                                                          height: uploadPrompt
                                                            ? 625
                                                            : uploadIssue || uploadDuplicate
                                                              ? 620
                                                              : uploadDown || uploadLimit
                                                                ? 480
                                                                : 410,
                                                        }
                                                      : { width: 1638, height: 826 },
    deviceScaleFactor: 1,
  });
  const panels = await Promise.all(
    [
      ["upstream", "video-canvas · 原版"],
      ["studio", "Link Studio · 当前"],
    ].map(
      async ([id, title]) =>
        `<section><header>${title}</header><img src="data:image/png;base64,${(await readFile(join(work, `${captureName}-${id}.png`))).toString("base64")}" /></section>`,
    ),
  );
  await proof.setContent(
    `<style>*{box-sizing:border-box}body{margin:0;padding:12px;display:flex;gap:16px;background:#11151b;color:#efefef;font:17px -apple-system,sans-serif}header{padding:5px 0 12px}img{display:block}</style>${panels.join("")}`,
  );
  await proof
    .locator("img")
    .evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
  const difference = await proof.locator("img").evaluateAll(([original, replica], region) => {
    const width = original.naturalWidth,
      height = original.naturalHeight;
    if (width !== replica.naturalWidth || height !== replica.naturalHeight)
      return { equalSize: false };
    const pixels = [original, replica].map((image) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, width, height).data;
    });
    let changed = 0;
    let sharedChanged = 0,
      sharedPixels = 0;
    for (let index = 0; index < pixels[0].length; index += 4) {
      const differs = [0, 1, 2].some(
        (offset) => Math.abs(pixels[0][index + offset] - pixels[1][index + offset]) > 16,
      );
      if (differs) changed++;
      if (region) {
        const x = (index / 4) % width,
          y = Math.floor(index / 4 / width);
        if (
          x < Math.floor(region.x) ||
          x >= Math.ceil(region.x + region.width) ||
          y < Math.floor(region.y) ||
          y >= Math.ceil(region.y + region.height)
        ) {
          sharedPixels++;
          if (differs) sharedChanged++;
        }
      }
    }
    return {
      width,
      height,
      rgbTolerance: 16,
      changedPercent: Number(((100 * changed) / (width * height)).toFixed(2)),
      ...(region && {
        outsideApprovalPercent: Number(((100 * sharedChanged) / sharedPixels).toFixed(2)),
      }),
    };
  }, approvalRegion);
  console.log("dialog-diff", captureName, JSON.stringify(difference));
  if (pull)
    assert.ok(
      difference.changedPercent <=
        { ready: 3, empty: 1.5, loading: 1, error: 2.5, nomatch: 2.75 }[pullState],
      `${captureName}: 拉取弹窗尺寸或像素回归`,
    );
  if (priceState === "tiers")
    assert.ok(difference.changedPercent <= 1.6, "规格定价整窗像素差异超过 1.6%");
  if (contextHint) {
    if (!(difference.changedPercent <= 1.5))
      await proof.screenshot({ path: join(tmpdir(), `parity-rejected-${captureName}.png`) });
    assert.ok(difference.changedPercent <= 1.5, "上下文识别组件裁图差异不得超过 1.5%");
  }
  if (dryView || trialFailed || trialTimeline)
    assert.ok(difference.changedPercent <= 1.5, `${captureName}: 试跑整窗像素差异不得超过 1.5%`);
  if (logoMenu)
    assert.ok(
      difference.changedPercent <= { all: 3, empty: 2, selected: 1 }[logoMenu],
      `${captureName}: 厂商菜单像素回归超限`,
    );
  if (
    modelTab === "json" ||
    deleteChannel ||
    deleteVersion ||
    pluginDelete ||
    upgrade ||
    channelEdit ||
    humanDetail ||
    upload ||
    batchChannel ||
    batchResult ||
    batchProgress ||
    batchSelectedProtocol ||
    batchProtocolEmpty ||
    keys ||
    trialMenu ||
    pluginDetails
  ) {
    const maximum = deleteChannel
      ? migrate
        ? 2
        : 1
      : deleteVersion ||
          pluginDelete ||
          upgrade ||
          channelDiscard ||
          filingPicker ||
          pluginDetails ||
          uploadSuccess
        ? 1
        : batchProgress || batchResult || batchProtocolEmpty || keysSaving || uploadPrompt
          ? 2
          : channelEdit || batchSelectedProtocol || modelTab === "json"
            ? 3
            : voiceMenu
              ? 5
              : trialRefMenu
                ? 7
                : humanDetail || upload || keys
                  ? 3
                  : 5;
    const compared = channelApproval
      ? difference.outsideApprovalPercent
      : difference.changedPercent;
    if (!Number.isFinite(compared) || compared > maximum)
      await proof.screenshot({ path: join(tmpdir(), `parity-rejected-${captureName}.png`) });
    assert.ok(
      Number.isFinite(compared) && compared <= maximum,
      `${captureName}: equal crop dimensions and at most ${maximum}% RGB differences in compared area required`,
    );
  }
  await proof.screenshot({
    path: join(
      root,
      "docs/04-技术架构/Provider对照图",
      deleteVersionState
        ? `插件历史-删除版本-${deleteVersionState === "error" ? "占用错误" : "提交中"}${compact ? "-窄窗口" : ""}.png`
        : pluginDelete
          ? `插件删除-${pluginDeleteLabels[pluginDelete]}${compact ? "-窄窗口" : ""}.png`
          : batchProgress
            ? `${progressLabels[progressKind]}-进行中${progressDone === 0 ? "-初始" : ""}${compact ? "-窄窗口" : ""}.png`
            : channelApproval
              ? `渠道编辑-${channelApproval === "endpoint" ? "更换端点" : "内网授权"}${compact ? "-窄窗口" : ""}.png`
              : channelSaving
                ? `渠道编辑-保存中${compact ? "-窄窗口" : ""}.png`
                : channelFiling
                  ? `渠道编辑-方舟备案${compact ? "-窄窗口" : ""}.png`
                  : channelInvalid
                    ? `渠道编辑-字段错误${compact ? "-窄窗口" : ""}.png`
                    : filingPicker
                      ? `真人备案-个人库${pickerStateLabels[filingPicker]}${compact ? "-窄窗口" : ""}.png`
                      : channelDiscard
                        ? `渠道编辑-放弃修改${compact ? "-窄窗口" : ""}.png`
                        : channelEdit
                          ? `渠道编辑-常规${compact ? "-窄窗口" : ""}.png`
                          : removeUsed
                            ? "真人详情-角色卡占用.png"
                            : humanRemove
                              ? "真人详情-移除确认.png"
                              : humanDetail
                                ? detailPreview
                                  ? "真人详情-有预览图.png"
                                  : "真人详情-混合状态.png"
                                : kindConfirm
                                  ? "模型能力切换-确认.png"
                                  : channelOverview
                                    ? "渠道详情-启用.png"
                                    : disableConfirm
                                      ? "渠道停用-确认.png"
                                      : deleteVersion
                                        ? `插件历史-删除版本${compact ? "-窄窗口" : ""}.png`
                                        : enroll
                                          ? enrollExisting
                                            ? "加入真人库-已有真人.png"
                                            : "加入真人库-本机图片.png"
                                          : deleteChannel
                                            ? migrate
                                              ? `渠道删除-迁移引用${compact ? "-窄窗口" : ""}.png`
                                              : `渠道删除-名称确认${compact ? "-窄窗口" : ""}.png`
                                            : modelList
                                              ? `渠道模型列表-混合状态${compact ? "-窄窗口" : ""}.png`
                                              : catalogPanel
                                                ? `插件目录-${catalogMenu ? "行操作菜单" : catalogSelect ? catalogSelectLabels[catalogSelect] : catalogState === "loading" ? "加载中" : catalogState === "error" ? "加载失败" : catalogEmpty ? "无匹配" : "搜索"}${compact ? "-窄窗口" : ""}.png`
                                                : upgrade
                                                  ? toggleState
                                                    ? `插件停用-${{ confirm: "确认", pending: "提交中", error: "失败" }[toggleState]}${compact ? "-窄窗口" : ""}.png`
                                                    : `插件升级-${upgradeNotice ? "顶部成功通知" : upgradeFailed ? "部分失败" : upgradeMultiple ? "混合来源版本" : upgradePending ? "提交中" : upgradeDisabled ? "插件已停用" : "两项引用"}${compact ? "-窄窗口" : ""}.png`
                                                  : pull
                                                    ? `拉取模型-${pullLabels[pullState]}${compact ? "-窄窗口" : ""}.png`
                                                    : batchToolbar
                                                      ? "模型批量工具条.png"
                                                      : batchResult
                                                        ? `${batchAction}-${allFailed ? "全失败结果" : resultKind && !mixedAction ? "成功结果" : firstResultPage ? "长结果首屏" : longResult ? "长结果滚动" : "混合结果"}${compact ? "-窄窗口" : ""}.png`
                                                        : batchProtocol
                                                          ? batchSelectedProtocol
                                                            ? `批量设置能力与协议-OpenAI${compact ? "-窄窗口" : ""}.png`
                                                            : batchProtocolEmpty
                                                              ? `批量协议搜索-无匹配${compact ? "-窄窗口" : ""}.png`
                                                              : batchAgent
                                                                ? "批量设置能力与协议-Agent.png"
                                                                : "批量设置能力与协议.png"
                                                          : batch
                                                            ? batchChannel
                                                              ? `批量修改-渠道${batchChannel === "open" ? "展开" : batchChannel === "long" ? "长列表" : "已选"}.png`
                                                              : batchTimeout
                                                                ? "批量修改-时限.png"
                                                                : "批量修改-空态.png"
                                                            : trialTab
                                                              ? `模型试跑-${dryView ? `请求描述-${dryView}` : voiceMenu ? "官方音色菜单首屏" : trialRefMenu ? "画布素材菜单" : timelineState ? `追踪刷新-${timelineState}` : expandedTimeline ? "HTTP追踪展开" : trialTimeline ? "钩子追踪" : trialFailed ? "业务失败" : trialSuccess ? "文本成功" : trialTab}${compact ? "-窄窗口" : ""}.png`
                                                              : modelTab
                                                                ? `新增模型-${modelTab}${contextAgent ? "-Agent输入能力" : contextHint ? "-上下文识别" : jsonExtension ? "-离线扩展草稿" : jsonNonObject ? "-正文非对象" : jsonInvalidReturn ? "-返回表单错误" : ""}${logoMenu ? "-Logo-" + logoMenu : ""}${priceState ? "-" + priceState : ""}${compact ? "-窄窗口" : ""}.png`
                                                                : channel
                                                                  ? `新增渠道对照${compact ? "-窄窗口" : ""}.png`
                                                                  : keys
                                                                    ? `渠道Key${keysSaving ? "-写入中" : keysPartial ? "-第二项失败" : keysReplace ? "-覆盖与清除" : "对照"}${compact ? "-窄窗口" : ""}.png`
                                                                    : uploadPrompt
                                                                      ? `插件上传-提示词展开${compact ? "-窄窗口" : ""}.png`
                                                                      : upload
                                                                        ? `${uploadDuplicate ? "插件上传-重复版本" : uploadDown ? "插件上传-运行器不可用" : uploadLimit ? "插件上传-文件超限" : uploadIssue ? "插件上传-字段错误" : uploadSuccess ? (uploadInvalidVersion ? "插件上传-非法版本自动登记" : uploadAdjusted ? "插件上传-版本调整" : "插件上传-预检通过") : uploadPending ? "插件上传-预检中" : "上传插件对照"}${compact ? "-窄窗口" : ""}.png`
                                                                        : detailLoading
                                                                          ? `OpenAI详情加载中${compact ? "-窄窗口" : ""}.png`
                                                                          : history
                                                                            ? `OpenAI版本历史${historyPins ? "十项引用" : "对照"}${compact ? "-窄窗口" : ""}.png`
                                                                            : `${detailSettings ? `${detailSettings}-协议设置滚动到底` : "OpenAI详情复刻后对照"}${compact ? "-窄窗口" : ""}.png`,
    ),
  });
  if (upgradeMultiple) {
    await studio.getByRole("button", { name: "全部升级" }).click();
    await studio.getByRole("button", { name: "全部升级" }).waitFor({ state: "detached" });
    const bindings = await studio.evaluate(async () =>
      (await window.desktop.settings.list({})).value.providers.map(({ pluginHash }) => pluginHash),
    );
    assert.deepEqual(
      bindings,
      upgradeModels.map(() => fixture.versions.at(-1).sha256),
    );
  }
} finally {
  await app?.close();
  await browser?.close();
  await server?.close();
  await rm(work, { recursive: true, force: true });
}
