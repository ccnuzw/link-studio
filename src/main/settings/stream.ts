type Redactor = { secrets: string[]; redact(value: string): string };
type Delta = Record<string, unknown>;

export function cleanModelStream(
  { secrets, redact }: Redactor,
  responses = false,
  observe?: (data: unknown) => void,
) {
  const pending = new Map<string, string>();

  function split(key: string, target: Delta, field: string) {
    const fragment = target[field];
    if (typeof fragment !== "string") return;
    const value = (pending.get(key) ?? "") + fragment;
    pending.delete(key);
    let tail = "";
    let output = "";
    for (let index = 0; index < value.length; ) {
      const secret = secrets.find((entry) => value.startsWith(entry, index));
      if (secret) {
        output += "[凭证已移除]";
        index += secret.length;
      } else {
        const remainder = value.length - index;
        if (
          secrets.some((entry) => entry.length > remainder && entry.startsWith(value.slice(index)))
        ) {
          tail = value.slice(index);
          break;
        }
        output += value[index];
        index++;
      }
    }
    if (tail) pending.set(key, tail);
    target[field] = redact(output);
  }

  return (frame: string) => {
    const raw = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!raw) return "";
    if (raw === "[DONE]") return "data: [DONE]\n\n";
    const data = JSON.parse(raw);
    const streamedFields = new Set<Delta>();
    if (responses && typeof data?.type !== "string") throw new Error("Invalid Responses event");
    if (responses && typeof data.delta === "string") {
      split(
        `${data.type}:${data.output_index}:${data.content_index ?? data.summary_index}`,
        data,
        "delta",
      );
      streamedFields.add(data);
    }
    if (Array.isArray(data?.choices)) {
      for (const choice of data.choices) {
        const delta = choice.delta;
        if (!delta || typeof delta !== "object") continue;
        for (const field of ["content", "reasoning", "reasoning_content"])
          split(`${choice.index}:${field}`, delta, field);
        streamedFields.add(delta);
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            if (call.function && typeof call.function === "object") {
              for (const field of ["name", "arguments"])
                split(`${choice.index}:tool:${call.index}:${field}`, call.function, field);
              streamedFields.add(call.function);
            }
          }
        }
        if (choice.finish_reason) {
          for (const key of pending.keys())
            if (key.startsWith(`${choice.index}:`)) pending.delete(key);
        }
      }
    }
    const type = responses ? redact(data.type) : "";
    observe?.(data);
    const event = /^[a-z_.]+$/.test(type) ? `event: ${type}\n` : "";
    return `${event}data: ${JSON.stringify(data, function (this: Delta, field, value) {
      if (typeof value !== "string") return value;
      if (
        streamedFields.has(this) &&
        ["content", "reasoning", "reasoning_content", "name", "arguments", "delta"].includes(field)
      )
        return value;
      return redact(value);
    })}\n\n`;
  };
}
