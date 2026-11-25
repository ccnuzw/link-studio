import { modelContextLimits } from "../../../packages/link-studio-core/src/model-config.ts";
import type { SettingsValues } from "../../../packages/link-studio-core/src/settings-api.ts";
import limits from "../../../resources/model-meta/limits.json" with { type: "json" };
import modalities from "../../../resources/model-meta/modalities.json" with { type: "json" };

const strip = (name: string) =>
  name.replace(/-latest$/, "").replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{6})$/, "");

function index<Scalar>(snapshot: Record<string, Scalar[]>) {
  const exact = new Map(Object.entries(snapshot));
  const series = new Map<string, string>();
  for (const name of exact.keys()) {
    const family = strip(name);
    if (name > (series.get(family) ?? "")) series.set(family, name);
  }
  return (name: string) =>
    exact.get(name) ?? exact.get(strip(name)) ?? exact.get(series.get(strip(name)) ?? "");
}

const context = index<number>(limits);
const media = index<boolean>(modalities);

function clamp(window: number, output: number) {
  if (window < 1 || window > modelContextLimits.window) return;
  output = Math.min(output, modelContextLimits.output);
  if (output >= window) output = Math.floor(window / 2);
  if (output >= modelContextLimits.minOutput) return { window, output };
}

export function resolveModelLimits(
  id: string,
  upstream?: { window: number; output: number },
): SettingsValues["modelLimits"] {
  const normalized = id.trim().toLowerCase();
  const [base = ""] = normalized.slice(normalized.lastIndexOf("/") + 1).split(/[:@]/, 1);
  const name = base.trim();
  const inputs = media(name);
  const suggestion = inputs ? { vision: inputs[0], video: inputs[1] } : {};
  const fromChannel =
    upstream && upstream.output < upstream.window && clamp(upstream.window, upstream.output);
  if (fromChannel) return { found: true, source: "upstream", ...fromChannel, ...suggestion };
  const [window, output] = context(name) ?? [];
  const local = window === undefined || output === undefined ? undefined : clamp(window, output);
  return local
    ? { found: true, source: "builtin", ...local, ...suggestion }
    : { found: false, ...suggestion };
}
