package main

import (
	"context"
	"encoding/json"
	"link-studio/provider-runner/marketing"
	"link-studio/provider-runner/marketing/format"
	"link-studio/provider-runner/stepkit"
)

func methodStep(args []json.RawMessage) response {
	registry := stepkit.NewRegistry()
	marketing.RegisterSteps(registry)
	result := func(value any) response {
		raw, err := json.Marshal(value)
		if err != nil {
			return response{Code: "PLUGIN_RESULT_INVALID"}
		}
		return response{OK: true, Result: raw}
	}
	var input struct {
		Step, Sample, Action string
		Method               stepkit.Method
		Feedback             []string
		Output               string
		Input                *stepkit.Input
		Video                bool
	}
	if len(args) != 1 || json.Unmarshal(args[0], &input) != nil {
		return response{Code: "AGENT_ARGUMENT_INVALID"}
	}
	if input.Action == "catalog" {
		items := []any{}
		for _, step := range registry.List() {
			samples := []any{}
			for _, sample := range step.Samples {
				samples = append(samples, map[string]string{"key": sample.Key, "name": sample.Name})
			}
			items = append(items, map[string]any{"key": step.Key, "title": step.Title, "duty": step.Duty, "media": step.Media, "samples": samples, "schema": step.Schema, "rules": step.Rules, "inputs": step.Inputs})
		}
		formats := []any{}
		for _, formatter := range format.All() {
			formats = append(formats, map[string]string{"key": formatter.Key(), "name": formatter.Name(), "description": formatter.Description(), "preview": format.SampleOf(formatter)})
		}
		return result(map[string]any{"protocols": items, "formatters": formats})
	}
	step, ok := registry.Get(input.Step)
	if !ok {
		return response{Code: "未知环节"}
	}
	var data stepkit.Input
	if input.Input != nil {
		data = *input.Input
	} else {
		sample, ok := step.Sample(input.Sample)
		if !ok {
			return response{Code: "未知样例"}
		}
		var err error
		data, err = sample.Build(context.Background())
		if err != nil {
			return response{Code: "样例不可用"}
		}
	}
	if input.Action == "validate" {
		out, err := stepkit.ExtractJSON(input.Output)
		if err != nil {
			return result(map[string]any{"errors": stepkit.ErrorList(err)})
		}
		if errs := stepkit.CheckSchema(step.Schema, out); len(errs) > 0 {
			return result(map[string]any{"errors": errs})
		}
		flags, err := step.Validate(out, data)
		if err != nil {
			return result(map[string]any{"errors": stepkit.ErrorList(err)})
		}
		return result(map[string]any{"preview": step.Preview(out), "flags": flags, "output": out})
	}
	if input.Action != "prepare" {
		return response{Code: "AGENT_ARGUMENT_INVALID"}
	}
	method := input.Method
	if method.Source != "skill" {
		method = stepkit.BuiltinMethod(step)
	}
	if step.Media == stepkit.MediaNone {
		data.Video = nil
		data.Images = nil
	} else if step.Media == stepkit.MediaVideo && input.Video && data.Video != nil {
		data.Images = nil
	} else {
		data.Video = nil
	}
	prompt, err := stepkit.BuildPrompt(step, method, data, input.Feedback)
	if err != nil {
		return response{Code: err.Error()}
	}
	return result(map[string]any{"prompt": prompt, "images": data.Images, "video": data.Video, "media": step.Media})
}
