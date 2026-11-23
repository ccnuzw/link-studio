package dramasource

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

const (
	kindHeadRunes = 1600
	kindMidRunes  = 1200
	kindTailRunes = 1200
)

func KindSample(text string) string {
	runes := []rune(strings.TrimSpace(text))
	if len(runes) <= kindHeadRunes+kindMidRunes+kindTailRunes {
		return string(runes)
	}
	mid := len(runes)/2 - kindMidRunes/2
	return string(runes[:kindHeadRunes]) + "\n……\n" +
		string(runes[mid:mid+kindMidRunes]) + "\n……\n" +
		string(runes[len(runes)-kindTailRunes:])
}

func KindPrompt(sample string) string {
	return `你是影视编剧助理。判断下面的原文片段（开头、中间、结尾各取一段，用「……」隔开）是「剧本」还是「小说」。

判断依据：
- script（剧本）：以场次、对白、动作提示为主，如「1-1 日/内 地点」、「△」动作行、「人物名：台词」、「第N集」；几乎没有大段叙述和心理描写。
- novel（小说）：以叙述、描写、心理活动为主，台词夹在叙述里，常见章节标题；没有场次头和对白格式。
- 梗概、大纲、设定集、随笔等也按更接近的一类选，不要拒绝回答。

只返回一个 JSON 对象，不要代码围栏和其他文字：{"kind":"script 或 novel","reason":"一句话说明依据，不超过 30 字"}

原文片段：
<source>
` + sample + `
</source>`
}

func ParseKindGuess(text string) (kind, reason string, ok bool) {
	start, end := strings.Index(text, "{"), strings.LastIndex(text, "}")
	if start < 0 || end <= start {
		return "", "", false
	}
	var out struct {
		Kind   string `json:"kind"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal([]byte(text[start:end+1]), &out); err != nil {
		return "", "", false
	}
	kind = strings.TrimSpace(out.Kind)
	if kind != "script" && kind != "novel" {
		return "", "", false
	}
	reason = strings.TrimSpace(out.Reason)
	if utf8.RuneCountInString(reason) > 60 {
		reason = string([]rune(reason)[:60])
	}
	return kind, reason, true
}
