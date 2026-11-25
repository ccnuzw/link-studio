package dramaoutput

import (
	"regexp"
	"strconv"
	"unicode"
)

type StoryboardSegment struct {
	Seconds int    `json:"seconds"`
	Prompt  string `json:"prompt"`
}

type StoryboardOutput struct {
	Segments []StoryboardSegment `json:"segments"`
}

func (o StoryboardOutput) Validate() error {
	return o.ValidateMaxSeconds(60)
}

func (o StoryboardOutput) ValidateMaxSeconds(limit int) error {
	if len(o.Segments) == 0 || limit < 4 || limit > 60 {
		return invalidOutput("分镜不能为空且时长上限须为4至60秒")
	}
	for _, segment := range o.Segments {
		if segment.Seconds < 1 || segment.Seconds > limit || !nonemptyText(segment.Prompt) {
			return invalidOutput("片段须有提示词，时长须为正整数且不超过max_seconds")
		}
		if end, over := timelineOverrun(segment.Prompt, segment.Seconds); over {
			return invalidOutput("提示词时间轴写到" + strconv.FormatFloat(end, 'f', -1, 64) + "秒，超过该片段seconds，须改为不超过seconds或拆段")
		}
	}
	return nil
}

func (o StoryboardOutput) ValidateVoices(limit int, voiced map[string]bool) error {
	if limit <= 0 {
		return nil
	}
	for i, segment := range o.Segments {
		seen := map[string]bool{}
		for _, parts := range storyboardMention.FindAllStringSubmatch(segment.Prompt, -1) {
			if voiced[parts[2]] {
				seen[parts[2]] = true
			}
		}
		if len(seen) > limit {
			return invalidOutput("第" + strconv.Itoa(i+1) + "段引用了" + strconv.Itoa(len(seen)) + "个has_voice为true的角色，超过max_audios=" + strconv.Itoa(limit) + "，须在镜头之间拆段")
		}
	}
	return nil
}

var storyboardMention = regexp.MustCompile(`@\[([^\]\r\n]+)\]\(([^)\r\n]+)\)`)

func (o *StoryboardOutput) SanitizeReferences(ids map[string]bool) {
	for i := range o.Segments {
		o.Segments[i].Prompt = storyboardMention.ReplaceAllStringFunc(o.Segments[i].Prompt, func(token string) string {
			parts := storyboardMention.FindStringSubmatch(token)
			if ids[parts[2]] {
				return token
			}
			return parts[1]
		})
	}
}

var timelineRange = regexp.MustCompile(`(\d+(?:\.\d+)?)\s*[-~～–—至到]\s*(\d+(?:\.\d+)?)\s*(?:秒|[sS])`)

var timelineCut = regexp.MustCompile(`\bAt\s+(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?`)

func timelineOverrun(prompt string, seconds int) (float64, bool) {
	limit := float64(seconds) + 0.001
	worst := 0.0
	for _, loc := range timelineRange.FindAllStringSubmatchIndex(prompt, -1) {
		if clockOrFraction(prompt, loc[0]) || letterAfter(prompt, loc[1]) {
			continue
		}
		start, errStart := strconv.ParseFloat(prompt[loc[2]:loc[3]], 64)
		end, errEnd := strconv.ParseFloat(prompt[loc[4]:loc[5]], 64)
		if errStart != nil || errEnd != nil || end <= start {
			continue
		}
		worst = max(worst, end)
	}
	for _, m := range timelineCut.FindAllStringSubmatch(prompt, -1) {
		minutes, _ := strconv.Atoi(m[1])
		secs, _ := strconv.Atoi(m[2])
		at := float64(minutes*60 + secs)
		if m[3] != "" {
			frac, _ := strconv.ParseFloat("0."+m[3], 64)
			at += frac
		}
		worst = max(worst, at)
	}
	return worst, worst > limit
}

func clockOrFraction(text string, at int) bool {
	if at == 0 {
		return false
	}
	switch text[at-1] {
	case ':', '.':
		return true
	}
	return false
}

func letterAfter(text string, at int) bool {
	for _, r := range text[at:] {
		return r < unicode.MaxASCII && unicode.IsLetter(r)
	}
	return false
}
