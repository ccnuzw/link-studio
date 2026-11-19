import { execFile, spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export class MediaError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MediaError";
  }
}

export interface ProcessOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxRssMiB?: number;
  onProgress?: (text: string) => void;
}

export function runMediaProcess(
  executable: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<Buffer> {
  if (!isAbsolute(executable)) return Promise.reject(new MediaError("EXPORT_EXECUTABLE_INVALID"));
  if (options.signal?.aborted) return Promise.reject(new MediaError("EXPORT_CANCELLED"));
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let failure: string | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    let size = 0;
    let stderrSize = 0;
    let sampling = false;
    const chunks: Buffer[] = [];
    const stop = (code: string) => {
      if (failure) return;
      failure = code;
      child.kill("SIGTERM");
      force = setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const abort = () => stop("EXPORT_CANCELLED");
    const timeout = setTimeout(() => stop("EXPORT_TIMEOUT"), options.timeoutMs ?? 60_000);
    const memory = setInterval(() => {
      if (process.platform !== "darwin" || !child.pid || sampling || failure) return;
      sampling = true;
      execFile(
        "/bin/ps",
        ["-o", "rss=", "-p", String(child.pid)],
        { timeout: 500 },
        (error, text) => {
          sampling = false;
          if (!error && Number(text.trim()) > (options.maxRssMiB ?? 512) * 1024)
            stop("EXPORT_MEMORY_LIMIT");
        },
      );
    }, 100);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.maxStdoutBytes ?? 1024 * 1024)) stop("EXPORT_OUTPUT_LIMIT");
      else {
        chunks.push(chunk);
        try {
          options.onProgress?.(chunk.toString("utf8"));
        } catch {
          stop("EXPORT_PROGRESS_FAILED");
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > 1024 * 1024) stop("EXPORT_DIAGNOSTIC_LIMIT");
    });
    child.on("error", () => {
      failure ??= "EXPORT_WORKER_FAILED";
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      clearInterval(memory);
      if (force) clearTimeout(force);
      options.signal?.removeEventListener("abort", abort);
      if (failure || code !== 0) reject(new MediaError(failure ?? "EXPORT_WORKER_FAILED"));
      else accept(Buffer.concat(chunks));
    });
  });
}
