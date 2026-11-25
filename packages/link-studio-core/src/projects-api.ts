import { type Static, Type } from "@sinclair/typebox";
import { CanvasOperations, type ProjectCanvasView } from "./canvas.ts";
import { CanvasAgentAction, type CanvasAgentValues } from "./canvas-agent.ts";
import {
  AdaptDramaSegment,
  AddDramaEpisode,
  AddDramaSegment,
  DeleteDramaEpisode,
  DeleteDramaSegment,
  type DramaDocument,
  DramaSource,
  DramaSourceFields,
  type DramaSourcePreview,
  EditDramaField,
  ReorderDramaSegments,
  SaveDramaScript,
  SetDramaSegmentPrompt,
  SetDramaSegmentSeconds,
  UpdateDramaBoardSettings,
} from "./drama.ts";
import { GenerationInput, type GenerationJob } from "./generation.ts";

const Identifier = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const Revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const request = { requestId: Identifier };
const session = { ...request, projectHandle: Identifier };
const scriptEpisodes = Type.Array(Type.Integer({ minimum: 1, maximum: 100000 }), {
  minItems: 1,
  maxItems: 200,
  uniqueItems: true,
});
const workspaceTextJob = Type.Object(
  {
    episodes: scriptEpisodes,
    episodeOrder: Type.Optional(Type.Integer({ minimum: 0 })),
    estimate: Type.Integer({ minimum: 0 }),
    operationId: Identifier,
  },
  { additionalProperties: false },
);
const storyboardInput = {
  episodeNo: Type.Integer({ minimum: 1, maximum: 100000 }),
  maxSeconds: Type.Integer({ minimum: 4, maximum: 60 }),
  maxAudios: Type.Optional(Type.Integer({ minimum: 0 })),
  videoModel: Type.Optional(Identifier),
};
const recentEntry = { ...request, recentEntryId: Identifier };
const libraryScope = { ...request, projectHandle: Type.Optional(Identifier) };
const assetSession = { ...request, projectHandle: Identifier };
const mediaAssetRequest = Type.Union([
  Type.Object({ ...assetSession, assetId: Identifier }, { additionalProperties: false }),
  Type.Object(
    {
      ...request,
      library: Type.Union([Type.Literal("history"), Type.Literal("personal")]),
      assetId: Identifier,
    },
    { additionalProperties: false },
  ),
]);
const importSession = { ...assetSession, importSessionId: Identifier };
const filingLibraryScope = { ...request, channelId: Identifier, channelRevision: Revision };
const filingHistoryFilter = Type.Object(
  {
    canvas: Type.Optional(Identifier),
    conversation: Type.Optional(Type.Boolean()),
    days: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(7), Type.Literal(30)])),
  },
  { additionalProperties: false },
);

