import { type Static, Type } from "@sinclair/typebox";
import { DramaImageParams } from "./drama-image-params.ts";
import { PromptChanges, PromptPicks, PromptSnapshots } from "./drama-prompts.ts";
import styleCatalog from "./drama-styles.json" with { type: "json" };
import { modelGenerationModes, modelGenerationOptions } from "./media-generation.ts";
import type { PluginView, ProviderView } from "./settings-api.ts";

export const dramaStyles = styleCatalog;
export const defaultDramaStyle = "real_city_film";

export function dramaVideoModelIssue(
  model: Pick<ProviderView, "model" | "pluginHash" | "channel" | "config">,
  plugins: ReadonlyArray<Pick<PluginView, "hash" | "key" | "origin">>,
) {
  const plugin = plugins.find((entry) => entry.hash === model.pluginHash);
  const options = modelGenerationOptions(
    "video",
    plugin?.origin === "builtin" ? plugin.key : undefined,
    model.model,
    model.channel,
    model.config,
  );
  if (!(options.references.image && options.references.image > 0))
    return "不支持参考图，片段里的 @ 资产会失效";
  const modes = options.modes ?? modelGenerationModes("video", options);
  return modes.includes("i2v") || modes.includes("omni")
    ? ""
    : "只支持文生视频，没有图生 / 参考图方式";
}

export function dramaAgentModels(providers: ProviderView[], preferred = "") {
  return providers
    .filter(
      (model) =>
        model.enabled && model.agentEnabled && model.hasSecret && model.channelEnabled !== false,
    )
    .sort(
      (first, second) =>
        Number(second.id === preferred) - Number(first.id === preferred) ||
        (first.config?.sort ?? 100) - (second.config?.sort ?? 100),
    );
}

