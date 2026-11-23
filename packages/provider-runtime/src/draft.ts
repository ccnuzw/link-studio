import { type Binding, buildHostRequest, type HostRequest, type ReferenceMedia } from "./host.ts";
import { inspectPlugin, type PluginInfo, validateContext, validateResult } from "./plugin.ts";
import { type PluginRunner, ProviderError, record } from "./runner.ts";

function describeTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(describeTree);
  if (!value || typeof value !== "object") return value;
  const object = record(value);
  if (Object.hasOwn(object, "__fileRef"))
    return {
      __fileRef: object.__fileRef,
      as: object.as ?? "url",
      ...(object.filed === true && { filed: true }),
    };
  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => [key, describeTree(child)]),
  );
}

function describeFields(fields: unknown) {
  return Object.fromEntries(
    Object.entries(record(fields ?? {})).flatMap(([name, value]) => {
      if (value === null) return [];
      if (typeof value !== "object") return [[name, String(value)]];
      if (!Object.hasOwn(value, "__fileRef")) throw new ProviderError("PLUGIN_REQUEST_INVALID");
      return [[name, describeTree(value)]];
    }),
  );
}

function describeRequest(
  built: HostRequest,
  descriptor: Record<string, unknown>,
  plugin: PluginInfo,
  baseUrl: string,
) {
  const url = new URL(built.url);
  const headers = { ...record(descriptor.headers ?? {}) };
  if (url.origin === new URL(baseUrl).origin) {
    const auth = record(descriptor.auth ?? plugin.auth);
    if (auth.type === "bearer") headers.Authorization = "••••";
    if (auth.type === "header") headers[String(auth.name)] = "••••";
    if (auth.type === "query") url.searchParams.set(String(auth.name), "••••");
  }
  let body: unknown = null;
  if (descriptor.json !== undefined) body = describeTree(descriptor.json);
  if (descriptor.form !== undefined) body = describeFields(descriptor.form);
  if (descriptor.multipart !== undefined) {
    const multipart = record(descriptor.multipart);
    const parts = (multipart.parts as unknown[]).map((value) => {
      const { name, fileRef, filename } = record(value);
      return { name, fileRef, filename: filename ?? "" };
    });
    body = { fields: describeFields(multipart.fields), parts };
  }
  return { method: built.method, url: url.href, headers, body };
}

export async function checkDraft(
  runner: PluginRunner,
  source: string,
  sample?: string,
  inspected?: PluginInfo,
) {
  const plugin = inspected ?? (await inspectPlugin(runner, source));
  const checkedHooks: string[] = [];
  const issues: string[] = [];
  const logs: string[] = [];
  const inputMedia: Record<string, number> = {};
  const parsedResponses: Record<string, unknown> = {};
  let request: ReturnType<typeof describeRequest> | undefined;
  const result = () => ({
    ok: issues.length === 0,
    checkedHooks,
    inputMedia,
    issues,
    logs,
    unknownHooks: plugin.unknownHooks ?? [],
    ...(request && { request }),
    ...(inspected && Object.keys(parsedResponses).length && { parsed: parsedResponses }),
  });
  const kind = plugin.kind;
  if (kind === "agent") {
    issues.push("Agent 走原生网关，不执行插件钩子");
    return result();
  }
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
    if (channel.baseUrl !== undefined) {
      const endpoint = new URL(String(channel.baseUrl));
      if (
        !["https:", "http:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password
      )
        throw new ProviderError("PLUGIN_SAMPLE_INVALID");
      binding.baseUrl = String(channel.baseUrl);
    }
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
      channel: {
        baseUrl: binding.baseUrl,
        settings: { ...defaults, ...record(channel.settings ?? {}) },
      },
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
      if (inspected && hook === "parseSubmitResponse") parsedResponses.submit = trace.result;
      if (inspected && hook === "parseQueryResponse") parsedResponses.query = trace.result;
      checkedHooks.push(hook);
    } catch (error) {
      issues.push(
        `${hook} · ${error instanceof ProviderError ? error.code : "PLUGIN_SAMPLE_INVALID"}`,
      );
    }
  };
  await check("buildSubmitRequest", [context], async (value) => {
    const built = await buildHostRequest(value, plugin, binding, context);
    if (inspected) request = describeRequest(built, record(value), plugin, binding.baseUrl);
  });
  if (Object.hasOwn(responses, "submit"))
    await check("parseSubmitResponse", [context, responses.submit], (value) => {
      const parsed = record(value);
      if (parsed.immediate !== undefined) return validateResult(parsed.immediate, kind);
      if (
        plugin.mode !== "async" ||
        !["number", "string"].includes(typeof parsed.providerTaskId) ||
        !String(parsed.providerTaskId).trim()
      )
        throw new ProviderError("PLUGIN_RESULT_INVALID");
    });
  if (plugin.hooks.includes("parseQueryResponse") && Object.hasOwn(responses, "query"))
    await check("parseQueryResponse", [context, responses.query], (value) =>
      validateResult(value, kind),
    );
  return result();
}
