export function locateJsonError(text: string): number | null {
  const length = text.length;
  let offset = 0;
  const skip = () => {
    while (offset < length && " \t\n\r".includes(text.charAt(offset))) offset++;
  };
  const string = () => {
    if (text[offset] !== '"') throw offset;
    offset++;
    while (offset < length) {
      const character = text.charAt(offset);
      if (character === '"') {
        offset++;
        return;
      }
      if (character < " ") throw offset;
      if (character === "\\") {
        const next = text[offset + 1];
        if (next === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(offset + 2, offset + 6))) throw offset;
          offset += 6;
        } else if (next !== undefined && '"\\/bfnrt'.includes(next)) offset += 2;
        else throw offset;
      } else offset++;
    }
    throw length;
  };
  const value = (): void => {
    skip();
    const character = text[offset];
    if (character === "{") {
      offset++;
      skip();
      if (text[offset] === "}") {
        offset++;
        return;
      }
      for (;;) {
        skip();
        string();
        skip();
        if (text[offset] !== ":") throw offset;
        offset++;
        value();
        skip();
        if (text[offset] === ",") {
          offset++;
          continue;
        }
        if (text[offset] === "}") {
          offset++;
          return;
        }
        throw offset;
      }
    }
    if (character === "[") {
      offset++;
      skip();
      if (text[offset] === "]") {
        offset++;
        return;
      }
      for (;;) {
        value();
        skip();
        if (text[offset] === ",") {
          offset++;
          continue;
        }
        if (text[offset] === "]") {
          offset++;
          return;
        }
        throw offset;
      }
    }
    if (character === '"') {
      string();
      return;
    }
    const number = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
    number.lastIndex = offset;
    const hit = number.exec(text);
    if (hit) {
      offset += hit[0].length;
      return;
    }
    for (const word of ["true", "false", "null"]) {
      if (text.startsWith(word, offset)) {
        offset += word.length;
        return;
      }
    }
    throw offset;
  };
  try {
    value();
    skip();
    return offset < length ? offset : null;
  } catch (at) {
    return typeof at === "number" ? at : null;
  }
}
