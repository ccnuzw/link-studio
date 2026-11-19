export function isTrustedDocument(candidate: string, expected: string): boolean {
  try {
    const candidateUrl = new URL(candidate);
    const expectedUrl = new URL(expected);
    candidateUrl.hash = "";
    expectedUrl.hash = "";
    return candidateUrl.href === expectedUrl.href;
  } catch {
    return false;
  }
}
