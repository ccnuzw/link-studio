import { EditableModelDocument, type PluginView, requirePresent } from "@link-studio/core";
import { Value } from "@sinclair/typebox/value";
import { decodeModelBody } from "./model-document";

export const isModelObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const isLegacyModelDraft = (raw: Record<string, unknown>) =>
  Object.hasOwn(raw, "config") &&
  !["kind", "key", "label", "capabilities"].some((key) => Object.hasOwn(raw, key));

export function projectModelDraft(raw: Record<string, unknown>, plugins: readonly PluginView[]) {
  const binding =
    Array.isArray(raw.channels) && isModelObject(raw.channels[0]) ? raw.channels[0] : {};
  const base: Record<string, unknown> = {
    kind: "",
    label: "",
    sort: 0,
    channels: [{ channel: "", upstream_model: "" }],
  };
  const read = (body: Record<string, unknown>) => {
    const value = decodeModelBody(body, plugins);
    if (
      !Value.Check(EditableModelDocument, {
        config: value.config,
        pluginHash: value.pluginHash,
        settings: value.settings,
      })
    )
      return undefined;
    return value;
  };
  let body = base;
  let projected = requirePresent(read(base), "read(base)");
  const include = (field: string, value: unknown) => {
    const next = { ...body, [field]: value };
    try {
      const result = read(next);
      if (result) {
        body = next;
        projected = result;
      }
    } catch {
      return;
    }
  };
  for (const field of ["kind", "label", "hint", "sort", "vendor", "deadline", "idle_timeout"]) {
    if (Object.hasOwn(raw, field)) include(field, raw[field]);
  }
  if (Array.isArray(raw.tags))
    include(
      "tags",
      raw.tags.filter((value) => typeof value === "string"),
    );
  let channel: Record<string, unknown> = {
    channel: typeof binding.channel === "string" ? binding.channel : "",
    upstream_model: typeof binding.upstream_model === "string" ? binding.upstream_model : "",
  };
  include("channels", [channel]);
  for (const field of ["protocol", "api_format", "path_prefix", "studio_api"]) {
    if (!Object.hasOwn(binding, field)) continue;
    include("channels", [{ ...channel, [field]: binding[field] }]);
    channel = requirePresent(
      (body.channels as Record<string, unknown>[])[0],
      "(body.channels as Record<string, unknown>[])[0]",
    );
  }
  if (isModelObject(raw.capabilities)) {
    for (const field of [
      "ops",
      "refs",
      "prompt",
      "context",
      "system",
      "vision",
      "video",
      "prompt_format",
      "params",
    ]) {
      if (Object.hasOwn(raw.capabilities, field))
        include("capabilities", {
          ...(body.capabilities as Record<string, unknown>),
          [field]: raw.capabilities[field],
        });
    }
  }
  if (Object.hasOwn(raw, "pricing")) include("pricing", raw.pricing);
  return projected;
}

function mergeEdits(raw: unknown, before: unknown, after: unknown): unknown {
  if (JSON.stringify(before) === JSON.stringify(after)) return raw;
  if (isModelObject(before) && isModelObject(after)) {
    if (!isModelObject(raw)) return after;
    const entries = new Map(Object.entries(isModelObject(raw) ? raw : {}));
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!Object.hasOwn(after, key)) {
        const original = entries.get(key);
        if (isModelObject(original) && isModelObject(before[key])) {
          const rest = mergeEdits(original, before[key], {});
          if (isModelObject(rest) && Object.keys(rest).length) {
            entries.set(key, rest);
            continue;
          }
        }
        entries.delete(key);
      } else if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
        entries.set(key, mergeEdits(entries.get(key), before[key], after[key]));
    }
    const commonBefore = Object.keys(before).filter((key) => Object.hasOwn(after, key));
    const commonAfter = Object.keys(after).filter((key) => Object.hasOwn(before, key));
    if (JSON.stringify(commonBefore) === JSON.stringify(commonAfter))
      return Object.fromEntries(entries);
    const ordered = Object.keys(after).filter((key) => entries.has(key));
    let index = 0;
    return Object.fromEntries(
      [...entries.keys()].map((rawKey) => {
        const key = Object.hasOwn(after, rawKey)
          ? requirePresent(ordered[index++], "ordered[index++]")
          : rawKey;
        return [key, entries.get(key)];
      }),
    );
  }
  if (Array.isArray(before) && Array.isArray(after) && Array.isArray(raw)) {
    if (
      before.every((value) => !isModelObject(value)) &&
      after.every((value) => !isModelObject(value))
    )
      return after;
    const available = new Set(before.keys());
    const byValue = new Map<string, number[]>();
    for (let index = before.length - 1; index >= 0; index--) {
      const key = JSON.stringify(before[index]);
      if (!byValue.has(key)) byValue.set(key, []);
      requirePresent(byValue.get(key), "byValue.get(key)").push(index);
    }
    const origins = after.map((value) => {
      const origin = byValue.get(JSON.stringify(value))?.pop();
      if (origin !== undefined) available.delete(origin);
      return origin;
    });
    return after
      .map((value, index) => {
        const origin =
          origins[index] ?? (available.has(index) ? index : available.values().next().value);
        if (origin === undefined) return value;
        available.delete(origin);
        return mergeEdits(raw[origin], before[origin], value);
      })
      .concat(raw.slice(before.length));
  }
  return after;
}

export function editedModelText(draft: { document: string; text: string }, document: string) {
  if (draft.document === document) return draft.text;
  const raw = JSON.parse(draft.text);
  if (isLegacyModelDraft(raw)) return document;
  return JSON.stringify(mergeEdits(raw, JSON.parse(draft.document), JSON.parse(document)), null, 2);
}
