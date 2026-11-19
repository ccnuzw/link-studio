import { type CommitStage, ProjectStore } from "../../src/main/project/store.ts";

const [directory, mode, operationId] = process.argv.slice(2);
if (!directory) throw new Error("需要项目目录");
if (mode === "race") {
  process.send?.({ waiting: true });
  await new Promise((resolve) => process.once("message", resolve));
}
try {
  const store = await ProjectStore.open(directory, {
    onStage: async (stage: CommitStage) => {
      if (mode !== stage) return;
      process.send?.({ stage });
      await new Promise(() => undefined);
    },
  });
  process.send?.({ ready: true, revision: store.snapshot.revision });
  if (mode && mode !== "hold" && mode !== "race") {
    if (!operationId) throw new Error("需要 operationId");
    await store.rename({
      operationId,
      expectedRevision: store.snapshot.revision,
      name: "强杀恢复",
    });
  }
  process.on("message", async () => {
    await store.close();
    process.disconnect?.();
  });
} catch (error) {
  process.send?.({ error: error instanceof Error && "code" in error ? error.code : String(error) });
  process.disconnect?.();
}
