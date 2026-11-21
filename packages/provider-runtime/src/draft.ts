import { type Binding, buildHostRequest, type ReferenceMedia } from "./host.ts";
import { inspectPlugin, validateContext, validateResult } from "./plugin.ts";
import { type PluginRunner, ProviderError, record } from "./runner.ts";

export async function checkDraft(runner: PluginRunner, source: string, sample?: string) {
  const plugin = await inspectPlugin(runner, source);
  const checkedHooks: string[] = [];
  const issues: string[] = [];
  const logs: string[] = [];
  const inputMedia: Record<string, number> = {};
  const result = () => ({
    ok: issues.length === 0,
    checkedHooks,
    inputMedia,
    issues,
    logs,
    unknownHooks: plugin.unknownHooks ?? [],
  });
  const baseUrl = "https://example.invalid";
  const media: Record<string, ReferenceMedia> = {};
  const binding: Binding = {
    source,
    approvedHash: plugin.hash,
    baseUrl,
    secret: "offline-key|offline-secret",
    media,
  };
  let context: Record<string, unknown>;
  let responses: Record<string, unknown>;
  try {
    const values = sample ? record(JSON.parse(sample)) : {};
    const defaults = Object.fromEntries(
      Object.entries(record(plugin.meta.channelSettings ?? {})).flatMap(([name, value]) =>
        record(value).default === undefined ? [] : [[name, record(value).default]],
      ),
    );
    const channel = record(values.channel ?? {});
    const input = record(values.input ?? { prompt: "离线检查", op: "t2v" });
    for (const [name, mime] of [
      ["images", "image/png"],
      ["videos", "video/mp4"],
      ["audios", "audio/mpeg"],
    ] as const) {
      const slots = Object.hasOwn(input, name) ? input[name] : [];
      if (!Array.isArray(slots) || slots.length > 20)
        throw new ProviderError("MEDIA_REFERENCE_INVALID");
      inputMedia[name] = slots.length;
      if (slots.length)
        input[name] = slots.map((slot, index) => {
          const reference = `input:${name}.${index}`;
          if (
            !(
              typeof slot === "string" &&
              slot.trim() &&
              (!slot.startsWith("input:") || slot === reference)
            ) &&
            !(typeof slot === "number" && Number.isSafeInteger(slot) && slot > 0)
          )
            throw new ProviderError("MEDIA_REFERENCE_INVALID");
          media[reference] = {
            mime,
            filename: `sample.${mime.split("/")[1]}`,
            bytes: Buffer.from("offline-media"),
            url: `${baseUrl}/media/${name}/${index}`,
          };
          return reference;
        });
    }
    context = validateContext({
      kind: plugin.kind,
      now: 1760000000,
      channel: { baseUrl, settings: { ...defaults, ...record(channel.settings ?? {}) } },
      model: { upstreamModel: "sample", ...record(values.model ?? {}) },
      input,
      task: { providerTaskId: "sample", ...record(values.task ?? {}) },
      ...(values.prepared !== undefined && { prepared: values.prepared }),
    });
    responses = record(values.responses ?? {});
  } catch {
    issues.push("PLUGIN_SAMPLE_INVALID");
    return result();
  }
  if (plugin.auth.type === "custom")
    context.credentials = { apiKey: binding.secret, secretKey: "offline-secret" };
  const check = async (hook: string, args: unknown[], validate: (value: unknown) => unknown) => {
    try {
      const trace = await runner.trace(source, hook, args);
      logs.push(...trace.logs.slice(0, 50 - logs.length));
      await validate(trace.result);
      checkedHooks.push(hook);
    } catch (error) {
      issues.push(
        `${hook} · ${error instanceof ProviderError ? error.code : "PLUGIN_SAMPLE_INVALID"}`,
      );
    }
  };
  await check("buildSubmitRequest", [context], (value) =>
    buildHostRequest(value, plugin, binding, context),
  );
  if (Object.hasOwn(responses, "submit"))
    await check("parseSubmitResponse", [context, responses.submit], (value) => {
      const parsed = record(value);
      if (parsed.immediate !== undefined) return validateResult(parsed.immediate, plugin.kind);
      if (
        plugin.mode !== "async" ||
        !["number", "string"].includes(typeof parsed.providerTaskId) ||
        !String(parsed.providerTaskId).trim()
      )
        throw new ProviderError("PLUGIN_RESULT_INVALID");
    });
  if (plugin.hooks.includes("parseQueryResponse") && Object.hasOwn(responses, "query"))
    await check("parseQueryResponse", [context, responses.query], (value) =>
      validateResult(value, plugin.kind),
    );
  return result();
}
