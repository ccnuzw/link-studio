import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const Identifier = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const Hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const Revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const Json = Type.Recursive((Self) =>
  Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String(),
    Type.Array(Self),
    Type.Record(Type.String(), Self),
  ]),
);
export type JsonValue = Static<typeof Json>;
export const Asset = Type.Object(
  {
    assetId: Type.String({ pattern: "^[0-9a-f-]{36}$" }),
    createdAt: Type.String(),
    origin: Type.Union([
      Type.Literal("imported"),
      Type.Literal("generated"),
      Type.Literal("derived"),
    ]),
    displayName: Type.String({ minLength: 1, maxLength: 255 }),
    mediaType: Type.Union([Type.Literal("image"), Type.Literal("video"), Type.Literal("audio")]),
    mimeType: Type.String({ minLength: 1, maxLength: 128 }),
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    sizeBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    importMode: Type.Union([Type.Literal("copy"), Type.Literal("reference")]),
    storage: Type.Union([
      Type.Object(
        { kind: Type.Literal("blob"), hash: Type.String({ pattern: "^[0-9a-f]{64}$" }) },
        { additionalProperties: false },
      ),
      Type.Object(
        { kind: Type.Literal("external"), locatorId: Identifier },
        { additionalProperties: false },
      ),
    ]),
    metadata: Type.Record(Type.String(), Json),
    availability: Type.Union([
      Type.Literal("ready"),
      Type.Literal("missing"),
      Type.Literal("deleted"),
    ]),
    deletedAt: Type.Optional(Timestamp),
  },
  { additionalProperties: false },
);

export const ProjectStateSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    projectId: Identifier,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    revision: Revision,
    parentHash: Type.Union([Type.Null(), Hash]),
    commitHash: Hash,
    assets: Type.Record(Type.String(), Asset),
    canvas: Type.Object(
      {
        schemaVersion: Type.Literal(1),
        revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        nodes: Type.Array(Json),
        edges: Type.Array(Json),
        viewport: Type.Object({ x: Type.Number(), y: Type.Number(), zoom: Type.Number() }),
      },
      { additionalProperties: false },
    ),
    compositions: Type.Record(Type.String(), Json),
    jobs: Type.Record(Type.String(), Json),
    operationReceipts: Type.Record(
      Identifier,
      Type.Object(
        { requestHash: Hash, revision: Revision, result: Json },
        { additionalProperties: false },
      ),
    ),
    extensions: Type.Record(Type.String(), Json),
  },
  { additionalProperties: false },
);

export type ProjectState = Static<typeof ProjectStateSchema>;
export type ProjectReceipt = ProjectState["operationReceipts"][string];

export function isProjectState(value: unknown): value is ProjectState {
  return Value.Check(ProjectStateSchema, value);
}

export function isOperationId(value: unknown): value is string {
  return Value.Check(Identifier, value);
}

export function normalizeProjectName(value: string): string | null {
  const name = value.trim();
  return [...name].length >= 1 && [...name].length <= 100 && !/[\p{Cc}/\\]/u.test(name)
    ? name
    : null;
}
