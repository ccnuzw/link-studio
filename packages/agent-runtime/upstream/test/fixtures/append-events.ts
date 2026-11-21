import { once } from "node:events";
import { openStore } from "../../src/store/store.ts";

const [, , databasePath, sessionId] = process.argv;
if (!databasePath || !sessionId) throw new Error("Expected database and session ID");
const store = openStore(databasePath, { workerId: 1 });
try {
  for (let index = 0; index < 1_000; index++) {
    const event = store.appendEvent(sessionId, "0", "fixture.append", { index });
    if (!process.stdout.write(`${event.seq}\n`)) await once(process.stdout, "drain");
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
} finally {
  store.close();
}
