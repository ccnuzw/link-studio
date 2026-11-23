import { randomBytes } from "node:crypto";
import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";

type Fields = Record<string, unknown>;
const invalid = () => new ProviderError("AGENT_MODEL_INCOMPATIBLE");
function object(value: unknown): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Fields;
}

export function geminiEndpoint(endpoint: string, model: string) {
  const base = endpoint.replace(/\/+$/, "");
  const prefix = new URL(base).pathname.split("/").includes("antigravity")
    ? base
    : `${base}/antigravity`;
  return `${prefix}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
}

function cleanToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanToolSchema);
  if (!value || typeof value !== "object") return value;
  const node = { ...object(value) };
  const appendDescription = (suffix: string) => {
    node.description = String(node.description ?? "") + suffix;
  };
  if (Array.isArray(node.anyOf) && node.anyOf.length) {
    const branches = node.anyOf.map(object);
    const kind = branches[0]?.type;
    if (branches.some((branch) => branch.type !== kind)) {
      delete node.anyOf;
      delete node.enum;
      node.type = "string";
      appendDescription('（也可以写秒数，例如 "3.5"）');
    } else if (
      kind &&
      branches.every(
        (branch) =>
          (Object.hasOwn(branch, "const") || Array.isArray(branch.enum)) &&
          Object.keys(branch).every((key) =>
            ["type", "const", "enum", "description"].includes(key),
          ),
      )
    ) {
      delete node.anyOf;
      node.type = kind;
      node.enum = branches.flatMap((branch) =>
        Object.hasOwn(branch, "const") ? [branch.const] : (branch.enum as unknown[]),
      );
    }
  }
  for (const [min, max, suffix] of [
    ["minItems", "maxItems", " 项"],
    ["minimum", "maximum", ""],
  ] as const) {
    if (min in node && max in node) appendDescription(`（${node[min]} 到 ${node[max]}${suffix}）`);
    else if (min in node) appendDescription(`（至少 ${node[min]}）`);
    else if (max in node) appendDescription(`（最多 ${node[max]}）`);
    delete node[min];
    delete node[max];
  }
  for (const key of ["const", "$schema", "additionalProperties", "patternProperties"])
    delete node[key];
  for (const [key, child] of Object.entries(node)) {
    if (["properties", "$defs", "definitions"].includes(key)) {
      node[key] = Object.fromEntries(
        Object.entries(object(child)).map(([name, schema]) => [name, cleanToolSchema(schema)]),
      );
    } else if (!["default", "enum", "examples"].includes(key)) node[key] = cleanToolSchema(child);
  }
  return node;
}

function contentParts(content: unknown, allowVideo: boolean): Fields[] {
  if (content == null || content === "") return [];
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) throw invalid();
  return content.map((item) => {
    const part = object(item);
    if (part.type === "text" && typeof part.text === "string") return { text: part.text };
    if (part.type === "video") {
      if (!allowVideo) throw new ProviderError("AGENT_MODEL_CAPABILITY_UNSUPPORTED");
      const video = object(part.video);
      if (
        typeof video.mime_type !== "string" ||
        !/^video\/[\w.+-]+$/.test(video.mime_type) ||
        Boolean(video.url) === Boolean(video.data)
      )
        throw invalid();
      if (typeof video.url === "string" && video.url) {
        const url = URL.canParse(video.url) && new URL(video.url);
        if (!url || url.protocol !== "https:" || url.username || url.password) throw invalid();
        return { fileData: { mimeType: video.mime_type, fileUri: video.url } };
      }
      if (
        typeof video.data !== "string" ||
        video.data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(video.data)
      )
        throw invalid();
      return { inlineData: { mimeType: video.mime_type, data: video.data } };
    }
    if (part.type !== "image_url") throw invalid();
    const address = object(part.image_url).url;
    if (typeof address !== "string") throw invalid();
    const inline = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/]+=*)$/.exec(address);
    if (inline) return { inlineData: { mimeType: inline[1], data: inline[2] } };
    const url = URL.canParse(address) && new URL(address);
    if (!url || url.protocol !== "https:" || url.username || url.password) throw invalid();
    const extension =
      /\.(png|webp|gif|heic|heif)$/i.exec(url.pathname)?.[1]?.toLowerCase() ?? "jpeg";
    return { fileData: { mimeType: `image/${extension}`, fileUri: address } };
  });
}

export function geminiRequest(payload: Fields, allowVideo = false) {
  if (!Array.isArray(payload.messages) || !payload.messages.length) throw invalid();
  const system: Fields[] = [];
  const contents: { role: string; parts: Fields[] }[] = [];
  const names = new Map<string, string>();
  for (const message of payload.messages.map(object)) {
    const parts = contentParts(message.content, allowVideo);
    if (message.role === "system" || message.role === "developer") {
      system.push(...parts);
      continue;
    }
    let role = "user";
    if (message.role === "assistant") {
      role = "model";
      for (const call of (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(
        object,
      )) {
        const fn = object(call.function);
        if (typeof call.id !== "string" || typeof fn.name !== "string") throw invalid();
        const signature = /^gc_[a-z0-9]{8}_([\w-]+)$/.exec(call.id)?.[1];
        const args = object(JSON.parse(String(fn.arguments || "{}")));
        parts.push({
          functionCall: { name: fn.name, args },
          ...(signature && { thoughtSignature: Buffer.from(signature, "base64url").toString() }),
        });
        names.set(call.id, fn.name);
      }
    } else if (message.role === "tool") {
      const name = names.get(String(message.tool_call_id));
      if (!name || typeof message.content !== "string") throw invalid();
      parts.splice(0, parts.length, {
        functionResponse: { name, response: { content: message.content } },
      });
    } else if (message.role !== "user") throw invalid();
    if (!parts.length) continue;
    const previous = contents.at(-1);
    if (previous?.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts });
  }
  const functions =
    Array.isArray(payload.tools) &&
    payload.tools.map((tool) => {
      const fn = object(object(tool).function);
      return {
        name: fn.name,
        description: fn.description ?? "",
        parameters: cleanToolSchema(fn.parameters ?? { type: "object", properties: {} }),
      };
    });
  let functionCallingConfig: Fields | undefined;
  if (payload.tool_choice === "none") functionCallingConfig = { mode: "NONE" };
  else if (payload.tool_choice && typeof payload.tool_choice === "object") {
    const name = object(object(payload.tool_choice).function).name;
    if (typeof name !== "string" || !name) throw invalid();
    functionCallingConfig = { mode: "ANY", allowedFunctionNames: [name] };
  }
  const config = {
    maxOutputTokens: payload.max_tokens ?? payload.max_completion_tokens,
    temperature: payload.temperature,
    topP: payload.top_p,
    stopSequences: typeof payload.stop === "string" ? [payload.stop] : payload.stop,
  };
  return {
    contents,
    ...(system.length && { systemInstruction: { parts: system } }),
    ...(functions && functions.length && { tools: [{ functionDeclarations: functions }] }),
    ...(functionCallingConfig && { toolConfig: { functionCallingConfig } }),
    generationConfig: config,
  };
}

export function geminiStream() {
  let calls = 0;
  let finish = "";
  let usage: Fields | undefined;
  let seen = false;
  const frame = (data: Fields) => `data: ${JSON.stringify(data)}\n\n`;
  const choice = (delta: Fields, finish_reason?: string) =>
    frame({ choices: [{ index: 0, delta, finish_reason }] });
  let completed = false;
  function complete() {
    if (completed) return [];
    if (!seen) throw new ProviderError("AGENT_TEST_INVALID_STREAM");
    completed = true;
    return [
      choice({}, calls ? "tool_calls" : finish || "stop"),
      ...(usage ? [frame({ choices: [], usage })] : []),
      "data: [DONE]\n\n",
    ];
  }
  return {
    translate(event: string) {
      const payload = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (completed || !payload) return [];
      if (payload === "[DONE]") return complete();
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return [];
      }
      const body = object(parsed);
      if (body.error) throw new ProviderError("AGENT_TEST_HTTP_FAILED");
      if (body.usageMetadata) {
        seen = true;
        const meta = object(body.usageMetadata);
        const prompt = Number(meta.promptTokenCount ?? 0);
        const completion =
          Number(meta.candidatesTokenCount ?? 0) + Number(meta.thoughtsTokenCount ?? 0);
        usage = {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: prompt + completion,
          prompt_tokens_details: { cached_tokens: Number(meta.cachedContentTokenCount ?? 0) },
        };
      }
      if (!Array.isArray(body.candidates) || !body.candidates.length) {
        if (body.promptFeedback && object(body.promptFeedback).blockReason) {
          const reason = String(object(body.promptFeedback).blockReason);
          const allowed = [
            "SAFETY",
            "OTHER",
            "BLOCKLIST",
            "PROHIBITED_CONTENT",
            "IMAGE_SAFETY",
            "MODEL_ARMOR",
          ];
          seen = true;
          finish = "content_filter";
          return [
            choice({
              content: `请求被上游安全策略拦截（${allowed.includes(reason) ? reason : "未知原因"}）`,
            }),
            ...(body.usageMetadata ? complete() : []),
          ];
        }
        return finish && body.usageMetadata ? complete() : [];
      }
      seen = true;
      const candidate = object(body.candidates[0]);
      if (candidate.finishReason)
        finish =
          candidate.finishReason === "STOP"
            ? "stop"
            : candidate.finishReason === "MAX_TOKENS"
              ? "length"
              : "content_filter";
      const parts = candidate.content && object(candidate.content).parts;
      const frames: string[] = [];
      for (const part of (Array.isArray(parts) ? parts : []).map(object)) {
        if (typeof part.text === "string")
          frames.push(choice({ [part.thought ? "reasoning_content" : "content"]: part.text }));
        if (part.functionCall) {
          const fn = object(part.functionCall);
          const signature =
            typeof part.thoughtSignature === "string"
              ? `_${Buffer.from(part.thoughtSignature).toString("base64url")}`
              : "";
          frames.push(
            choice({
              tool_calls: [
                {
                  index: calls++,
                  id: `gc_${randomBytes(4).toString("hex")}${signature}`,
                  type: "function",
                  function: { name: fn.name, arguments: JSON.stringify(fn.args ?? {}) },
                },
              ],
            }),
          );
        }
      }
      return finish && body.usageMetadata ? [...frames, ...complete()] : frames;
    },
    complete,
  };
}