const strict = { additionalProperties: false };
const text = Type.String({ maxLength: 24000 });
const title = Type.String({ minLength: 1, maxLength: 255 });
const episodeNo = Type.Integer({ minimum: 1, maximum: 100000 });
const seconds = Type.Integer({ minimum: 1, maximum: 86400 });
const segmentId = Type.String({ pattern: "^[0-9a-f]{32}$" });
const revision = Type.Integer({ minimum: 1 });
const imageModelChoice = Type.String({
  pattern: "^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})?$",
});
export const DramaBoardSettings = Type.Object(
  {
    textModel: Type.Optional(imageModelChoice),
    characterModel: Type.Optional(imageModelChoice),
    propModel: Type.Optional(imageModelChoice),
    sceneModel: imageModelChoice,
    boardModel: imageModelChoice,
    template: Type.Optional(Type.String({ minLength: 1, maxLength: 24000 })),
  },
  strict,
);
export type DramaBoardSettings = Static<typeof DramaBoardSettings>;
export const UpdateDramaBoardSettings = Type.Object(
  { revision, settings: DramaBoardSettings, prompts: Type.Optional(PromptChanges) },
  strict,
);
export const DramaJobRequest = Type.Object(
  {
    step: Type.Union(
      (["scripts", "breakdown", "asset_prompts", "storyboard", "compose"] as const).map((step) =>
        Type.Literal(step),
      ),
    ),
    episodes: Type.Array(episodeNo, { maxItems: 200 }),
    reason: Type.Optional(Type.String({ maxLength: 500 })),
    ratio: Type.Optional(
      Type.Union(
        (["9:16", "16:9", "21:9", "3:4", "4:3", "1:1"] as const).map((ratio) =>
          Type.Literal(ratio),
        ),
      ),
    ),
    max_seconds: Type.Optional(Type.Integer({ minimum: 4, maximum: 60 })),
  },
  strict,
);
export type DramaJobRequest = Static<typeof DramaJobRequest>;
export const DramaJobRecord = Type.Object(
  {
    id: segmentId,
    step: DramaJobRequest.properties.step,
    episodes: Type.Array(episodeNo, { maxItems: 200 }),
    request: DramaJobRequest,
    progress: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
    status: Type.Union(
      (["queued", "running", "succeeded", "failed", "canceled"] as const).map((status) =>
        Type.Literal(status),
      ),
    ),
    frozen_credits: Type.Integer({ minimum: 0 }),
    model: Type.Optional(Type.Object({ id: Type.String(), revision }, strict)),
    created_at: Type.String(),
    compose_input: Type.Optional(
      Type.Object(
        {
          segment_version: Type.Integer({ minimum: 0 }),
          asset_ids: Type.Array(Type.String(), { minItems: 1 }),
          skipped_seqs: Type.Array(Type.Integer({ minimum: 0 })),
        },
        strict,
      ),
    ),
    final_asset_id: Type.Optional(Type.String()),
    approval_id: Type.String({ minLength: 1 }),
    approval_hash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    prompt_snapshots: Type.Optional(PromptSnapshots),
    done_episodes: Type.Optional(Type.Array(episodeNo)),
    known_cast: Type.Optional(
      Type.Array(
        Type.Object(
          {
            type: Type.String(),
            name: Type.String(),
            aliases: Type.Array(Type.String()),
            look: Type.Optional(Type.String()),
            desc: Type.Optional(Type.String()),
          },
          strict,
        ),
      ),
    ),
    new_nodes: Type.Optional(Type.Array(Type.String())),
    prompted_nodes: Type.Optional(Type.Array(Type.String())),
    error_message: Type.Optional(Type.String()),
  },
  strict,
);
export type DramaJobRecord = Static<typeof DramaJobRecord>;
export const AddDramaEpisode = Type.Object({ revision, title, script_md: text }, strict);
const episodeOrder = Type.Integer({ minimum: 0 });
export const DeleteDramaEpisode = Type.Object({ episode_no: episodeNo, episodeOrder }, strict);
export const SaveDramaScript = Type.Object(
  {
    revision,
    episodeOrder: Type.Optional(episodeOrder),
    episode_no: episodeNo,
    script_md: Type.String({ maxLength: 120000 }),
  },
  strict,
);
export const AddDramaSegment = Type.Object(
  {
    episode_no: episodeNo,
    prompt: Type.String({ minLength: 1, maxLength: 24000 }),
    seconds,
    revision,
  },
  strict,
);
export const DramaRead = Type.Object(
  {
    scope: Type.Union([
      Type.Literal("overview"),
      Type.Literal("episode"),
      Type.Literal("segments"),
    ]),
    episode_no: Type.Optional(episodeNo),
  },
  strict,
);
export const DramaEdits = {
  drama_update_segment: Type.Object(
    {
      segment_id: segmentId,
      prompt: Type.Optional(text),
      seconds: Type.Optional(seconds),
      reason: Type.Optional(Type.String({ maxLength: 500 })),
    },
    strict,
  ),
  drama_update_outline: Type.Object(
    {
      reason: Type.Optional(Type.String({ maxLength: 500 })),
      outline_md: Type.Optional(text),
      characters_md: Type.Optional(text),
    },
    strict,
  ),
  drama_update_episode: Type.Object(
    {
      reason: Type.Optional(Type.String({ maxLength: 500 })),
      episode_no: episodeNo,
      title: Type.Optional(title),
      synopsis: Type.Optional(text),
      script_md: Type.Optional(text),
    },
    strict,
  ),
};
export const DramaSourceFields = {
  sourceKind: Type.Optional(Type.Union([Type.Literal("script"), Type.Literal("novel")])),
  rangeEnd: Type.Optional(Type.Integer({ minimum: 0 })),
  textModel: Type.Optional(imageModelChoice),
  script: Type.String({ minLength: 1, maxLength: 5_000_000 }),
  episodeSeconds: Type.Optional(Type.Integer({ minimum: 30, maximum: 180 })),
};
export interface DramaSourcePreview {
  sourceToken?: string;
  kindGuess?: "novel" | "script" | "unknown";
  planning?: {
    rangeEnd: number;
    episodeMin: number;
    episodeMax: number;
    batches: number;
    minutes: number;
  };
  credits: number;
  kindSignals: string;
  issues: {
    kind: "noise_removed" | "empty" | "duplicate" | "split_long" | "episode_too_long";
    count: number;
    message: string;
  }[];
  chars: number;
  kind: string;
  units: number;
  exactEpisodes?: number;
}
const StartRatio = Type.Union([Type.Literal("9:16"), Type.Literal("16:9"), Type.Literal("4:3")]);
export type DramaStartRatio = Static<typeof StartRatio>;
export const DramaSource = Type.Object(
  {
    title,
    ...DramaSourceFields,
    prompts: Type.Optional(PromptPicks),
    imageParams: Type.Optional(DramaImageParams),
    genre: Type.Optional(Type.String({ maxLength: 32 })),
    styleKey: Type.Optional(Type.String({ maxLength: 32 })),
    styleCustom: Type.Optional(Type.String({ maxLength: 500 })),
    ratio: Type.Optional(StartRatio),
    videoModel: Type.Optional(imageModelChoice),
    imageModels: Type.Optional(
      Type.Object(
        { character: imageModelChoice, scene: imageModelChoice, prop: imageModelChoice },
        strict,
      ),
    ),
  },
  strict,
);
export type DramaSource = Static<typeof DramaSource>;
export const DramaDocument = Type.Object(
  {
    revision: Type.Integer({ minimum: 1 }),
    episode_order: Type.Optional(episodeOrder),
    overview_revision: Type.Optional(revision),
    board_settings: Type.Optional(DramaBoardSettings),
    board_settings_revision: Type.Optional(revision),
    ratio: Type.Optional(StartRatio),
    video_model: Type.Optional(imageModelChoice),
    image_params: Type.Optional(DramaImageParams),
    prompt_snapshots: Type.Optional(PromptSnapshots),
    genre: Type.Optional(Type.String({ maxLength: 32 })),
    style_key: Type.Optional(Type.String({ maxLength: 32 })),
    style_custom: Type.Optional(Type.String({ maxLength: 500 })),
    title,
    status: Type.Optional(
      Type.Union(
        (["outlined", "scripting", "failed", "ready"] as const).map((status) =>
          Type.Literal(status),
        ),
      ),
    ),
    episode_seconds: Type.Optional(Type.Integer({ minimum: 30, maximum: 180 })),
    outline_md: text,
    characters_md: text,
    planning: Type.Optional(
      Type.Object(
        {
          model: Type.Object({ id: imageModelChoice, revision }, strict),
          phase: Type.Union([
            Type.Literal("running"),
            Type.Literal("paused"),
            Type.Literal("done"),
          ]),
          summary: text,
          cursor: Type.Integer({ minimum: 0 }),
          end: episodeNo,
          recent_batches: Type.Optional(Type.Array(episodeNo, { maxItems: 3 })),
          pause_code: Type.String(),
          pause_reason: Type.String(),
          pending: Type.Optional(
            Type.Object(
              {
                id: segmentId,
                step: Type.Union([Type.Literal("analyze"), Type.Literal("plan")]),
                from: episodeNo,
                to: episodeNo,
                input: Type.String(),
                created_at: Type.String(),
                progress: Type.Optional(Type.Literal(50)),
                body: Type.Optional(Type.String()),
                model: Type.Optional(Type.Object({ id: imageModelChoice, revision }, strict)),
              },
              strict,
            ),
          ),
        },
        strict,
      ),
    ),
    jobs: Type.Optional(Type.Array(DramaJobRecord)),
    source: Type.Optional(
      Type.Object(
        {
          text,
          textBlob: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
          chars: Type.Integer({ minimum: 1 }),
          kind: Type.String(),
          total: Type.Integer({ minimum: 1 }),
          draftToken: Type.Optional(Type.String()),
          filename: Type.Optional(Type.String({ maxLength: 255 })),
          sha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
        },
        strict,
      ),
    ),
    segments: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: segmentId,
            episode_no: episodeNo,
            seq: Type.Integer({ minimum: 0 }),
            prompt: text,
            seconds,
            revision,
            take_ids: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })),
            chosen_task_id: Type.Optional(Type.String()),
          },
          strict,
        ),
        { maxItems: 5000 },
      ),
    ),
    episodes: Type.Array(
      Type.Object(
        {
          episode_no: episodeNo,
          title,
          synopsis: text,
          script_md: Type.String({ maxLength: 120000 }),
          unit_from: Type.Optional(episodeNo),
          unit_to: Type.Optional(episodeNo),
          revision: Type.Optional(revision),
          locked: Type.Optional(Type.Boolean()),
          hook: Type.Optional(text),
          cliffhanger: Type.Optional(text),
          script_status: Type.Optional(
            Type.Union([Type.Literal("failed"), Type.Literal("empty"), Type.Literal("ready")]),
          ),
          updated_at: Type.Optional(Type.String()),
          storyboard_status: Type.Optional(
            Type.Union(
              (["empty", "generating", "ready", "failed"] as const).map((status) =>
                Type.Literal(status),
              ),
            ),
          ),
          segment_version: Type.Optional(Type.Integer({ minimum: 0 })),
          final_segment_version: Type.Optional(Type.Integer({ minimum: 0 })),
          final_asset_id: Type.Optional(Type.String()),
        },
        strict,
      ),
      { maxItems: 100000 },
    ),
  },
  strict,
);
export type DramaDocument = Static<typeof DramaDocument>;

export function dramaBusyReason(doc: DramaDocument) {
  const job = doc.jobs?.find((entry) => entry.status === "queued" || entry.status === "running");
  if (!job) return "";
  const name = {
    scripts: "分集剧本",
    breakdown: "资产拆解",
    asset_prompts: "写资产提示词",
    storyboard: "分镜脚本",
    compose: "合成整集",
  }[job.step];
  const scope =
    job.step === "asset_prompts" || !job.episodes.length
      ? ""
      : job.episodes.length === 1 && job.step !== "scripts"
        ? ` · 第 ${job.episodes[0]} 集`
        : ` · ${job.episodes.length} 集`;
  return `有进行中的任务：${name}${scope}`;
}

export function dramaDeleteBlocked(doc: DramaDocument) {
  return doc.planning?.phase === "running" ? "正在规划，完成或暂停后再操作" : dramaBusyReason(doc);
}
