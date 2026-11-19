import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { PublishedEvent } from "../upstream/src/engine/engine.ts";
import { LocalAgentError } from "./targets.ts";

export interface AgentWorkerOptions {
  workerPath: string;
  directory: string;
  modelBridgeUrl: string;
  crashAfterEffect?: boolean;
  onEvent?: (event: PublishedEvent) => void;
}

export class AgentWorkerClient {
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private exited = false;
  private closing = false;
  private constructor(readonly worker: Worker) {}

  static async open(options: AgentWorkerOptions) {
    const worker = new Worker(options.workerPath, {
      workerData: {
        directory: options.directory,
        modelBridgeUrl: options.modelBridgeUrl,
        crashAfterEffect: options.crashAfterEffect,
      },
    });
    const client = new AgentWorkerClient(worker);
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((accept, reject) => {
      readyResolve = accept;
      readyReject = reject;
    });
    const timer = setTimeout(
      () => readyReject(new LocalAgentError("AGENT_INITIALIZATION_TIMEOUT")),
      15_000,
    );
    const fail = () => {
      clearTimeout(timer);
      client.exited = true;
      readyReject(new LocalAgentError("AGENT_WORKER_EXITED"));
      for (const entry of client.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new LocalAgentError("AGENT_WORKER_EXITED"));
      }
      client.pending.clear();
    };
    worker.on("error", fail);
    worker.on("exit", fail);
    worker.on("message", (message) => {
      if (message.ready) {
        clearTimeout(timer);
        readyResolve();
        return;
      }
      if (message.event) {
        try {
          options.onEvent?.(message.event);
        } catch {}
        return;
      }
      if (!message.id) {
        if (message.error) readyReject(new LocalAgentError(message.error));
        return;
      }
      const pending = client.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      client.pending.delete(message.id);
      if (message.error) pending.reject(new LocalAgentError(message.error));
      else pending.resolve(message.result);
    });
    try {
      await ready;
      return client;
    } catch (error) {
      clearTimeout(timer);
      await worker.terminate();
      throw error;
    }
  }

  request<Result = unknown>(command: string, args: object = {}): Promise<Result> {
    if (this.exited || (this.closing && command !== "close"))
      return Promise.reject(new LocalAgentError("AGENT_WORKER_CLOSED"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LocalAgentError("AGENT_REQUEST_TIMEOUT"));
      }, 15_000);
      this.pending.set(id, { resolve: (value) => resolve(value as Result), reject, timer });
      try {
        this.worker.postMessage({ id, command, args });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new LocalAgentError("AGENT_ARGUMENT_INVALID"));
      }
    });
  }

  async close() {
    if (this.exited || this.closing) return;
    this.closing = true;
    try {
      await this.request("close");
    } finally {
      await this.worker.terminate();
    }
  }
}