export const ProjectRequests = {
  dropGlobalAsset: Type.Object(
    {
      ...request,
      operationId: Identifier,
      folder: Type.Optional(Identifier),
      path: Type.String({ minLength: 1, maxLength: 4096 }),
    },
    { additionalProperties: false },
  ),
  cancelGlobalImport: Type.Object(
    { ...request, operationId: Identifier },
    { additionalProperties: false },
  ),
  importGlobalAsset: Type.Object(
    { ...request, folder: Type.Optional(Identifier) },
    { additionalProperties: false },
  ),
  globalHistory: Type.Object(
    {
      ...request,
      filter: filingHistoryFilter,
      search: Type.String({ maxLength: 255 }),
      media: Type.Union([Type.Literal("image"), Type.Literal("video"), Type.Literal("audio")]),
      oldest: Type.Boolean(),
      before: Type.Optional(
        Type.Object({ created: Type.Integer(), id: Identifier }, { additionalProperties: false }),
      ),
    },
    { additionalProperties: false },
  ),
  collectHistory: Type.Object(
    { ...request, id: Identifier, folderId: Type.Optional(Identifier) },
    { additionalProperties: false },
  ),
  globalLibrary: Type.Object(
    { ...request, before: Type.Optional(Revision) },
    { additionalProperties: false },
  ),
  estimateDramaStoryboard: Type.Object(
    { ...session, ...storyboardInput, previewClear: Type.Optional(Type.Literal(true)) },
    { additionalProperties: false },
  ),
  estimateDramaScripts: Type.Object(
    { ...session, episodes: scriptEpisodes },
    { additionalProperties: false },
  ),
  estimateDramaBreakdown: Type.Object(
    { ...session, episodes: scriptEpisodes, promptsOnly: Type.Optional(Type.Boolean()) },
    { additionalProperties: false },
  ),
  estimateDramaContinuation: Type.Object(
    { ...session, rangeEnd: Type.Integer({ minimum: 0, maximum: 100000 }) },
    { additionalProperties: false },
  ),
  filingLibraryPage: Type.Object(
    {
      ...filingLibraryScope,
      initialItem: Type.Optional(Identifier),
      session: Type.Optional(Identifier),
      carry: Type.Optional(
        Type.Object({ page: Identifier, choice: Identifier }, { additionalProperties: false }),
      ),
      before: Type.Optional(Revision),
      folder: Type.Optional(Identifier),
      history: Type.Optional(filingHistoryFilter),
      search: Type.Optional(Type.String({ maxLength: 255 })),
    },
    { additionalProperties: false },
  ),
  filingLibraryClose: Type.Union([
    Type.Object({ ...request, page: Identifier }, { additionalProperties: false }),
    Type.Object({ ...request, session: Identifier }, { additionalProperties: false }),
  ]),
  filingLibraryMore: Type.Object(
    { ...filingLibraryScope, page: Identifier, before: Revision },
    { additionalProperties: false },
  ),
  filingLibraryUpload: Type.Object(
    {
      ...filingLibraryScope,
      session: Identifier,
      destination: Identifier,
      uploadId: Type.Optional(Identifier),
      name: Type.String({ minLength: 1, maxLength: 255 }),
      bytes: Type.Uint8Array({ minByteLength: 1, maxByteLength: 10 * 1024 * 1024 }),
    },
    { additionalProperties: false },
  ),
  filingLibraryUploaded: Type.Object(
    { ...filingLibraryScope, page: Identifier, receipt: Identifier },
    { additionalProperties: false },
  ),
  filingLibraryCancelUpload: Type.Object(
    { ...request, session: Identifier, uploadId: Identifier },
    { additionalProperties: false },
  ),
  filingLibraryEnroll: Type.Object(
    {
      ...filingLibraryScope,
      page: Identifier,
      choice: Identifier,
      name: Type.String({ minLength: 1, maxLength: 128 }),
      humanId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      confirmed: Type.Literal(true),
    },
    { additionalProperties: false },
  ),
  drama: Type.Object(
    {
      ...session,
      create: Type.Optional(
        Type.Object(
          { ...Type.Omit(DramaSource, ["script"]).properties, sourceToken: Identifier },
          { additionalProperties: false },
        ),
      ),
      addSegment: Type.Optional(AddDramaSegment),
      addEpisode: Type.Optional(AddDramaEpisode),
      saveScript: Type.Optional(SaveDramaScript),
      editField: Type.Optional(EditDramaField),
      compose: Type.Optional(
        Type.Object(
          {
            episodeNo: Type.Integer({ minimum: 1, maximum: 100000 }),
            episodeOrder: Type.Integer({ minimum: 0 }),
            operationId: Identifier,
          },
          { additionalProperties: false },
        ),
      ),
      boardSettings: Type.Optional(UpdateDramaBoardSettings),
      deleteEpisode: Type.Optional(DeleteDramaEpisode),
      adaptSegment: Type.Optional(AdaptDramaSegment),
      deleteSegment: Type.Optional(DeleteDramaSegment),
      storyboard: Type.Optional(
        Type.Object(
          {
            ...storyboardInput,
            episodeOrder: Type.Integer({ minimum: 0 }),
            estimate: Type.Integer({ minimum: 0 }),
            operationId: Identifier,
            clearHash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
            batch: Type.Optional(Type.Literal(true)),
          },
          { additionalProperties: false },
        ),
      ),
      cancelJob: Type.Optional(Type.String({ pattern: "^[a-f0-9]{32}$" })),
      cancelStoryboard: Type.Optional(Type.String({ pattern: "^[a-f0-9]{32}$" })),
      planningAction: Type.Optional(
        Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("retry-builtin")]),
      ),
      extendPlanning: Type.Optional(
        Type.Object(
          {
            rangeEnd: Type.Integer({ minimum: 0, maximum: 100000 }),
            previousEnd: Type.Integer({ minimum: 1, maximum: 100000 }),
          },
          { additionalProperties: false },
        ),
      ),
      writeScripts: Type.Optional(workspaceTextJob),
      breakdown: Type.Optional(workspaceTextJob),
      repairPrompts: Type.Optional(workspaceTextJob),
      cancelBreakdown: Type.Optional(Type.String({ pattern: "^[a-f0-9]{32}$" })),
      chooseTake: Type.Optional(
        Type.Object(
          {
            segmentId: Type.String({ pattern: "^[a-f0-9]{32}$" }),
            taskId: Identifier,
            revision: Revision,
          },
          { additionalProperties: false },
        ),
      ),
      setSegmentSeconds: Type.Optional(SetDramaSegmentSeconds),
      setSegmentPrompt: Type.Optional(SetDramaSegmentPrompt),
      reorderSegments: Type.Optional(ReorderDramaSegments),
    },
    { additionalProperties: false },
  ),
  previewDramaSource: Type.Object(
    {
      ...session,
      ...DramaSourceFields,
      script: Type.Optional(DramaSourceFields.script),
      fileBytes: Type.Optional(Type.Uint8Array({ maxByteLength: 32 * 1024 * 1024 })),
      sourceToken: Type.Optional(Identifier),
      filename: Type.Optional(Type.String({ maxLength: 255 })),
      preflightOnly: Type.Optional(Type.Literal(true)),
    },
    { additionalProperties: false },
  ),
  canvasAgent: Type.Object(
    { ...session, action: CanvasAgentAction, mode: Type.Optional(Type.Literal("drama")) },
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
  retryCharacterImage: Type.Object(
    {
      ...session,
      jobId: Identifier,
      operationId: Identifier,
      expectedCanvasRevision: Revision,
      confirmed: Type.Literal(true),
    },
    { additionalProperties: false },
  ),
  recheckJob: Type.Object({ ...session, jobId: Identifier }, { additionalProperties: false }),
  selectProject: Type.Object(request, { additionalProperties: false }),
  selectProjectParent: Type.Object(request, { additionalProperties: false }),
  create: Type.Object(
    {
      ...request,
      directoryToken: Identifier,
      canvasSeed: Type.Optional(
        Type.Object(
          {
            operations: CanvasOperations,
            media: Type.Optional(
              Type.Object(
                {
                  projectHandle: Type.Optional(Identifier),
                  assetIds: Type.Array(Identifier, { uniqueItems: true, maxItems: 10000 }),
                },
                { additionalProperties: false },
              ),
            ),
          },
          { additionalProperties: false },
        ),
      ),
      operationId: Identifier,
      name: Type.String({ minLength: 1, maxLength: 200 }),
      projectKind: Type.Optional(Type.Union([Type.Literal("canvas"), Type.Literal("drama")])),
    },
    { additionalProperties: false },
  ),
  open: Type.Object(
    { ...request, directoryToken: Identifier, allowReadOnly: Type.Optional(Type.Boolean()) },
    { additionalProperties: false },
  ),
  listRecent: Type.Object(request, { additionalProperties: false }),
  openRecent: Type.Object(
    { ...recentEntry, allowReadOnly: Type.Optional(Type.Boolean()) },
    { additionalProperties: false },
  ),
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
  close: Type.Object(
    { ...session, keepWorking: Type.Optional(Type.Boolean()) },
    { additionalProperties: false },
  ),
  selectMedia: Type.Object(
    {
      ...assetSession,
      multiSelect: Type.Boolean(),
      mediaType: Type.Optional(
        Type.Union([Type.Literal("image"), Type.Literal("video"), Type.Literal("audio")]),
      ),
    },
    { additionalProperties: false },
  ),
  droppedMedia: Type.Object(
    {
      ...assetSession,
      paths: Type.Array(Type.String({ minLength: 1, maxLength: 32768 }), {
        minItems: 1,
        maxItems: 32,
      }),
    },
    { additionalProperties: false },
  ),
  beginClipboardFile: Type.Object(
    {
      ...assetSession,
      name: Type.String({ maxLength: 255 }),
      kind: Type.Union([Type.Literal("image"), Type.Literal("video"), Type.Literal("audio")]),
      size: Type.Integer({ minimum: 0, maximum: 200 * 1024 * 1024 }),
    },
    { additionalProperties: false },
  ),
  appendClipboardFile: Type.Object(
    {
      ...assetSession,
      fileToken: Identifier,
      offset: Type.Integer({ minimum: 0, maximum: 200 * 1024 * 1024 }),
      bytes: Type.Uint8Array({ minByteLength: 1, maxByteLength: 1024 * 1024 }),
    },
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
  attachImage: Type.Object(
    {
      ...assetSession,
      operationId: Identifier,
      name: Type.String({ minLength: 1, maxLength: 255 }),
      bytes: Type.Uint8Array({ minByteLength: 1, maxByteLength: 16 * 1024 * 1024 }),
    },
    { additionalProperties: false },
  ),
  attachFiledImage: Type.Object(
    {
      ...assetSession,
      operationId: Identifier,
      channelId: Identifier,
      channelRevision: Revision,
      imageId: Type.String({ pattern: "^[a-zA-Z0-9._:-]{1,128}$" }),
    },
    { additionalProperties: false },
  ),
  enrollImage: Type.Object(
    {
      ...assetSession,
      assetId: Identifier,
      channelId: Identifier,
      channelRevision: Revision,
      name: Type.String({ minLength: 1, maxLength: 128 }),
      humanId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
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
      forLibrary: Type.Optional(Type.Boolean()),
      forCanvasUpload: Type.Optional(Type.Boolean()),
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
  listAssets: Type.Object(
    { ...assetSession, filingChannelId: Type.Optional(Identifier) },
    { additionalProperties: false },
  ),
  listLibrary: Type.Object(
    {
      ...assetSession,
      before: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
      filingChannelId: Type.Optional(Identifier),
    },
    { additionalProperties: false },
  ),
  listLibraryFolders: Type.Object(libraryScope, { additionalProperties: false }),
  createLibraryFolder: Type.Object(
    { ...libraryScope, name: Type.String({ minLength: 1, maxLength: 120 }) },
    { additionalProperties: false },
  ),
  renameLibraryFolder: Type.Object(
    { ...libraryScope, folderId: Identifier, name: Type.String({ minLength: 1, maxLength: 120 }) },
    { additionalProperties: false },
  ),
  deleteLibraryFolder: Type.Object(
    { ...libraryScope, folderId: Identifier },
    { additionalProperties: false },
  ),
  moveLibraryItem: Type.Object(
    { ...libraryScope, itemId: Identifier, folderId: Type.Union([Identifier, Type.Null()]) },
    { additionalProperties: false },
  ),
  removeLibraryItem: Type.Object(
    { ...libraryScope, itemId: Identifier },
    { additionalProperties: false },
  ),
  registerLibrary: Type.Object(
    { ...assetSession, assetId: Identifier, folderId: Type.Optional(Identifier) },
    { additionalProperties: false },
  ),
  attachOfficialVoice: Type.Object(
    {
      ...assetSession,
      operationId: Identifier,
      file: Type.String({ pattern: "^fz-asset-[a-zA-Z0-9-]+-audio\\.(wav|mp3)$", maxLength: 150 }),
    },
    { additionalProperties: false },
  ),
  attachLibrary: Type.Object(
    { ...assetSession, itemId: Identifier, operationId: Identifier },
    { additionalProperties: false },
  ),
  captureCanvasClipboard: Type.Object(
    { ...assetSession, assetIds: Type.Array(Identifier, { uniqueItems: true, maxItems: 10000 }) },
    { additionalProperties: false },
  ),
  pasteCanvasClipboard: Type.Object(
    { ...assetSession, token: Identifier },
    { additionalProperties: false },
  ),
  removeAsset: Type.Object(
    { ...assetSession, operationId: Identifier, expectedRevision: Revision, assetId: Identifier },
    { additionalProperties: false },
  ),
  getAssetPreview: Type.Object(
    {
      ...assetSession,
      assetId: Identifier,
      variant: Type.Optional(Type.Union([Type.Literal("poster"), Type.Literal("thumb")])),
      library: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  readAudioForWaveform: mediaAssetRequest,
  copyAssetImage: Type.Object(
    { ...assetSession, assetId: Identifier },
    { additionalProperties: false },
  ),
  saveAssetCopy: mediaAssetRequest,
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
  attachDirectorTake: Type.Object(
    {
      ...assetSession,
      operationId: Identifier,
      name: Type.String({ minLength: 1, maxLength: 251 }),
      frameName: Type.Optional(Type.String({ minLength: 1, maxLength: 251 })),
      mp4: Type.Uint8Array({ minByteLength: 16, maxByteLength: 200 * 1024 * 1024 }),
      png: Type.Optional(Type.Uint8Array({ minByteLength: 16, maxByteLength: 20 * 1024 * 1024 })),
    },
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
  drama: "link-studio:drama:document",
  estimateDramaScripts: "link-studio:drama:estimate-scripts",
  estimateDramaBreakdown: "link-studio:drama:estimate-breakdown",
  estimateDramaStoryboard: "link-studio:drama:estimate-storyboard",
  estimateDramaContinuation: "link-studio:drama:estimate-continuation",
  previewDramaSource: "link-studio:drama:preview-source",
  canvasAgent: "link-studio:canvas-agent:action",
  listJobs: "link-studio:jobs:list",
  submitJob: "link-studio:jobs:submit",
  submitJobs: "link-studio:jobs:submitBatch",
  cancelJob: "link-studio:jobs:cancel",
  retryCharacterImage: "link-studio:jobs:retry-character-image",
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
  droppedMedia: "link-studio:dialogs:droppedMedia",
  beginClipboardFile: "link-studio:assets:beginClipboardFile",
  appendClipboardFile: "link-studio:assets:appendClipboardFile",
  importAsset: "link-studio:assets:import",
  startImport: "link-studio:assets:startImport",
  attachImage: "link-studio:assets:attachImage",
  attachFiledImage: "link-studio:assets:attachFiledImage",
  enrollImage: "link-studio:assets:enrollImage",
  filingLibraryPage: "link-studio:library:filingPage",
  filingLibraryClose: "link-studio:library:filingClose",
  filingLibraryEnroll: "link-studio:library:filingEnroll",
  filingLibraryUpload: "link-studio:library:filingUpload",
  filingLibraryUploaded: "link-studio:library:filingUploaded",
  filingLibraryCancelUpload: "link-studio:library:filingCancelUpload",
  filingLibraryMore: "link-studio:library:filingMore",
  getImport: "link-studio:assets:getImport",
  cancelImport: "link-studio:assets:cancelImport",
  commitImport: "link-studio:assets:commitImport",
  discardMedia: "link-studio:assets:discardMedia",
  listAssets: "link-studio:assets:list",
  listLibrary: "link-studio:library:list",
  globalHistory: "link-studio:library:globalHistory",
  collectHistory: "link-studio:library:collectHistory",
  globalLibrary: "link-studio:library:globalList",
  importGlobalAsset: "link-studio:library:importGlobalAsset",
  dropGlobalAsset: "link-studio:library:dropGlobalAsset",
  cancelGlobalImport: "link-studio:library:cancelGlobalImport",
  registerLibrary: "link-studio:library:register",
  attachOfficialVoice: "link-studio:assets:attachOfficialVoice",
  attachLibrary: "link-studio:library:attach",
  createLibraryFolder: "link-studio:library:createFolder",
  listLibraryFolders: "link-studio:library:listFolders",
  renameLibraryFolder: "link-studio:library:renameFolder",
  deleteLibraryFolder: "link-studio:library:deleteFolder",
  moveLibraryItem: "link-studio:library:moveItem",
  removeLibraryItem: "link-studio:library:removeItem",
  removeAsset: "link-studio:assets:remove",
  getAssetPreview: "link-studio:assets:getPreview",
  captureCanvasClipboard: "link-studio:canvas:captureClipboard",
  pasteCanvasClipboard: "link-studio:canvas:pasteClipboard",
  readAudioForWaveform: "link-studio:assets:readAudioForWaveform",
  copyAssetImage: "link-studio:assets:copyImage",
  saveAssetCopy: "link-studio:assets:saveCopy",
  inspectAsset: "link-studio:assets:inspect",
  trimAsset: "link-studio:assets:trim",
  splitAsset: "link-studio:assets:split",
  annotateAsset: "link-studio:assets:annotate",
  exportComposition: "link-studio:composition:export",
  attachDirectorTake: "link-studio:director:attachTake",
  cancelMediaTool: "link-studio:assets:cancelMediaTool",
  relocateAsset: "link-studio:assets:relocate",
  applyCanvasOperations: "link-studio:canvas:applyOperations",
} as const;

export type ProjectMethod = keyof typeof ProjectRequests;
export type ProjectRequest<Method extends ProjectMethod> = Static<(typeof ProjectRequests)[Method]>;

export interface ProjectActivation {
  projectHandle: string;
  directoryToken: string;
  recentEntryId?: string;
}

export interface ProjectSession {
  projectKind?: "canvas" | "drama";
  projectHandle: string;
  projectId: string;
  name: string;
  schemaVersion: 1;
  revision: number;
  recoveredFromPrevious: boolean;
}

export interface RecentProject {
  activity?: { label: string; count: number; progress?: number };
  projectKind?: "canvas" | "drama";
  recentEntryId: string;
  projectId: string;
  displayName: string;
  displayPath: string;
  lastOpenedAt: string;
}

export interface LibraryFolder {
  id: string;
  name: string;
  createdAt: string;
  itemCount: number;
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
  | keyof typeof import("./agent-reference-errors.ts").agentReferenceErrors
  | "AGENT_SCOPE_DENIED"
  | "AGENT_MESSAGE_REFERENCE_INVALID"
  | "AGENT_RUN_BUSY"
  | "AGENT_APPROVAL_STALE"
  | "AGENT_OVER_BUDGET"
  | "AGENT_GENERATION_PRICE_UNKNOWN"
  | "DRAMA_EPISODE_LOCKED"
  | "DRAMA_STEP_NOT_READY"
  | "DRAMA_NOTHING_TO_COMPOSE"
  | "DRAMA_NO_TEXT_MODEL"
  | "DRAMA_CONTEXT"
  | "DRAMA_SOURCE_EXPIRED"
  | "DRAMA_JOB_CONFLICT"
  | "DRAMA_STORYBOARD_HAS_TAKES"
  | "AGENT_MODEL_UNAVAILABLE"
  | "AGENT_MODEL_BINDING_STALE"
  | "AGENT_MODEL_CAPABILITY_UNSUPPORTED"
  | "AGENT_MEDIA_UNAVAILABLE"
  | "AGENT_MEDIA_LIMIT"
  | "AGENT_READ_REQUIRED"
  | "AGENT_RUNTIME_FAILED"
  | "JOB_MODEL_UNAVAILABLE"
  | "JOB_QUEUE_FULL"
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

export const projectImportConcurrency = 3;
export type ImportStatus = { copiedBytes: number; totalBytes: number } & (
  | { phase: "copying" | "committing" | "cancelled" | "conflict" }
  | { phase: "duplicate"; candidateAssetIds: string[] }
  | { phase: "imported"; asset: ProjectAsset; revision: number }
  | { phase: "failed"; code: string; retryToken?: string }
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
  drama: DramaDocument | null;
  estimateDramaScripts: number;
  estimateDramaBreakdown: number;
  estimateDramaStoryboard: { credits: number; clearHash?: string };
  estimateDramaContinuation: {
    credits: number;
    episodeMin: number;
    episodeMax: number;
    minutes: number;
  };
  previewDramaSource: DramaSourcePreview;
  canvasAgent: CanvasAgentValues[keyof CanvasAgentValues];
  listJobs: { jobs: GenerationJob[]; revision: number; canvasRevision: number };
  submitJob: GenerationJob;
  submitJobs: GenerationJob[];
  cancelJob: GenerationJob;
  retryCharacterImage: GenerationJob;
  recheckJob: GenerationJob;
  selectProject: { cancelled: true } | { cancelled: false; directoryToken: string };
  selectProjectParent:
    | { cancelled: true }
    | { cancelled: false; directoryToken: string; displayPath: string };
  create: ProjectSession;
  open:
    | { disposition: "opened"; session: ProjectSession }
    | { disposition: "focusedExisting" }
    | {
        disposition: "readOnly";
        name: string;
        revision: number;
        canvas: ProjectCanvasView;
        directoryToken: string;
      };
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
  droppedMedia: ProjectValues["selectMedia"];
  beginClipboardFile: { fileToken: string; displayName: string };
  appendClipboardFile: { received: number };
  importAsset:
    | { asset: ProjectAsset; revision: number }
    | { duplicate: true; candidateAssetIds: string[]; revision: number };
  startImport: { importSessionId: string };
  attachImage: { asset: ProjectAsset; revision: number };
  attachFiledImage: ProjectValues["attachImage"];
  enrollImage: { status: "processing" | "failed" | "active" } | { error: string };
  filingLibraryPage: {
    page: string;
    session: string;
    destination: string;
    items: {
      choice: string;
      name: string;
      reason?: string;
      prompt?: string;
      model?: string;
      createdAt?: string;
      inLibrary?: boolean;
    }[];
    selected?: { choice: string; name: string };
    folders: LibraryFolder[];
    canvases?: { id: string; name: string }[];
    next?: number;
  };
  filingLibraryClose: { closed: boolean };
  filingLibraryMore: ProjectValues["filingLibraryPage"];
  filingLibraryUpload: { receipt: string };
  filingLibraryUploaded: {
    item: ProjectValues["filingLibraryPage"]["items"][number];
    folders: LibraryFolder[];
  };
  filingLibraryCancelUpload: { cancelled: boolean };
  filingLibraryEnroll: ProjectValues["enrollImage"];
  getImport: ImportStatus;
  cancelImport: ImportStatus;
  commitImport: ImportStatus;
  discardMedia: { discarded: true };
  listAssets: { assets: ProjectAsset[] };
  listLibrary: {
    items: { asset: ProjectAsset; sourceId?: string; folderId: string | null }[];
    folders: LibraryFolder[];
    removedSourceIds?: string[];
    next?: number;
  };
  listLibraryFolders: LibraryFolder[];
  globalLibrary: ProjectValues["listLibrary"];
  importGlobalAsset: { imported: boolean };
  dropGlobalAsset: { imported: boolean };
  cancelGlobalImport: { cancelled: boolean };
  collectHistory: { saved: true };
  globalHistory: {
    canvases: { id: string; name: string }[];
    items: {
      id: string;
      name: string;
      prompt: string;
      saved: boolean;
      model: string;
      createdAt: string;
      canvasId: string;
      bytes: number;
      durationMs: number;
      aspect: number;
    }[];
    next?: { created: number; id: string };
  };
  createLibraryFolder: LibraryFolder;
  renameLibraryFolder: { updated: true };
  deleteLibraryFolder: { removed: number };
  moveLibraryItem: { updated: true };
  removeLibraryItem: { updated: true };
  registerLibrary: ProjectAsset;
  attachOfficialVoice: ProjectValues["attachImage"];
  attachLibrary: ProjectValues["attachImage"];
  removeAsset: { removed: true; revision: number };
  getAssetPreview: { url: string; mimeType: string };
  captureCanvasClipboard: { token: string };
  pasteCanvasClipboard: { ids: Record<string, string>; assets: ProjectAsset[]; revision: number };
  readAudioForWaveform: { bytes: Uint8Array };
  copyAssetImage: { copied: true };
  saveAssetCopy: { saved: boolean };
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
  attachDirectorTake: { assets: ProjectAsset[]; revision: number };
  cancelMediaTool: { requested: boolean };
  relocateAsset: { revision: number };
  applyCanvasOperations: { revision: number; canvasRevision: number };
}

type WithoutRequestId<Input> = Input extends unknown ? Omit<Input, "requestId"> : never;
export type ProjectsAPI = {
  [Method in Exclude<
    ProjectMethod,
    "selectProject" | "selectProjectParent" | "selectMedia" | "droppedMedia" | "dropGlobalAsset"
  >]: (
    input: WithoutRequestId<ProjectRequest<Method>>,
  ) => Promise<ProjectResult<ProjectValues[Method]>>;
};

export interface ProjectDialogsAPI {
  dropGlobalAsset(
    file: File,
    operationId: string,
    folder?: string,
  ): Promise<ProjectResult<ProjectValues["dropGlobalAsset"]>>;
  uploadTrialReference(
    file: File,
    maximum: number,
  ): Promise<{ ok: true; url?: string } | { ok: false }>;
  droppedMedia(
    projectHandle: string,
    files: File[],
  ): Promise<ProjectResult<ProjectValues["droppedMedia"]>>;
  selectProject(): Promise<ProjectResult<ProjectValues["selectProject"]>>;
  selectProjectParent(): Promise<ProjectResult<ProjectValues["selectProjectParent"]>>;
  selectMedia(
    input: Omit<ProjectRequest<"selectMedia">, "requestId">,
  ): Promise<ProjectResult<ProjectValues["selectMedia"]>>;
}
