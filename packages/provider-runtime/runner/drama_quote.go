package main

import (
	"encoding/json"

	"link-studio/provider-runner/modelcfg"
)

type dramaQuoteScope struct {
	Step         string `json:"step"`
	ContextChars int    `json:"context_chars"`
	Episodes     []int  `json:"episode_chars"`
}

func dramaJobQuote(args []json.RawMessage) response {
	if len(args) != 2 {
		return response{Code: "AGENT_ARGUMENT_INVALID"}
	}
	config, issues := modelcfg.ParseModel(args[0])
	if config == nil || len(issues) != 0 || config.Kind != "agent" {
		return response{Code: "DRAMA_NO_TEXT_MODEL"}
	}
	var scope dramaQuoteScope
	if json.Unmarshal(args[1], &scope) != nil || scope.ContextChars < 0 || scope.ContextChars > 10000000 || len(scope.Episodes) < 1 || len(scope.Episodes) > 200 {
		return response{Code: "AGENT_ARGUMENT_INVALID"}
	}
	for _, chars := range scope.Episodes {
		if chars < 0 || chars > 5000000 {
			return response{Code: "AGENT_ARGUMENT_INVALID"}
		}
	}
	price := func(chars int) int {
		return modelcfg.Quote(config.Pricing, config.Capabilities, modelcfg.Spec{PromptChars: scope.ContextChars + 4096 + chars, Params: map[string]any{}})
	}
	credits := 0
	limit := 12000
	if context := config.Capabilities.Context; context != nil && context.Window > 0 {
		limit = max(1, context.Window*60/100)
	}
	switch scope.Step {
	case "analyze":
		chars := min(40000, scope.ContextChars, limit) + 2048
		credits = modelcfg.Quote(config.Pricing, config.Capabilities, modelcfg.Spec{PromptChars: chars, Params: map[string]any{}})
	case "scripts":
		credits = 2 * len(scope.Episodes) * price(0)
	case "plan":
		credits = 2 * modelcfg.Quote(config.Pricing, config.Capabilities, modelcfg.Spec{PromptChars: 4096 + min(30000, scope.ContextChars), Params: map[string]any{}})
	case "asset_prompts":
		credits = 2 * price(0)
	case "storyboard":
		if len(scope.Episodes) != 1 {
			return response{Code: "AGENT_ARGUMENT_INVALID"}
		}
		credits = price(scope.Episodes[0]) + price(2*scope.Episodes[0])
	case "breakdown":
		budget := min(30000, limit-8192)
		count, size := 0, 0
		for _, chars := range scope.Episodes {
			if count > 0 && (count == 12 || size+chars > budget) {
				credits += 4 * price(size)
				count, size = 0, 0
			}
			count++
			size += chars
		}
		credits += 4 * price(size)
	default:
		return response{Code: "AGENT_ARGUMENT_INVALID"}
	}
	result, _ := json.Marshal(credits)
	return response{OK: true, Result: result}
}
