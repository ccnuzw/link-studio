import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export class ProviderError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProviderError";
  }
}

export const LIMITS = {
  source: 512 * 1024,
  payload: 1024 * 1024,
  state: 64 * 1024,
  meta: 64 * 1024,
  rssKiB: 128 * 1024,
  wallMs: 5000,
} as const;

export function encoded(value: unknown, maximum: number): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new ProviderError("PLUGIN_INPUT_INVALID");
  }
  if (text === undefined || Buffer.byteLength(text) > maximum) {
    throw new ProviderError("PLUGIN_INPUT_LIMIT");
  }
  return text;
}

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("PLUGIN_OUTPUT_INVALID");
  }
  return value as Record<string, unknown>;
}

export function sourceHash(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export class PluginRunner {
  private active = 0;
  private readonly executable: string;

  constructor(executable: string) {
    this.executable = resolve(executable);
  }

  async call(source: string, hook: string, args: unknown[] = [], signal?: AbortSignal) {
    if (process.platform !== "darwin") throw new ProviderError("SANDBOX_UNAVAILABLE");
    if (Buffer.byteLength(source) > LIMITS.source) throw new ProviderError("PLUGIN_SOURCE_LIMIT");
    for (const argument of args) encoded(argument, LIMITS.payload);
    if (args.length > 2) throw new ProviderError("PLUGIN_INPUT_LIMIT");
    if (signal?.aborted) throw new ProviderError("PLUGIN_CANCELLED");
    if (this.active >= 2) throw new ProviderError("PLUGIN_BUSY");
    this.active++;
    try {
      return await this.execute({ source, hook, args }, signal);
    } finally {
      this.active--;
    }
  }

  private execute(input: object, signal?: AbortSignal): Promise<unknown> {
    return new Promise((accept, reject) => {
      const profile =
        "(version 1)(allow default)(deny network*)(deny file-write*)(deny process-fork)";
      const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, this.executable], {
        cwd: tmpdir(),
        env: { GOMEMLIMIT: "64MiB", GOMAXPROCS: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: string | undefined;
      let sampling = false;
      const stop = (code: string) => {
        failure ??= code;
        child.kill("SIGKILL");
      };
      const cancel = () => stop("PLUGIN_CANCELLED");
      const timer = setTimeout(() => stop("PLUGIN_TIMEOUT"), LIMITS.wallMs);
      const memory = setInterval(() => {
        if (!child.pid || sampling || failure) return;
        sampling = true;
        execFile(
          "/bin/ps",
          ["-o", "rss=", "-p", String(child.pid)],
          { timeout: 500 },
          (error, text) => {
            sampling = false;
            if (!error && Number(text.trim()) > LIMITS.rssKiB) stop("PLUGIN_MEMORY_LIMIT");
          },
        );
      }, 25);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > LIMITS.payload + 1024) stop("PLUGIN_OUTPUT_LIMIT");
        else chunks.push(chunk);
      });
      child.stderr.on("data", () => undefined);
      child.stdin.on("error", () => undefined);
      child.on("error", () => {
        failure ??= "SANDBOX_UNAVAILABLE";
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        clearInterval(memory);
        signal?.removeEventListener("abort", cancel);
        if (failure || code !== 0) {
          reject(new ProviderError(failure ?? "PLUGIN_RUNNER_CRASHED"));
          return;
        }
        try {
          const response = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (response.ok !== true)
            throw new ProviderError(String(response.code ?? "PLUGIN_EXECUTION_FAILED"));
          accept(response.result);
        } catch (error) {
          reject(
            error instanceof ProviderError ? error : new ProviderError("PLUGIN_OUTPUT_INVALID"),
          );
        }
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
}
