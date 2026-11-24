type Redactor = { secrets: string[]; redact(value: string): string };
type Delta = Record<string, unknown>;

export function cleanModelStream(
  { secrets, redact }: Redactor,
  responses = false,
  observe?: (data: unknown) => void,
  offeredTools: ReadonlySet<string> = new Set(),
) {
  const pending = new Map<string, string>();
  const names = new Map<number, Map<number, string>>();

  function remainingCalls(choice: number) {
    const calls = Array.from(names.get(choice) ?? [], ([index, name]) => ({
      index,
      function: { name: redact(name) },
    }));
    names.delete(choice);
    return calls;
  }

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
    if (raw === "[DONE]") {
      const choices = Array.from(names.keys(), (index) => ({
        index,
        delta: { tool_calls: remainingCalls(index) },
      }));
      return (
        (choices.length ? `data: ${JSON.stringify({ choices })}\n\n` : "") + "data: [DONE]\n\n"
      );
    }
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
        const choiceIndex = choice.index ?? 0;
        if (!choice.delta && choice.finish_reason && names.has(choiceIndex)) choice.delta = {};
        const delta = choice.delta;
        if (!delta || typeof delta !== "object") continue;
        for (const field of ["content", "reasoning", "reasoning_content"])
          split(`${choiceIndex}:${field}`, delta, field);
        streamedFields.add(delta);
        if (Array.isArray(delta.tool_calls)) {
          for (const [offset, call] of delta.tool_calls.entries()) {
            if (call.function && typeof call.function === "object") {
              const index = call.index ?? offset;
              call.index = index;
              const fn = call.function;
              if (typeof fn.name === "string" && fn.name) {
                const calls = names.get(choiceIndex) ?? new Map<number, string>();
                calls.set(index, (calls.get(index) ?? "") + fn.name);
                names.set(choiceIndex, calls);
                delete fn.name;
              }
              const calls = names.get(choiceIndex);
              const name = calls?.get(index);
              if (
                calls &&
                name &&
                (choice.finish_reason || (fn.arguments && offeredTools.has(name)))
              ) {
                fn.name = redact(name);
                calls.delete(index);
                if (!calls.size) names.delete(choiceIndex);
              }
              split(`${choiceIndex}:tool:${index}:arguments`, fn, "arguments");
              streamedFields.add(call.function);
            }
          }
        }
        if (choice.finish_reason) {
          if (names.has(choiceIndex)) {
            if (!Array.isArray(delta.tool_calls)) delta.tool_calls = [];
            delta.tool_calls.push(...remainingCalls(choiceIndex));
          }
          for (const key of pending.keys())
            if (key.startsWith(`${choiceIndex}:`)) pending.delete(key);
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
