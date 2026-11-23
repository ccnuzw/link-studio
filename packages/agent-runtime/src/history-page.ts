import type { AgentStore } from "../upstream/src/store/store.ts";

export function historyPage(
  store: Pick<AgentStore, "listEventsBefore">,
  sessionId: string,
  before: number,
) {
  const size = 100;
  const chunk = (cursor: number) => {
    const rows = store.listEventsBefore(sessionId, cursor, size + 1);
    return { events: rows.length > size ? rows.slice(1) : rows, hasMoreOlder: rows.length > size };
  };
  let { events, hasMoreOlder } = chunk(before);
  for (let count = 0; count < 20; count++) {
    const start = events.findIndex(
      (event) =>
        event.type === "message.user" && !(event.payload as { steer?: boolean } | null)?.steer,
    );
    if (start >= 0) return { events: events.slice(start), hasMoreOlder: hasMoreOlder || start > 0 };
    if (!hasMoreOlder || !events[0]) break;
    const older = chunk(events[0].seq);
    events = [...older.events, ...events];
    hasMoreOlder = older.hasMoreOlder;
  }
  return { events, hasMoreOlder };
}
