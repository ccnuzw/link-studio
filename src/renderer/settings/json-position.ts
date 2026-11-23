export function jsonPosition(text: string, pointer: string) {
  const keys = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  const tokens = text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}[\]:,]|[^\s{}[\]:,]+/g);
  let token = tokens.next().value;
  let found = 0;
  function advance() {
    token = tokens.next().value;
  }
  function visit(depth: number, matches: boolean) {
    const opening = token?.[0];
    if (opening !== "{" && opening !== "[") {
      advance();
      return;
    }
    advance();
    let index = 0;
    while (token && token[0] !== "}" && token[0] !== "]") {
      const start = token.index;
      const key = opening === "{" ? JSON.parse(token[0]) : String(index);
      if (opening === "{") {
        advance();
        advance();
      }
      const match = matches && keys[depth] === key;
      if (match) found = start;
      visit(depth + 1, match);
      if (token?.[0] === ",") advance();
      index++;
    }
    advance();
  }
  visit(0, true);
  return found;
}
