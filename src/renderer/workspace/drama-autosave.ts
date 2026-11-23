export type AutosaveStatus = "saved" | "dirty" | "saving" | "conflict" | "error";

export type AutosaverOptions = {
  save: (value: string, revision: number) => Promise<number>;
  isConflict: (error: unknown) => boolean;
  revision: number;
  delay?: number;
  onStatus?: (status: AutosaveStatus) => void;
  onSaved?: (revision: number) => void;
};

export class Autosaver {
  private value: string | null = null;
  private saved: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private status: AutosaveStatus = "saved";
  private revision: number;
  private readonly delay: number;
  private readonly options: AutosaverOptions;

  constructor(options: AutosaverOptions) {
    this.options = options;
    this.revision = options.revision;
    this.delay = options.delay ?? 800;
  }

  getStatus(): AutosaveStatus {
    return this.status;
  }

  getRevision(): number {
    return this.revision;
  }

  reset(value: string, revision: number) {
    this.clearTimer();
    this.value = value;
    this.saved = value;
    this.revision = revision;
    this.setStatus("saved");
  }

  update(value: string) {
    this.value = value;
    if (this.status === "conflict") return;
    if (value === this.saved) {
      this.clearTimer();
      if (!this.running) this.setStatus("saved");
      return;
    }
    if (!this.running) this.setStatus("dirty");
    this.clearTimer();
    this.timer = setTimeout(() => void this.flush(), this.delay);
  }

  async flush(): Promise<void> {
    this.clearTimer();
    if (this.running) {
      await this.running;
      if (this.value !== this.saved && this.getStatus() !== "conflict") await this.flush();
      return;
    }
    if (this.status === "conflict" || this.value === null || this.value === this.saved) return;
    this.running = this.run();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
    const after = this.getStatus();
    if (this.value !== this.saved && after !== "conflict" && after !== "error") {
      await this.flush();
    }
  }

  private async run() {
    const value = this.value as string;
    this.setStatus("saving");
    try {
      const next = await this.options.save(value, this.revision);
      this.revision = next;
      this.saved = value;
      this.options.onSaved?.(next);
      this.setStatus(this.value === value ? "saved" : "dirty");
    } catch (error) {
      this.setStatus(this.options.isConflict(error) ? "conflict" : "error");
    }
  }

  dispose() {
    this.clearTimer();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private setStatus(status: AutosaveStatus) {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus?.(status);
  }
}
