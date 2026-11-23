export function hasAsciiControl(value: string) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function sanitizeFileName(value: string, replacement = "_") {
  return Array.from(value, (character) =>
    hasAsciiControl(character) || /[\\/:*?"<>|]/.test(character) ? replacement : character,
  ).join("");
}
