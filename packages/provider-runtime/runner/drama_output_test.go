package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDramaAssetOutput(t *testing.T) {
	asset := `{"assets":[{"type":"prop","name":"纸条","look":"","description":"一张折过的纸","voice_prompt":"","aliases":[],"episodes":[1]}]}`
	prompts := `{"prompts":[{"node_id":"note","prompt":"一张折过的纸"}]}`
	scope := json.RawMessage(`{"episodes":[1],"nodes":["note"]}`)
	for _, test := range []struct{ step, text, failure string }{
		{"breakdown", "<think>核对集号</think>纸条", ""},
		{"breakdown_format", "```json\n" + asset + "\n```", ""},
		{"breakdown_format", strings.Replace(asset, `"name":`, `"name":"纸条","name":`, 1), "重复"},
		{"breakdown_format", strings.Replace(asset, "[1]", "[2]", 1), "不属于本次范围"},
		{"asset_prompts_format", prompts, ""},
		{"asset_prompts_format", strings.Replace(prompts, "note", "old", 1), "非本次资产节点"},
		{"asset_prompts_format", strings.Replace(prompts, "一张折过的纸", "16:9 纸条", 1), "不得写画面比例"},
	} {
		step, _ := json.Marshal(test.step)
		text, _ := json.Marshal(test.text)
		result := decodeDramaAssetOutput([]json.RawMessage{step, text, scope})
		if result.OK != (test.failure == "") || !strings.Contains(result.Code, test.failure) {
			t.Errorf("%s %s: %+v", test.step, test.text, result)
		}
	}
}

func TestAdaptSegmentOutput(t *testing.T) {
	scope := json.RawMessage(`{"source_prompt":"@[信使](n1)开门", "max_seconds":5}`)
	valid := "integrated_multimodal_description: @[信使](n1) At 00:04.250 overall_soundscape: rain non_diegetic_music: none"
	for _, test := range []struct{ format, prompt, failure string }{
		{"h3", valid, ""}, {"generic", "@[信使](n1)开门", ""},
		{"h3", strings.Replace(valid, "@[信使](n1)", "信使", 1), "丢了原稿里的引用"},
		{"generic", valid + "@[街道](n2)", "原稿没有的引用"},
		{"h3", strings.Replace(valid, "overall_soundscape:", "sound:", 1), "缺少字段"},
		{"generic", valid + " At 00:05.125", "超过片段时长"},
	} {
		step, _ := json.Marshal("adapt_" + test.format)
		object, _ := json.Marshal(map[string]string{"prompt": test.prompt})
		text, _ := json.Marshal(string(object))
		result := decodeDramaAssetOutput([]json.RawMessage{step, text, scope})
		if result.OK != (test.failure == "") || !strings.Contains(result.Code, test.failure) {
			t.Errorf("%s %s: %+v", test.format, test.prompt, result)
		}
	}
}
