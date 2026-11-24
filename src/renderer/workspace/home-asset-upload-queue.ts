export type HomeAssetUploadTask = {
  id: string;
  file: File;
  folder: string;
  status: "queued" | "uploading" | "failed";
  percent: number;
  error?: string;
};

export class HomeAssetUploadQueue {
  private readonly tasks = new Map<string, HomeAssetUploadTask>();
  private readonly running = new Set<string>();
  private active = false;

  constructor(
    private readonly upload: (task: HomeAssetUploadTask) => Promise<void>,
    private readonly cancelUpload: (id: string) => void,
    private readonly changed: (tasks: HomeAssetUploadTask[]) => void,
  ) {}

  activate() {
    this.active = true;
    this.publish();
  }

  deactivate() {
    this.active = false;
    const active = [...this.running];
    this.tasks.clear();
    this.publish();
    for (const id of active) this.cancelUpload(id);
  }

  add(files: File[], folder: string) {
    if (!this.active) return;
    for (const file of files) {
      const id = crypto.randomUUID();
      this.tasks.set(id, { id, file, folder, percent: 0, status: "queued" });
    }
    this.pump();
  }

  retry(id: string) {
    const task = this.tasks.get(id);
    if (!this.active || task?.status !== "failed") return;
    task.status = "queued";
    task.percent = 0;
    delete task.error;
    this.pump();
  }

  cancel(id: string) {
    if (!this.tasks.delete(id)) return;
    if (this.running.has(id)) this.cancelUpload(id);
    this.publish();
  }

  progress(id: string, percent: number) {
    const task = this.tasks.get(id);
    if (!this.active || !task) return;
    task.percent = percent;
    this.publish();
  }

  private publish() {
    if (this.active) this.changed(Array.from(this.tasks.values(), (task) => ({ ...task })));
  }

  private pump() {
    if (!this.active) return;
    for (const task of this.tasks.values()) {
      if (this.running.size >= 3) break;
      if (task.status !== "queued") continue;
      task.status = "uploading";
      this.running.add(task.id);
      void this.upload(task)
        .then(() => {
          if (this.active && this.tasks.get(task.id) === task) this.tasks.delete(task.id);
        })
        .catch((error: unknown) => {
          if (!this.active || this.tasks.get(task.id) !== task) return;
          task.status = "failed";
          task.error = error instanceof Error ? error.message : "导入失败";
        })
        .finally(() => {
          this.running.delete(task.id);
          if (this.active) {
            this.pump();
            this.publish();
          }
        });
    }
    this.publish();
  }
}
