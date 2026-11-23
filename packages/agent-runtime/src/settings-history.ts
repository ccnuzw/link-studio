import { DatabaseSync } from "node:sqlite";

export function settingsHistory(file: string, resource: "runs" | "audits", status?: string) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const audits = resource === "audits";
    const table = audits ? "agent_approvals" : "agent_runs";
    const fields = audits ? "entry.kind" : "entry.steps";
    const rows = database
      .prepare(`SELECT CAST(entry.id AS TEXT) AS id, session.mode AS scene,entry.status,entry.updated_at,${fields}
      FROM ${table} AS entry JOIN agent_sessions AS session ON session.id=entry.session_id
      WHERE entry.user_id=1 AND session.deleted_at IS NULL AND (? IS NULL OR entry.status=?) ${audits ? "AND entry.decided_at IS NOT NULL" : ""}
      ORDER BY entry.updated_at DESC,entry.id DESC LIMIT 50`)
      .all(status ?? null, status ?? null);
    return {
      resource,
      scope: audits ? "本机助手已决定的审批" : "本机助手运行记录",
      limit: 50,
      rows,
    };
  } finally {
    database.close();
  }
}
