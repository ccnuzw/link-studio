export function episodeLabel(numbers: readonly number[] | null) {
  if (!numbers) return "未分类";
  if (!numbers.length) return "全集";
  const runs: number[][] = [];
  for (const no of [...new Set(numbers)].sort((first, second) => first - second)) {
    const last = runs.at(-1);
    if (last && last.at(-1) === no - 1) last.push(no);
    else runs.push([no]);
  }
  return `第 ${runs.map((run) => (run.length === 1 ? run[0] : `${run[0]}–${run.at(-1)}`)).join("、")} 集`;
}
