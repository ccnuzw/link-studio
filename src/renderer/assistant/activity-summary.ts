type ToolCall = { name: string; verb: string; label: string };
type Activity = {
  tools: ToolCall[];
  status: string;
  startedAt: number | null;
  endedAt: number | null;
};
const TOOL_VERBS: Record<string, string> = {
  canvas_get_state: "读取",
  canvas_apply_ops: "修改",
  canvas_arrange: "整理",
  canvas_delete: "删除",
  canvas_inspect_image: "看图",
  plan_update: "计划",
  show_card: "展示",
  ask_user: "提问",
  model_list: "查模型",
  generate_media: "生成",
  task_get: "查任务",
  skill_search: "技能",
  skill_read: "技能",
  canvas_inspect_video: "看视频",
  canvas_capture_frame: "截帧",
  web_search: "搜索",
  web_fetch: "读网页",
  codemode: "脚本",
  drama_read: "读取",
  drama_update_outline: "改大纲",
  drama_update_episode: "改剧本",
  drama_update_segment: "改片段",
  drama_run_job: "提交",
};
function toolVerb(name: string, verb: string, label: string) {
  return TOOL_VERBS[name] || verb || label || name;
}

export type VerbIcon =
  | "read"
  | "edit"
  | "arrange"
  | "delete"
  | "look"
  | "plan"
  | "ask"
  | "models"
  | "generate"
  | "task"
  | "skill"
  | "script"
  | "video"
  | "frame"
  | "search"
  | "web"
  | "other";

const VERB_ICONS: Record<string, VerbIcon> = {
  读取: "read",
  修改: "edit",
  整理: "arrange",
  删除: "delete",
  看图: "look",
  计划: "plan",
  提问: "ask",
  查模型: "models",
  生成: "generate",
  查任务: "task",
  技能: "skill",
  脚本: "script",
  看视频: "video",
  截帧: "frame",
  搜索: "search",
  读网页: "web",
};

const VERB_PHRASES: Record<string, string> = {
  读取: "读取了画布",
  修改: "修改了画布",
  整理: "整理了布局",
  删除: "申请了删除",
  看图: "查看了图片",
  计划: "更新了计划",
  提问: "向你提了问题",
  查模型: "查看了可用模型",
  生成: "申请了生成",
  查任务: "查询了任务",
  技能: "查阅了技能",
  脚本: "运行了脚本",
  看视频: "查看了视频",
  截帧: "截取了视频帧",
  搜索: "搜索了网页",
  读网页: "读取了网页",
};

const ADMIN_TOOL_PHRASES: Record<string, string> = {
  admin_query: "查询了后台记录",
  admin_get_resource: "读取了后台资源",
  admin_list_models: "查看了模型列表",
  admin_get_model: "读取了模型配置",
  admin_list_channels: "查看了渠道",
  admin_get_pricing_settings: "读取了定价设置",
  admin_quote_preview: "预览了价格",
  admin_propose_changes: "提交了变更单",
  admin_list_plugins: "查看了插件",
  admin_get_plugin: "读取了插件代码",
  admin_plugin_check: "验证了插件",
  admin_request_secret: "请求填写密钥",
  admin_test_run: "申请了试跑",
};

const VERB_PRIORITY = [
  "生成",
  "删除",
  "修改",
  "截帧",
  "整理",
  "看视频",
  "看图",
  "搜索",
  "读网页",
  "脚本",
  "提问",
  "计划",
  "技能",
  "查模型",
  "查任务",
  "读取",
];

const PHRASE_KINDS = 3;

function phraseOf(tools: Pick<ToolCall, "name" | "verb" | "label">[]) {
  const counts = new Map<string, number>();
  for (const t of tools) {
    const verb = toolVerb(t.name, t.verb, t.label);
    const phrase = ADMIN_TOOL_PHRASES[t.name] ?? VERB_PHRASES[verb] ?? `调用了「${verb}」`;
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  const parts = [...counts].map(([phrase, count]) => phrase + (count > 1 ? ` ${count} 次` : ""));
  return parts.length > PHRASE_KINDS
    ? `${parts.slice(0, PHRASE_KINDS).join("、")}等 ${parts.length} 项`
    : parts.join("、");
}

export function activitySummary(item: Activity) {
  const counts = new Map<string, number>();
  for (const t of item.tools) {
    const verb = toolVerb(t.name, t.verb, t.label);
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  const verbs = [...counts].map(([verb, count]) => ({
    verb,
    icon: VERB_ICONS[verb] ?? ("other" as VerbIcon),
    count,
  }));
  const seconds =
    item.startedAt !== null && item.endedAt !== null
      ? Math.max(1, Math.round((item.endedAt - item.startedAt) / 1000))
      : null;
  const head = item.status === "aborted" ? "已中止" : seconds ? `已处理 ${seconds}s` : "已处理";
  const text = [head, ...verbs.map((v) => `${v.verb} ${v.count}`)].join(" · ");
  const main = VERB_PRIORITY.find((v) => counts.has(v)) ?? [...counts.keys()][0];
  const icon: VerbIcon = (main && VERB_ICONS[main]) || "other";
  return {
    seconds,
    verbs,
    text,
    icon,
    phrase: phraseOf(item.tools),
  };
}

export function toolIcon(tool: Pick<ToolCall, "name" | "verb" | "label">): VerbIcon {
  return VERB_ICONS[toolVerb(tool.name, tool.verb, tool.label)] ?? "other";
}

export function formatSeconds(seconds: number) {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
