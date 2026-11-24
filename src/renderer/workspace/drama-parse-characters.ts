/** 人物卡片上的一项资料，如「身份：蓝星大学班长」 */
export type CharacterField = {
  /** 标签，如 身份、动机、能力/根基；原文写什么就是什么，不限定取值 */
  label: string;
  /** 内容，已去掉粗体 / 斜体等记号 */
  value: string;
};

/** 从人物传记里拆出来的一个人物 */
export type CharacterCard = {
  /** 所在分组，如「主要人物」；原文没分组时为空串 */
  group: string;
  /** 正式名称 */
  name: string;
  /** 名字后面括号里的内容，如「外号：壕天帝」；没有时为空串 */
  alias: string;
  /** 带标签的资料，按原文顺序 */
  fields: CharacterField[];
  /** 没有标签的句子，按原文顺序；保证原文内容不丢 */
  notes: string[];
};

/** 一行 Markdown 的类别 */
type Line =
  /** 标题：# 开头，或单独一行的粗体 */
  | { kind: "heading"; text: string }
  /** 列表项；indent 是缩进的空格数 */
  | { kind: "item"; indent: number; text: string }
  /** 普通文字 */
  | { kind: "text"; text: string };

/** 标题里出现这些词就当分组（「主要人物」「反派阵营」），否则当一个人的名字 */
const GROUP_RE = /人物|角色|主角|配角|反派|群像|其他|阵营|家族|势力|关系/;

const HEADING_RE = /^#{1,6}\s+(.+?)\s*#*$/;
const BOLD_LINE_RE = /^\*\*([^*]+)\*\*\s*[:：]?$/;
const ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.+)$/;
/** 「**标签**：内容」 */
const BOLD_FIELD_RE = /^\*\*(.+?)\*\*\s*[:：]\s*(.+)$/;
/** 「标签：内容」：标签短、不带括号和空格，免得把「林阳（外号：壕天帝）」当成字段 */
const PLAIN_FIELD_RE = /^([^:：（()）\s]{1,8})[:：]\s*(.+)$/;
const ALIAS_RE = /^(.+?)\s*[（(](.+)[）)]$/;
const INTRO_RE = /^\*\*(.+?)\*\*\s*(?:[:：]|[—–]+|\s-\s)\s*(.+)$/;
const BIO_FIELD =
  /^(?:正式名称|姓名|身份|年龄|别名|别称|外号|动机|经历|关系|性格|外貌|目标|能力|背景|阶段|童年|少年|青年|成年|晚年|时期|特征|简介|介绍|形象|职业|.*岁)$/;

function startsRoster(lines: Line[], start: number) {
  let people = 0;
  let indent: number | undefined;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.kind === "heading") break;
    if (line.kind !== "item") continue;
    indent ??= line.indent;
    if (line.indent !== indent) continue;
    const match = INTRO_RE.exec(line.text);
    if (!match || BIO_FIELD.test(match[1]!)) return false;
    if (/^\*\*[^*]+\*\*\s*[—–-]/.test(line.text) || ALIAS_RE.test(match[1]!)) return true;
    people++;
  }
  return people > 1;
}

/** 去掉粗体、斜体、行内代码记号，只留文字 */
function plain(text: string) {
  return text
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1$2")
    .trim();
}

/** 拆「标签：内容」；不是这种写法时为 null */
function fieldOf(text: string): CharacterField | null {
  const bold = BOLD_FIELD_RE.exec(text);
  if (bold) return { label: plain(bold[1]!), value: plain(bold[2]!) };
  const cleaned = plain(text);
  const match = PLAIN_FIELD_RE.exec(cleaned);
  return match ? { label: match[1]!, value: match[2]!.trim() } : null;
}

/** 按行分类；空行丢掉 */
function lex(markdown: string): Line[] {
  const lines: Line[] = [];
  for (const raw of markdown.replace(/\t/g, "    ").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const heading = HEADING_RE.exec(raw.trim()) ?? BOLD_LINE_RE.exec(raw.trim());
    if (heading) {
      lines.push({ kind: "heading", text: plain(heading[1]!) });
      continue;
    }
    const item = ITEM_RE.exec(raw);
    if (item) lines.push({ kind: "item", indent: item[1]!.length, text: item[2]!.trim() });
    else lines.push({ kind: "text", text: raw.trim() });
  }
  return lines;
}

/** 新建一个人物：名字后面括号里的内容拆成 alias */
function newCard(group: string, title: string): CharacterCard {
  const match = ALIAS_RE.exec(title);
  return {
    group,
    name: match ? match[1]!.trim() : title,
    alias: match ? match[2]!.trim() : "",
    fields: [],
    notes: [],
  };
}

