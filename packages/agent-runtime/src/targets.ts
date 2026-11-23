import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type AgentScope = { kind: "settings" } | { kind: "canvas" | "drama"; projectId: string };

export class LocalAgentError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LocalAgentError";
  }
}

export function scopeKey(scope: AgentScope): string {
  if (scope.kind === "settings") return "settings";
  if (!["canvas", "drama"].includes(scope.kind) || !/^[a-zA-Z0-9-]{1,100}$/.test(scope.projectId))
    throw new LocalAgentError("AGENT_SCOPE_INVALID");
  return `${scope.kind}:${scope.projectId}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  throw new LocalAgentError("AGENT_ARGUMENT_INVALID");
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export class SpikeTargets {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS local_scopes (scope TEXT PRIMARY KEY, engine_id INTEGER UNIQUE NOT NULL, revision INTEGER NOT NULL DEFAULT 1, value TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS local_sessions (session_id TEXT PRIMARY KEY, scope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_receipts (scope TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(scope, operation_id));
      CREATE TABLE IF NOT EXISTS local_proposals (proposal_id TEXT PRIMARY KEY, scope TEXT NOT NULL, payload TEXT NOT NULL);
    `);
  }

  scope(scope: AgentScope): { key: string; engineId: string; mode: string } {
    const key = scopeKey(scope);
    this.database
      .prepare(
        "INSERT OR IGNORE INTO local_scopes(scope,engine_id) VALUES (?, CASE WHEN ?='settings' THEN 0 ELSE (SELECT COALESCE(MAX(engine_id),0)+1 FROM local_scopes) END)",
      )
      .run(key, key);
    const row = this.database.prepare("SELECT engine_id FROM local_scopes WHERE scope=?").get(key);
    return {
      key,
      engineId: String(row?.engine_id),
      mode: scope.kind === "settings" ? "admin" : scope.kind === "drama" ? "drama" : "all",
    };
  }

  bindSession(id: string, scope: AgentScope): void {
    this.database
      .prepare("INSERT INTO local_sessions(session_id,scope) VALUES (?,?)")
      .run(id, scopeKey(scope));
  }

  assertSession(id: string, scope: AgentScope): void {
    const row = this.database
      .prepare("SELECT scope FROM local_sessions WHERE session_id=?")
      .get(id);
    if (row?.scope !== scopeKey(scope)) throw new LocalAgentError("AGENT_SCOPE_DENIED");
  }

  scopeOf(id: string): string {
    const row = this.database
      .prepare("SELECT scope FROM local_sessions WHERE session_id=?")
      .get(id);
    if (typeof row?.scope !== "string") throw new LocalAgentError("AGENT_SCOPE_DENIED");
    return row.scope;
  }

  assertContext(sessionId: string, engineId: string): string {
    const scope = this.scopeOf(sessionId);
    const row = this.database
      .prepare("SELECT engine_id FROM local_scopes WHERE scope=?")
      .get(scope);
    if (String(row?.engine_id) !== engineId) throw new LocalAgentError("AGENT_SCOPE_DENIED");
    return scope;
  }

  read(scope: string): { revision: number; value: unknown } {
    const row = this.database
      .prepare("SELECT revision,value FROM local_scopes WHERE scope=?")
      .get(scope);
    if (!row) throw new LocalAgentError("AGENT_SCOPE_DENIED");
    return { revision: Number(row.revision), value: JSON.parse(String(row.value)) };
  }

  apply(scope: string, operationId: string, expectedRevision: number, value: unknown) {
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(operationId))
      throw new LocalAgentError("AGENT_OPERATION_INVALID");
    const requestHash = digest({ expectedRevision, value });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.database
        .prepare("SELECT request_hash,result FROM local_receipts WHERE scope=? AND operation_id=?")
        .get(scope, operationId);
      if (previous) {
        if (previous.request_hash !== requestHash)
          throw new LocalAgentError("AGENT_OPERATION_ID_REUSED");
        this.database.exec("COMMIT");
        return JSON.parse(String(previous.result)) as { revision: number; value: unknown };
      }
      const current = this.read(scope);
      if (current.revision !== expectedRevision) throw new LocalAgentError("AGENT_TARGET_CONFLICT");
      const serialized = canonical(value);
      if (Buffer.byteLength(serialized) > 64 * 1024)
        throw new LocalAgentError("AGENT_ARGUMENT_LIMIT");
      const result = { revision: current.revision + 1, value };
      this.database
        .prepare("UPDATE local_scopes SET revision=?,value=? WHERE scope=?")
        .run(result.revision, serialized, scope);
      this.database
        .prepare(
          "INSERT INTO local_receipts(scope,operation_id,request_hash,result) VALUES (?,?,?,?)",
        )
        .run(scope, operationId, requestHash, JSON.stringify(result));
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  propose(scope: string, operationId: string, value: unknown) {
    const current = this.read(scope);
    const id = digest({ scope, operationId, value });
    const previous = this.database
      .prepare("SELECT payload FROM local_proposals WHERE proposal_id=?")
      .get(id);
    if (previous) return JSON.parse(String(previous.payload));
    const proposal = {
      proposalId: id,
      scope,
      expectedRevision: current.revision,
      value,
      valueHash: digest(value),
    };
    this.database
      .prepare("INSERT INTO local_proposals VALUES (?,?,?)")
      .run(id, scope, JSON.stringify(proposal));
    return proposal;
  }

  execute(scope: string, operationId: string, payload: unknown) {
    if (!payload || typeof payload !== "object" || !("proposalId" in payload))
      throw new LocalAgentError("AGENT_APPROVAL_INVALID");
    const row = this.database
      .prepare("SELECT scope,payload FROM local_proposals WHERE proposal_id=?")
      .get(String(payload.proposalId));
    if (row?.scope !== scope || digest(JSON.parse(String(row.payload))) !== digest(payload))
      throw new LocalAgentError("AGENT_APPROVAL_INVALID");
    const proposal = JSON.parse(String(row.payload));
    return this.apply(scope, operationId, proposal.expectedRevision, proposal.value);
  }

  close(): void {
    this.database.close();
  }
}
