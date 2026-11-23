export const maxAgentBudget = 100_000;

export function isAgentBudget(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maxAgentBudget
  );
}

export function generationQuoteSummary(items: readonly unknown[]) {
  let known = 0,
    missing = 0;
  for (const item of items) {
    const price = (item as { price?: unknown } | null)?.price;
    if (typeof price === "number" && Number.isSafeInteger(price) && price >= 0) known += price;
    else missing++;
  }
  return { known, missing };
}

export function approvedQuoteHasMissing(items: readonly unknown[], votes: unknown) {
  if (!Array.isArray(votes) || !votes.length) return generationQuoteSummary(items).missing > 0;
  const selected = votes.filter((vote) => vote?.approve === true && Number.isInteger(vote.index));
  return generationQuoteSummary(selected.map((vote) => items[vote.index])).missing > 0;
}
