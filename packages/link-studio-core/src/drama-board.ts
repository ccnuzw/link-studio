type BoardLayout = "2x2" | "3x2" | "3x3";
export function boardTemplateError(body: string): string | undefined {
  const placeholders = /\{\{([^{}]*)\}\}/g;
  for (const match of body.matchAll(placeholders)) {
    if (!["格数", "列数", "行数", "比例", "画面"].includes(match[1] ?? ""))
      return `不认识的占位符 ${match[0]}`;
  }
  if (/\{\{|\}\}/.test(body.replace(placeholders, "")))
    return "占位符没写完整，花括号要成对写成 {{名字}}";
  if (!body.includes("{{画面}}")) return "故事板提示词必须保留 {{画面}}";
}
const BOARD_SHOTS_PLACEHOLDER = "{{画面}}";
export const boardTemplate = `请根据下面的片段内容，生成一张手绘风格分镜稿。
该分镜稿使用 {{列数}} 列 {{行数}} 行的布局，共 {{格数}} 格，整图比例 {{比例}}，从左到右、从上到下依次对应下面的镜头，格与格之间用细线隔开，没用到的格子留白。
要求
1. 铅笔单线条线稿，不追求精细光影和色彩，重点突出角色动作与镜头节奏。
2. 每个镜头都标注镜头类型（如低角度、极端广角、手持近景）、表演提示、音效说明，写在对应的格子里，并在格子右上角标出编号。
3. 这些镜头要完整串联，顺序通顺、逻辑严密，通过镜头切换和动作衔接构建出流畅的动作逻辑。
{{画面}}
保持人物与参考图完全一致，面部特征100%相同，保持相同的骨骼结构、眼间距和下颚几何形状，禁止美化，禁止改变年龄`;
export const BOARD_RATIO = "16:9";

const MAX_CELLS = 9;

const SHOT_RE = /^\s*\d+(?:\.\d+)?\s*[-–~]\s*\d+(?:\.\d+)?\s*秒\s*[:：]\s*(.*)$/;
const SPOKEN_RE = /^(台词|对白|声音|音效|环境声)/;

function section(prompt: string, name: string): string {
  const line = prompt.split("\n").find((item) => item.trim().startsWith(`【${name}】`));
  return line
    ? line
        .trim()
        .slice(name.length + 2)
        .trim()
    : "";
}

function visual(text: string): string {
  return text
    .split("。")
    .map((part) => part.trim())
    .filter((part) => part && !part.includes("『") && !SPOKEN_RE.test(part))
    .map((part) => `${part}。`)
    .join("");
}

export function shotLines(prompt: string): string[] {
  const lines = prompt.split("\n");
  const start = lines.findIndex((line) => line.trim().startsWith("【时间轴】"));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith("【")) break;
    const match = line.match(SHOT_RE);
    if (match) out.push(visual(match[1] ?? ""));
  }
  return out;
}

export function boardLayout(shots: number): { layout: BoardLayout; cols: number; rows: number } {
  if (shots <= 4) return { layout: "2x2", cols: 2, rows: 2 };
  if (shots <= 6) return { layout: "3x2", cols: 3, rows: 2 };
  return { layout: "3x3", cols: 3, rows: 3 };
}

export function boardPrompt(
  prompt: string,
  template: string = boardTemplate,
): {
  text: string;
  layout: BoardLayout;
  shotCount: number;
  notice: string;
} {
  const shots = shotLines(prompt);
  const { layout, cols, rows } = boardLayout(shots.length);
  const cells = cols * rows;
  let notice = "";
  let body: string;
  if (shots.length === 0) {
    notice = "没识别到时间轴，按 4 格生成";
    body = `按下面的片段内容拆成 ${cells} 个镜头：\n${prompt.trim()}`;
  } else {
    const shown =
      shots.length > MAX_CELLS
        ? [...shots.slice(0, MAX_CELLS - 1), shots.slice(MAX_CELLS - 1).join("；")]
        : shots;
    if (shots.length > MAX_CELLS) {
      notice = `镜头过多（${shots.length} 个），第 9 格合并了剩下的镜头，建议拆段`;
    }
    body = [
      ...[
        ["画面风格", section(prompt, "画幅风格")],
        ["场景与光", section(prompt, "场景与光")],
        ["人物与道具", section(prompt, "参考与人物")],
        ["站位", section(prompt, "站位")],
      ]
        .filter(([, value]) => value)
        .map(([name, value]) => `${name}：${value}`),
      "镜头：",
      ...shown.map((shot, index) => `${index + 1}. ${shot}`),
    ].join("\n");
  }
  const values: Record<string, string> = {
    格数: String(cells),
    列数: String(cols),
    行数: String(rows),
    比例: BOARD_RATIO,
  };
  const base = template.trim() || BOARD_SHOTS_PLACEHOLDER;
  const filled = base.split(BOARD_SHOTS_PLACEHOLDER).join("\u0000");
  const text = filled
    .replace(/\{\{(格数|列数|行数|比例)\}\}/g, (token, name: string) => values[name] ?? token)
    .split("\u0000")
    .join(body);
  return {
    text: base.includes(BOARD_SHOTS_PLACEHOLDER) ? text : `${text}\n${body}`,
    layout,
    shotCount: shots.length,
    notice,
  };
}
