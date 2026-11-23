package main

import (
	"encoding/json"
	"testing"
)

func TestMethodStepSamplesAndMedia(t *testing.T) {
	run := func(input map[string]any) map[string]any {
		t.Helper()
		args, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		result := methodStep([]json.RawMessage{args})
		if !result.OK {
			t.Fatal(result.Code)
		}
		var value map[string]any
		if err := json.Unmarshal(result.Result, &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	catalog := run(map[string]any{"action": "catalog"})
	steps := catalog["protocols"].([]any)
	if len(steps) != 4 || len(catalog["formatters"].([]any)) != 3 {
		t.Fatal("incomplete catalog")
	}
	for _, item := range steps {
		step := item.(map[string]any)
		for _, entry := range step["samples"].([]any) {
			sample := entry.(map[string]any)
			for _, video := range []bool{false, true} {
				args := map[string]any{"step": step["key"], "sample": sample["key"], "video": video, "action": "prepare"}
				packed := run(args)
				if packed["prompt"] == "" || (packed["video"] != nil) != (video && step["media"] == "video") || (packed["images"] != nil) != (step["media"] == "images" || !video && step["media"] == "video") {
					t.Fatalf("wrong method media: %v %v", step["key"], sample["key"])
				}
				args["action"] = "validate"
				args["output"] = "{}"
				if len(run(args)["errors"].([]any)) == 0 {
					t.Fatal("missing fields accepted")
				}
			}
		}
	}
}
