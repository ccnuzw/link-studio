package dramaoutput

import (
	"strconv"
	"strings"
)

type AdaptAsset struct {
	NodeID string
	Name   string
}
type AdaptOutput struct {
	Prompt string `json:"prompt"`
}

func (o AdaptOutput) Validate() error {
	if !nonemptyText(o.Prompt) {
		return invalidOutput("prompt 不能为空")
	}
	return nil
}

func PromptAssets(prompt string) []AdaptAsset {
	out := []AdaptAsset{}
	seen := map[string]bool{}
	for _, m := range storyboardMention.FindAllStringSubmatch(prompt, -1) {
		if seen[m[2]] {
			continue
		}
		seen[m[2]] = true
		out = append(out, AdaptAsset{NodeID: m[2], Name: m[1]})
	}
	return out
}

var h3Fields = []string{"integrated_multimodal_description:", "overall_soundscape:", "non_diegetic_music:"}

func ValidateAdapt(format, source, adapted string, seconds int) error {
	if !nonemptyText(adapted) {
		return invalidOutput("prompt 不能为空")
	}
	want := map[string]string{}
	for _, a := range PromptAssets(source) {
		want[a.NodeID] = a.Name
	}
	got := map[string]bool{}
	for _, a := range PromptAssets(adapted) {
		if _, ok := want[a.NodeID]; !ok {
			return invalidOutput("出现了原稿没有的引用 @[" + a.Name + "](" + a.NodeID + ")，只能使用原稿里的引用")
		}
		got[a.NodeID] = true
	}
	for id, name := range want {
		if !got[id] {
			return invalidOutput("丢了原稿里的引用 @[" + name + "](" + id + ")，每个引用都要原样保留至少一次")
		}
	}
	if format == "h3" {
		for _, field := range h3Fields {
			if !strings.Contains(adapted, field) {
				return invalidOutput("缺少字段 " + strings.TrimSuffix(field, ":"))
			}
		}
	}
	if end, over := timelineOverrun(adapted, seconds); over {
		return invalidOutput("时间轴写到" + strconv.FormatFloat(end, 'f', -1, 64) + "秒，超过片段时长" + strconv.Itoa(seconds) + "秒")
	}
	return nil
}
