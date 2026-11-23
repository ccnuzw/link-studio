import type {
  DramaDocument,
  DramaSourcePreview,
} from "../../../packages/link-studio-core/src/drama.ts";
import { ProjectError } from "./errors.ts";

const episode = /^第[零〇一二三四五六七八九十百千万两0-9]+集[^\n]*$/u;
const chapter = /^第[零〇一二三四五六七八九十百千万两0-9]+[章节回卷][^\n]*$/u;
const dialogue = /^[\p{Script=Han}A-Za-z·]{1,16}(?:[（(][^）)\n]{0,30}[）)])?[：:].+/su;
const scene =
  /^(?:[0-9]+[-－.][0-9]+(?:[\t\f\r ]|[：:、]).*|场景[：:].*|[内外]景(?:[\t\f\r ]|[：:、]).*|(?:日|夜)[\t\f\r ·/／].*)$/su;
const noise =
  /^(?:(?:https?:\/\/|www\.)[^\t\n\f\r ]+|(?:求推荐票|求月票|求订阅|求收藏|求打赏|笔趣阁|顶点小说|起点中文网).*|[（(]?(?:本章完|未完待续)[）)]?[。！!]*|作者有话说.*|PS[：:].*)$/isu;
type Unit = { kind: string; title: string; text: string };

function trimSpace(text: string) {
  const space = /\p{White_Space}/u;
  let start = 0,
    end = text.length;
  while (start < end && space.test(text[start]!)) start++;
  while (start < end && space.test(text[end - 1]!)) end--;
  return text.slice(start, end);
}

export function runeCount(text: string) {
  let count = 0;
  for (let index = 0; index < text.length; count++)
    index += text.codePointAt(index)! > 0xffff ? 2 : 1;
  return count;
}

export function dramaKindSample(raw: string) {
  const text = trimSpace(raw),
    count = runeCount(text);
  if (count <= 4000) return text;
  const middle = Math.floor(count / 2) - 600;
  let offset = 0,
    position = 0;
  const bounds = new Map<number, number>();
  for (const target of [1600, middle, middle + 1200, count - 1200].sort(
    (first, second) => first - second,
  )) {
    while (position < target) {
      offset += text.codePointAt(offset)! > 0xffff ? 2 : 1;
      position++;
    }
    bounds.set(target, offset);
  }
  return [
    text.slice(0, bounds.get(1600)),
    text.slice(bounds.get(middle), bounds.get(middle + 1200)),
    text.slice(bounds.get(count - 1200)),
  ].join("\n……\n");
}

function paragraphUnits(text: string, kind: string, title = ""): Unit[] {
  const parts: string[] = [];
  let pending = "";
  let used = 0;
  const flush = () => {
    if (pending) parts.push(trimSpace(pending));
    pending = "";
    used = 0;
  };
  for (const line of text.split(/(?<=\n)/u)) {
    let remaining = runeCount(line),
      start = 0;
    function take(count: number) {
      const from = start;
      for (let index = 0; index < count; index++)
        start += line.codePointAt(start)! > 0xffff ? 2 : 1;
      remaining -= count;
      return line.slice(from, start);
    }
    if (remaining > 9000 && used > 0) {
      pending += take(9000 - used);
      flush();
    }
    if (used + remaining > 9000) flush();
    while (remaining > 9000) parts.push(take(9000));
    pending += line.slice(start);
    used += remaining;
  }
  flush();
  return parts.flatMap((part, index) =>
    part
      ? [
          {
            kind,
            text: part,
            title: title ? `${title}（${index + 1}/${parts.length}）` : `第 ${index + 1} 段`,
          },
        ]
      : [],
  );
}

function markedUnits(
  text: string,
  kind: string,
  marker: RegExp,
  issues: DramaSourcePreview["issues"],
): Unit[] {
  const units: Unit[] = [];
  let current: Unit = { kind: "prologue", title: "序", text: "" };
  for (const line of text.split(/(?<=\n)/u)) {
    if (marker.test(trimSpace(line))) {
      units.push(current);
      current = { kind, title: trimSpace(line), text: "" };
    }
    current.text += line;
  }
  units.push(current);
  let previous = "";
  return units.flatMap((unit) => {
    const part = trimSpace(unit.text);
    if (!part) return [];
    if (unit.kind !== "prologue" && part === unit.title) {
      issues.push({ kind: "empty", count: 1, message: "丢弃空单元" });
      return [];
    }
    if (unit.title === previous)
      issues.push({ kind: "duplicate", count: 1, message: `连续重复标题：${unit.title}` });
    previous = unit.title;
    const length = runeCount(part);
    if (unit.kind === "chapter" && length > 12000) {
      issues.push({ kind: "split_long", count: 1, message: `超长章节已按段落拆分：${unit.title}` });
      return paragraphUnits(part, unit.kind, unit.title);
    }
    if (unit.kind === "episode" && length > 40000)
      issues.push({ kind: "episode_too_long", count: 1, message: `${unit.title}超过 4 万字` });
    return [{ ...unit, text: part }];
  });
}