/** 往人物上记一行：带标签进 fields，没标签进 notes */
function addLine(card: CharacterCard, text: string) {
  const field = fieldOf(text);
  if (field) card.fields.push(field);
  else if (plain(text)) card.notes.push(plain(text));
}

/**
 * 把人物传记（AI 研读时写的 Markdown，写法不固定）拆成人物卡片。认得三种常见写法：
 * - 分组标题下，一级列表项是人名，子项是「**身份**：……」；
 * - 一个人名一个标题，下面跟字段；
 * - 一行一个人：「- **人名**：介绍」，介绍放进 notes。
 * 拆不出任何人物时返回空数组，由调用方改显示原文。
 * @param markdown 人物传记原文
 * @returns 人物卡片，按原文顺序
 */
export function parseCharacters(markdown: string): CharacterCard[] {
  const cards: CharacterCard[] = [];
  let group = "";
  /** 正在记的人物 */
  let card: CharacterCard | null = null;
  /** 当前人物是标题开的：下面的列表项都是它的字段 */
  let fromHeading = false;
  /** 这一段列表里人名那一层的缩进；遇到标题重新算 */
  let topIndent: number | null = null;
  let period: CharacterField | undefined;

  const lines = lex(markdown);
  for (const [index, line] of lines.entries()) {
    if (line.kind === "heading") {
      topIndent = null;
      period = undefined;
      if (
        card &&
        /^(?:童年|少年|青年|成年|中年|晚年|幼年|老年|[零一二三四五六七八九十百\d]+岁)(?:阶段|时期)?$/.test(
          line.text,
        )
      ) {
        period = { label: line.text, value: "" };
        card.fields.push(period);
        fromHeading = true;
      } else if (GROUP_RE.test(line.text) || startsRoster(lines, index + 1)) {
        group = line.text;
        card = null;
        fromHeading = false;
      } else {
        card = newCard(group, line.text);
        cards.push(card);
        fromHeading = true;
      }
      continue;
    }
    if (period) {
      period.value = [period.value, plain(line.text)].filter(Boolean).join("\n");
      continue;
    }
    if (line.kind === "text") {
      if (card && card.fields.at(-1)?.value === "") card.fields.at(-1)!.value = plain(line.text);
      else if (card) addLine(card, line.text);
      continue;
    }
    if (fromHeading && card) {
      addLine(card, line.text);
      continue;
    }
    if (topIndent === null || line.indent <= topIndent) {
      topIndent = line.indent;
      const intro = INTRO_RE.exec(line.text);
      card = newCard(group, plain(intro ? intro[1]! : line.text));
      if (intro && plain(intro[2]!)) card.notes.push(plain(intro[2]!));
      cards.push(card);
      continue;
    }
    if (card) addLine(card, line.text);
  }
  return cards;
}

/** 卡片上显示的样子：名字下面一行副标题，下面是其余资料 */
export type CardDisplay = {
  /** 名字 */
  name: string;
  /** 名字下面的一行：括号里的外号和「别称 / 别名 / 外号」资料，用 · 隔开；没有时为空串 */
  subtitle: string;
  /** 其余资料 */
  fields: CharacterField[];
};

/** 这些资料放到名字下面，不在资料表里重复 */
const ALIAS_LABELS = new Set(["别称", "别名", "外号", "绰号", "称呼"]);

/**
 * 把拆出来的人物整理成卡片上的样子：「正式名称」和名字一样时不再重复列出，别称挪到名字下面。
 * @param card 拆出来的人物
 * @returns 卡片上显示的名字、副标题和资料
 */
export function cardDisplay(card: CharacterCard): CardDisplay {
  const aliases = card.alias ? [card.alias] : [];
  const fields: CharacterField[] = [];
  for (const field of card.fields) {
    if (ALIAS_LABELS.has(field.label)) aliases.push(field.value);
    else if (field.label === "正式名称" && field.value === card.name) continue;
    else fields.push(field);
  }
  return { name: card.name, subtitle: aliases.join(" · "), fields };
}

export function biographyPassages(note: string) {
  return (note.match(/[^。！？；]+[。！？；]*|[。！？；]+/gu) ?? [])
    .map((text) => {
      const periods = [
        ...new Set(
          text.match(
            /[零一二两三四五六七八九十百\d]+岁|童年时期|少年时期|成年以后|成年后|幼年时/gu,
          ) ?? [],
        ),
      ];
      return { text, periods };
    })
    .reduce<{ text: string; periods: string[] }[]>((parts, passage) => {
      const last = parts.at(-1);
      if (last && !last.periods.length && !passage.periods.length) last.text += passage.text;
      else parts.push(passage);
      return parts;
    }, []);
}
