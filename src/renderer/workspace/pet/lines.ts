export const EASTER_LINES = {
  firstOpen: ["早，今天拍点什么？", "来啦，画布给你留着呢。", "新的一天，新的镜头。"],
  wake: [
    "唔，我刚眯了一会儿。",
    "醒啦，继续吧。",
    "没睡着，只是在养精神。",
    "回来啦，我一直在这儿。",
  ],
  night: ["这么晚了，别熬太久。", "夜里也灵感满满呀。", "存好档，早点休息。"],
} as const;

export type EasterKind = keyof typeof EASTER_LINES;
