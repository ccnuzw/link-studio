import { tokenCredits } from "../../packages/link-studio-core/src/model-price.ts";

export type TokenUsage = { input_tokens: number; output_tokens: number };
export type JobPrice = { quotedCredits?: number; tokenRates?: { input: number; output: number } };

export function readTokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const input = usage.input_tokens ?? usage.prompt_tokens,
    output = usage.output_tokens ?? usage.completion_tokens;
  if (!Number.isSafeInteger(input) && !Number.isSafeInteger(output)) return undefined;
  const count = (tokens: unknown) =>
    typeof tokens === "number" && Number.isSafeInteger(tokens) ? Math.max(0, tokens) : 0;
  return { input_tokens: count(input), output_tokens: count(output) };
}

export function settleJobCredits(price: JobPrice, usages: readonly (TokenUsage | undefined)[]) {
  const { quotedCredits, tokenRates } = price;
  if (quotedCredits === undefined || !tokenRates) return quotedCredits;
  const reported = usages.filter((usage): usage is TokenUsage => !!usage);
  if (!reported.length) return quotedCredits;
  return Math.min(
    quotedCredits,
    tokenCredits(
      tokenRates.input,
      tokenRates.output,
      reported.reduce((sum, usage) => sum + usage.input_tokens, 0),
      reported.reduce((sum, usage) => sum + usage.output_tokens, 0),
    ),
  );
}