export function preflightDramaSource(script: string, sourceKind?: "script" | "novel") {
  const source = trimSpace(script.replace(/^\uFEFF/u, "")).replace(/\r\n?/gu, "\n");
  const chars = runeCount(source);
  if (chars > 5_000_000) throw new ProjectError("VALIDATION_FAILED", "原文超过 500 万字");
  if (/[^\P{Cc}\n\t]/u.test(source))
    throw new ProjectError("VALIDATION_FAILED", "正文包含非文本控制字符");
  const original = source.split("\n");
  const lines = original.filter((line) => {
    const trimmed = trimSpace(line);
    return trimmed.length >= 160 || runeCount(trimmed) >= 80 || !noise.test(trimmed);
  });
  const removed = original.length - lines.length;
  const issues: DramaSourcePreview["issues"] = [];
  if (removed)
    issues.push({ kind: "noise_removed", count: removed, message: `清掉 ${removed} 行插入语` });
  const clean = trimSpace(lines.join("\n"));
  const nonempty = lines.map(trimSpace).filter(Boolean);
  const matches = (pattern: RegExp) => nonempty.filter((line) => pattern.test(line)).length;
  const episodeCount = matches(episode),
    sceneCount = matches(scene),
    chapterCount = matches(chapter);
  const dialogues = matches(dialogue);
  const quotes = nonempty.filter((line) => line.includes("“") && line.includes("”")).length;
  const total = nonempty.length;
  const kindGuess =
    episodeCount >= 2 || (sceneCount >= 3 && dialogues * 10 >= total * 3)
      ? "script"
      : chapterCount >= 2 || (total > 0 && quotes * 10 >= total && dialogues * 10 < total)
        ? "novel"
        : "unknown";
  const percent = Math.floor((dialogues * 100) / Math.max(1, total));
  const kindSignals = `找到 ${episodeCount} 个分集标记、${chapterCount} 个章节标题、${sceneCount} 个场次头；对白行占 ${percent}%`;
  const marker =
    episodeCount >= 2
      ? episode
      : (sourceKind ?? kindGuess) === "script" && sceneCount >= 3
        ? scene
        : chapterCount >= 2
          ? chapter
          : null;
  const kind =
    marker === episode
      ? "episode"
      : marker === scene
        ? "scene"
        : marker === chapter
          ? "chapter"
          : "chunk";
  const units = marker ? markedUnits(clean, kind, marker, issues) : paragraphUnits(clean, kind);
  if (!units.length) throw new ProjectError("VALIDATION_FAILED", "没有可读取的剧本正文");
  for (const unit of units) unit.title = Array.from(unit.title).slice(0, 255).join("");
  return {
    units,
    issues,
    kindSignals,
    kindGuess,
    source: { text: clean, chars, kind, total: units.length },
  } as const;
}

export function importPastedDrama(script: string, episodeSeconds = 60) {
  if (!Number.isInteger(episodeSeconds) || episodeSeconds < 30 || episodeSeconds > 180)
    throw new ProjectError("VALIDATION_FAILED", "单集时长须为 30 到 180 秒");
  const parsed = preflightDramaSource(script, "script");
  const { units } = parsed;
  const marked = units.some((unit) => unit.kind === "episode");
  const episodes: DramaDocument["episodes"] = [];
  let start = 0;
  let chars = 0;
  let seenEpisode = false;
  const flush = (end: number) => {
    const group = units.slice(start, end);
    const heading = group.find((unit) => unit.kind === "episode") ?? group[0];
    if (!heading) return;
    const title = Array.from(heading.title).slice(0, 255).join("");
    const script_md = group
      .map((unit) =>
        unit.text
          .split("\n")
          .map((line) => (scene.test(trimSpace(line)) ? `**${line}**` : line))
          .join("\n"),
      )
      .join("\n\n");
    episodes.push({
      episode_no: episodes.length + 1,
      title,
      synopsis: "",
      script_md,
      unit_from: start + 1,
      unit_to: end,
      revision: 1,
    });
    start = end;
    chars = 0;
  };
  for (const [index, unit] of units.entries()) {
    if (unit.kind === "episode") {
      if (seenEpisode) flush(index);
      seenEpisode = true;
    }
    chars += Array.from(unit.text).length;
    if (!marked && chars >= Math.floor((episodeSeconds * 1000) / 60)) flush(index + 1);
  }
  flush(units.length);
  if (episodes.length > 100000) throw new ProjectError("VALIDATION_FAILED", "集号不能超过100000");
  return { episodes, ...parsed };
}

