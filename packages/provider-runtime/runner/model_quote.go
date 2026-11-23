package main

import (
	"encoding/json"
	"strings"

	"link-studio/provider-runner/modelcfg"
)

func modelQuote(args []json.RawMessage) response {
	if len(args) != 2 {
		return response{Code: "AGENT_ARGUMENT_INVALID"}
	}
	config, issues := modelcfg.ParseModel(args[0])
	if config == nil || len(issues) > 0 {
		return quoteIssues("模型配置未通过校验", issues)
	}
	var input map[string]any
	if json.Unmarshal(args[1], &input) != nil {
		return response{Code: "AGENT_ARGUMENT_INVALID"}
	}
	if input == nil {
		input = map[string]any{}
	}
	if prompt, ok := input["prompt"].(string); input["prompt"] == nil || (ok && strings.TrimSpace(prompt) == "") {
		input["prompt"] = "估"
	}
	normalized, failures := modelcfg.ValidateInput(config.Kind, config.Capabilities, input)
	if len(failures) > 0 {
		return quoteIssues("输入未通过校验", failures)
	}
	price := modelcfg.Quote(config.Pricing, config.Capabilities, modelcfg.SpecFromInput(normalized, ""))
	count := modelcfg.FanoutCount(config.Capabilities, normalized)
	result, err := json.Marshal(map[string]any{"per_task_credits": price, "count": count, "quote_credits": price * count, "billing": config.Pricing.Billing, "input": normalized})
	if err != nil {
		return response{Code: "AGENT_ARGUMENT_INVALID"}
	}
	return response{OK: true, Result: result}
}

func quoteIssues(message string, issues any) response {
	result, _ := json.Marshal(map[string]any{"error": message, "issues": issues})
	return response{OK: true, Result: result}
}
