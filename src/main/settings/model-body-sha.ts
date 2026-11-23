import { createHash } from "node:crypto";
import { canonicalJson } from "../project/encoding.ts";

export function modelBodySha(body: object): string {
  const json = canonicalJson(body).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return createHash("sha256").update(json).digest("hex");
}
