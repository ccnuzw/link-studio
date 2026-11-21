import { type Static, Type } from "@sinclair/typebox";
import { CanvasOperations, type ProjectCanvasView } from "./canvas.ts";
import { CanvasAgentAction, type CanvasAgentValues } from "./canvas-agent.ts";
import { GenerationInput, type GenerationJob } from "./generation.ts";

const Identifier = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const Revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const request = { requestId: Identifier };
const session = { ...request, projectHandle: Identifier };
const recentEntry = { ...request, recentEntryId: Identifier };
const assetSession = { ...request, projectHandle: Identifier };
const importSession = { ...assetSession, importSessionId: Identifier };

export const ProjectRequests = {
  canvasAgent: Type.Object(
    { ...session, action: CanvasAgentAction },
    { additionalProperties: false },
  ),
  listJobs: Type.Object(session, { additionalProperties: false }),
  submitJob: Type.Object(
    {
      ...session,
      operationId: Identifier,
      generation: GenerationInput,
      confirmed: Type.Literal(true),
    },
    { additionalProperties: false },
  ),
  submitJobs: Type.Object(
    {
      ...session,
      confirmed: Type.Literal(true),
      entries: Type.Array(
        Type.Object({ id: Identifier, input: GenerationInput }, { additionalProperties: false }),
        { minItems: 1, maxItems: 100 },
      ),
    },
    { additionalProperties: false },
  ),
  cancelJob: Type.Object({ ...session, jobId: Identifier }, { additionalProperties: false }),
  recheckJob: Type.Object({ ...session, jobId: Identifier }, { additionalProperties: false }),
  selectProject: Type.Object(request, { additionalProperties: false }),
  selectProjectParent: Type.Object(request, { additionalProperties: false }),
  create: Type.Object(
    {
      ...request,
      directoryToken: Identifier,
      operationId: Identifier,
      name: Type.String({ minLength: 1, maxLength: 200 }),
    },
    { additionalProperties: false },
  ),
  open: Type.Object({ ...request, directoryToken: Identifier }, { additionalProperties: false }),
  listRecent: Type.Object(request, { additionalProperties: false }),
  openRecent: Type.Object(recentEntry, { additionalProperties: false }),
  removeRecent: Type.Object(recentEntry, { additionalProperties: false }),
  getState: Type.Object(session, { additionalProperties: false }),
  getCanvas: Type.Object(session, { additionalProperties: false }),
  rename: Type.Object(
    {
      ...session,
      operationId: Identifier,
      expectedRevision: Revision,
      name: Type.String({ minLength: 1, maxLength: 200 }),
    },
    { additionalProperties: false },
  ),
  flush: Type.Object(session, { additionalProperties: false }),
  close: Type.Object(session, { additionalProperties: false }),
  selectMedia: Type.Object(
    { ...assetSession, multiSelect: Type.Boolean() },
    { additionalProperties: false },
  ),
  importAsset: Type.Object(
    {
      ...assetSession,
      operationId: Identifier,
      expectedRevision: Revision,
      fileToken: Identifier,
      choice: Type.Optional(Type.Union([Type.Literal("reuse"), Type.Literal("independent")])),
    },
    { additionalProperties: false },
  ),
  startImport: Type.Object(
    {
      ...assetSession,
      operationId: Identifier,
      expectedRevision: Revision,
      fileToken: Identifier,
      importMode: Type.Optional(Type.Union([Type.Literal("copy"), Type.Literal("reference")])),
    },
    { additionalProperties: false },
  ),
  getImport: Type.Object(importSession, { additionalProperties: false }),
  cancelImport: Type.Object(importSession, { additionalProperties: false }),
  commitImport: Type.Object(
    {
      ...importSession,
      operationId: Identifier,
      expectedRevision: Revision,
      choice: Type.Optional(Type.Union([Type.Literal("reuse"), Type.Literal("independent")])),
    },
    { additionalProperties: false },
  ),
  discardMedia: Type.Object(
    { ...assetSession, fileToken: Identifier },
    { additionalProperties: false },
  ),
  listAssets: Type.Object(assetSession, { additionalProperties: false }),
  removeAsset: Type.Object(
    { ...assetSession, operationId: Identifier, expectedRevision: Revision, assetId: Identifier },
    { additionalProperties: false },
  ),
  getAssetPreview: Type.Object(
    { ...assetSession, assetId: Identifier },
    { additionalProperties: false },
  ),
  inspectAsset: Type.Object(
    {
      ...assetSession,
      assetId: Identifier,
      timeMs: Type.Integer({ minimum: 0, maximum: 86_400_000 }),
    },
    { additionalProperties: false },
  ),
  trimAsset: Type.Object(
    {
      ...assetSession,
      operationId: Identifier,
      expectedRevision: Revision,
      assetId: Identifier,
      startMs: Type.Integer({ minimum: 0, maximum: 86_400_000 }),
      endMs: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
      removeAudio: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  splitAsset: Type.Object(
    {
      ...assetSession,
      operationId: Identifier,
      expectedRevision: Revision,
      assetId: Identifier,
      rows: Type.Integer({ minimum: 1, maximum: 5 }),
      columns: Type.Integer({ minimum: 1, maximum: 5 }),
      xLines: Type.Optional(Type.Array(Type.Number({ minimum: 0, maximum: 1 }), { maxItems: 4 })),
      yLines: Type.Optional(Type.Array(Type.Number({ minimum: 0, maximum: 1 }), { maxItems: 4 })),
    },
    { additionalProperties: false },
  ),
  annotateAsset: Type.Object(
    {
      ...assetSession,
      operationId: Identifier,
      expectedRevision: Revision,
      assetId: Identifier,
      pngData: Type.String({ minLength: 1, maxLength: 96 * 1024 * 1024 }),
      purpose: Type.Optional(Type.Literal("outpaint")),
    },
    { additionalProperties: false },
  ),
  exportComposition: Type.Object(
    {
      ...assetSession,
      operationId: Identifier,
      expectedRevision: Revision,
      videoAssetIds: Type.Array(Identifier, { minItems: 1, maxItems: 16, uniqueItems: true }),
      bgmAssetId: Type.Optional(Identifier),
      sourceVolume: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
      bgmVolume: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
      profile: Type.Optional(Type.Union([Type.Literal("m0-360p"), Type.Literal("hd-720p")])),
    },
    { additionalProperties: false },
  ),
  saveDirectorPreview: Type.Object(
    { ...session, mp4: Type.Uint8Array({ minByteLength: 16, maxByteLength: 16 * 1024 * 1024 }) },
    { additionalProperties: false },
  ),
  cancelMediaTool: Type.Object(
    { ...assetSession, operationId: Identifier },
    { additionalProperties: false },
  ),
  relocateAsset: Type.Object(
    { ...assetSession, assetId: Identifier, fileToken: Identifier },
    { additionalProperties: false },
  ),
  applyCanvasOperations: Type.Object(
    {
      ...assetSession,
      expectedCanvasRevision: Revision,
      operationId: Identifier,
      operations: CanvasOperations,
    },
    { additionalProperties: false },
  ),
};

export const ProjectChannels = {
  canvasAgent: "link-studio:canvas-agent:action",
  listJobs: "link-studio:jobs:list",
  submitJob: "link-studio:jobs:submit",
  submitJobs: "link-studio:jobs:submitBatch",
  cancelJob: "link-studio:jobs:cancel",
  recheckJob: "link-studio:jobs:recheck",
  selectProject: "link-studio:dialogs:selectProject",
  selectProjectParent: "link-studio:dialogs:selectProjectParent",
  create: "link-studio:projects:create",
  open: "link-studio:projects:open",
  listRecent: "link-studio:projects:listRecent",
  openRecent: "link-studio:projects:openRecent",
  removeRecent: "link-studio:projects:removeRecent",
  getState: "link-studio:projects:getState",
  getCanvas: "link-studio:canvas:get",
  rename: "link-studio:projects:rename",
  flush: "link-studio:projects:flush",
  close: "link-studio:projects:close",
  selectMedia: "link-studio:dialogs:selectMedia",
  importAsset: "link-studio:assets:import",
  startImport: "link-studio:assets:startImport",
  getImport: "link-studio:assets:getImport",
  cancelImport: "link-studio:assets:cancelImport",
  commitImport: "link-studio:assets:commitImport",
  discardMedia: "link-studio:assets:discardMedia",
  listAssets: "link-studio:assets:list",
  removeAsset: "link-studio:assets:remove",
  getAssetPreview: "link-studio:assets:getPreview",
  inspectAsset: "link-studio:assets:inspect",
  trimAsset: "link-studio:assets:trim",
  splitAsset: "link-studio:assets:split",
  annotateAsset: "link-studio:assets:annotate",
  exportComposition: "link-studio:composition:export",
  saveDirectorPreview: "link-studio:director:savePreview",
  cancelMediaTool: "link-studio:assets:cancelMediaTool",
  relocateAsset: "link-studio:assets:relocate",
  applyCanvasOperations: "link-studio:canvas:applyOperations",
} as const;

export type ProjectMethod = keyof typeof ProjectRequests;
export type ProjectRequest<Method extends ProjectMethod> = Static<(typeof ProjectRequests)[Method]>;

export interface ProjectSession {
  projectHandle: string;
  projectId: string;
  name: string;
  schemaVersion: 1;
  revision: number;
  recoveredFromPrevious: boolean;
}

export interface RecentProject {
  recentEntryId: string;
  projectId: string;
  displayName: string;
  displayPath: string;
  lastOpenedAt: string;
}

export interface ProjectAsset {
  assetId: string;
  displayName: string;
  mediaType: "image" | "video" | "audio";
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  importMode: "copy" | "reference";
  storage: { kind: "blob"; hash: string } | { kind: "external"; locatorId: string };
  metadata: Record<string, unknown>;
  availability: "ready" | "missing";
  createdAt?: string;
  origin?: "imported" | "generated" | "derived";
}

export type ProjectErrorCode =
  | "AGENT_SCOPE_DENIED"
  | "AGENT_RUN_BUSY"
  | "AGENT_APPROVAL_STALE"
  | "AGENT_MODEL_UNAVAILABLE"
  | "AGENT_MODEL_BINDING_STALE"
  | "AGENT_MODEL_CAPABILITY_UNSUPPORTED"
  | "AGENT_MEDIA_UNAVAILABLE"
  | "AGENT_MEDIA_LIMIT"
  | "AGENT_READ_REQUIRED"
  | "AGENT_RUNTIME_FAILED"
  | "JOB_MODEL_UNAVAILABLE"
  | "JOB_INPUT_INVALID"
  | "JOB_IMAGE_DEPENDENCY_FAILED"
  | "JOB_NOT_FOUND"
  | "JOB_CANNOT_CANCEL"
  | "JOB_CANNOT_RECHECK"
  | "CANVAS_REVISION_CONFLICT"
  | "CANVAS_OPERATION_INVALID"
  | "CANVAS_REFERENCE_MISSING"
  | "VALIDATION_FAILED"
  | "PAYLOAD_TOO_LARGE"
  | "PROJECT_PATH_DENIED"
  | "TOKEN_INVALID_OR_EXPIRED"
  | "PROJECT_NOT_OPEN"
  | "PROJECT_CLOSED"
  | "PROJECT_SCHEMA_INVALID"
  | "PROJECT_VERSION_UNSUPPORTED"
  | "PROJECT_FILESYSTEM_UNSUPPORTED"
  | "PROJECT_IN_USE"
  | "PROJECT_LOCATION_UNSUPPORTED"
  | "PROJECT_SCHEMA_UNSUPPORTED"
  | "PROJECT_CORRUPT"
  | "PROJECT_NAME_INVALID"
  | "PROJECT_SAVE_FAILED"
  | "PROJECT_CONFLICT"
  | "OPERATION_ID_REUSED"
  | "ASSET_TYPE_UNSUPPORTED"
  | "ASSET_SIZE_LIMIT"
  | "ASSET_READ_FAILED"
  | "ASSET_STORAGE_FAILED"
  | "ASSET_IN_USE"
  | "ASSET_NOT_FOUND"
  | "ASSET_REFERENCE_CHANGED"
  | "EXPORT_CANCELLED"
  | "EXPORT_COMMIT_UNKNOWN"
  | "EXPORT_DISK_FULL"
  | "EXPORT_FILESYSTEM_UNSUPPORTED"
  | "EXPORT_MEDIA_INVALID"
  | "EXPORT_MEDIA_UNSUPPORTED"
  | "EXPORT_PLATFORM_UNSUPPORTED"
  | "EXPORT_RECIPE_INVALID"
  | "EXPORT_RESOURCE_LIMIT"
  | "EXPORT_SOURCE_MISSING"
  | "EXPORT_TARGET_BUSY"
  | "EXPORT_TARGET_CHANGED"
  | "EXPORT_TARGET_EXISTS"
  | "EXPORT_TIMEOUT"
  | "EXPORT_WORKER_FAILED"
  | "ASSET_IMPORT_CANCELLED";

export type ImportStatus = { copiedBytes: number; totalBytes: number } & (
  | { phase: "copying" | "committing" | "cancelled" | "conflict" }
  | { phase: "duplicate"; candidateAssetIds: string[] }
  | { phase: "imported"; asset: ProjectAsset; revision: number }
  | { phase: "failed"; code: string }
);

export type ProjectResult<Value> =
  | { ok: true; requestId: string; value: Value }
  | {
      ok: false;
      requestId: string;
      error: {
        code: ProjectErrorCode;
        retryable: boolean;
        messageKey: string;
        message?: string;
      };
    };

export interface ProjectValues {
  canvasAgent: CanvasAgentValues[keyof CanvasAgentValues];
  listJobs: { jobs: GenerationJob[]; revision: number; canvasRevision: number };
  submitJob: GenerationJob;
  submitJobs: GenerationJob[];
  cancelJob: GenerationJob;
  recheckJob: GenerationJob;
  selectProject: { cancelled: true } | { cancelled: false; directoryToken: string };
  selectProjectParent:
    | { cancelled: true }
    | { cancelled: false; directoryToken: string; displayPath: string };
  create: ProjectSession;
  open: { disposition: "opened"; session: ProjectSession } | { disposition: "focusedExisting" };
  listRecent: { projects: RecentProject[] };
  openRecent: ProjectValues["open"];
  removeRecent: { removed: true };
  getState: { session: ProjectSession };
  getCanvas: { canvas: ProjectCanvasView; canvasRevision: number; revision: number };
  rename: { revision: number; name: string };
  flush: { revision: number };
  close: { closed: true };
  selectMedia:
    | { cancelled: true }
    | { cancelled: false; files: { fileToken: string; displayName: string }[] };
  importAsset:
    | { asset: ProjectAsset; revision: number }
    | { duplicate: true; candidateAssetIds: string[]; revision: number };
  startImport: { importSessionId: string };
  getImport: ImportStatus;
  cancelImport: ImportStatus;
  commitImport: ImportStatus;
  discardMedia: { discarded: true };
  listAssets: { assets: ProjectAsset[] };
  removeAsset: { removed: true; revision: number };
  getAssetPreview: { url: string; mimeType: string };
  inspectAsset: { assetId: string; mimeType: string; revision: number };
  trimAsset: { asset: ProjectAsset; revision: number };
  splitAsset: { assets: ProjectAsset[]; revision: number };
  annotateAsset: { asset: ProjectAsset; revision: number };
  exportComposition: {
    asset: ProjectAsset;
    revision: number;
    targetName: string;
    exportId: string;
  };
  saveDirectorPreview: { saved: boolean };
  cancelMediaTool: { requested: boolean };
  relocateAsset: { revision: number };
  applyCanvasOperations: { revision: number; canvasRevision: number };
}

export type ProjectsAPI = {
  [Method in Exclude<ProjectMethod, "selectProject" | "selectProjectParent" | "selectMedia">]: (
    input: Omit<ProjectRequest<Method>, "requestId">,
  ) => Promise<ProjectResult<ProjectValues[Method]>>;
};

export interface ProjectDialogsAPI {
  selectProject(): Promise<ProjectResult<ProjectValues["selectProject"]>>;
  selectProjectParent(): Promise<ProjectResult<ProjectValues["selectProjectParent"]>>;
  selectMedia(
    input: Omit<ProjectRequest<"selectMedia">, "requestId">,
  ): Promise<ProjectResult<ProjectValues["selectMedia"]>>;
}