export function numberedSource(unit: Unit, number: number) {
  return `## [${number}] ${unit.title}\n${unit.text}\n`;
}

export function novelAnalysisSample(units: Unit[], contextBudget: number) {
  const budget = Math.min(40000, Math.max(0, Math.floor(contextBudget)));
  const parts = units.map((unit, index) => numberedSource(unit, index + 1));
  const sizes = parts.map((part) => Array.from(part).length);
  if (sizes.reduce((sum, size) => sum + size, 0) <= budget) return parts.join("");

  let text = "";
  let used = 0;
  let index = 0;
  const openingBudget = Math.floor((budget * 3) / 4);
  while (index < parts.length && used + sizes[index]! <= openingBudget) {
    text += parts[index]!;
    used += sizes[index++]!;
  }
  if (!index && parts.length) {
    text = Array.from(parts[0]!).slice(0, openingBudget).join("");
    used = Array.from(text).length;
    index++;
  }
  const count = Math.min(12, parts.length - index);
  for (let offset = 0; offset < count; offset++) {
    const position =
      index + (count > 1 ? Math.floor((offset * (parts.length - index - 1)) / (count - 1)) : 0);
    const runes = Array.from(parts[position]!).slice(
      0,
      Math.floor((budget - used) / (count - offset)),
    );
    text += runes.join("");
    used += runes.length;
  }
  return text;
}

export function novelPlanningBatches(units: Unit[], rangeEnd: number, contextWindow?: number) {
  if (!Number.isInteger(rangeEnd) || rangeEnd < 1 || rangeEnd > units.length)
    throw new ProjectError("VALIDATION_FAILED", "规划范围超出原文单元");
  const selected = units.slice(0, rangeEnd);
  checkDramaUnitsFit(selected, contextWindow);
  const budget = dramaBatchBudget(contextWindow);
  const batches: { from: number; to: number; source: string; chars: number }[] = [];
  for (const [index, unit] of selected.entries()) {
    const number = index + 1;
    const source = numberedSource(unit, number);
    const chars = Array.from(source).length;
    const last = batches.at(-1);
    if (!last || number - last.from >= 12 || last.chars + chars > budget) {
      batches.push({ from: number, to: number, source, chars });
    } else {
      last.to = number;
      last.source += source;
      last.chars += chars;
    }
  }
  return batches;
}

export function dramaBatchBudget(contextWindow?: number) {
  return Math.min(
    30000,
    (contextWindow ? Math.max(1, Math.floor(contextWindow * 0.6)) : 12000) - 8192,
  );
}

export function nextNovelBatch(units: Unit[], cursor: number, end: number, budget: number) {
  let source = "",
    to = cursor,
    used = 0;
  for (const unit of units.slice(cursor, Math.min(end, cursor + 12))) {
    const part = numberedSource(unit, to + 1);
    used += Array.from(part).length;
    if (used > Math.min(30000, budget)) break;
    source += part;
    to++;
  }
  if (to === cursor) throw new ProjectError("DRAMA_CONTEXT", "一个完整单元超过上下文预算");
  return { source, to };
}

export function checkDramaModelCapacity(
  document: DramaDocument,
  contextWindow?: number,
  text = document.source?.text,
) {
  const units = text
    ? document.planning
      ? preflightDramaSource(text, "novel").units.slice(0, document.planning.end)
      : importPastedDrama(text, document.episode_seconds).units
    : [];
  checkDramaUnitsFit(units, contextWindow);
}

export function checkDramaUnitsFit(units: Unit[], contextWindow?: number) {
  const budget = dramaBatchBudget(contextWindow);
  if (budget <= 0)
    throw new ProjectError(
      "DRAMA_CONTEXT",
      "这个模型的上下文太小，放不下提示词，请换上下文更大的模型",
    );
  let longest = { title: "", chars: 0 };
  for (const [index, unit] of units.entries()) {
    const chars = Array.from(`## [${index + 1}] ${unit.title}\n\n${unit.text}`).length;
    if (chars > longest.chars) longest = { title: unit.title, chars };
  }
  if (longest.chars > budget)
    throw new ProjectError(
      "DRAMA_CONTEXT",
      `「${longest.title}」约 ${longest.chars} 字，超过这个模型一次能读的 ${budget} 字，请换上下文更大的模型`,
    );
}
