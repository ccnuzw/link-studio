import { Value } from "@sinclair/typebox/value";
import { dramaAssetMeta } from "../../../packages/link-studio-core/src/canvas.ts";
import { canvasAgentMediaModels } from "../../../packages/link-studio-core/src/canvas-agent.ts";
import {
  type DramaDocument,
  DramaJobRequest,
  type DramaSourcePreview,
  dramaPromptBatchSize,
  dramaVideoModelIssue,
  pendingDramaPromptIds,
} from "../../../packages/link-studio-core/src/drama.ts";
import { modelGenerationOptions } from "../../../packages/link-studio-core/src/media-generation.ts";
import type { ProjectState } from "../../../packages/link-studio-core/src/project.ts";
import { ProviderError } from "../../../packages/provider-runtime/src/runner.ts";
import type { SettingsRegistry } from "../settings/registry.ts";
import { projectCanvas } from "./canvas.ts";
import { segmentTakes } from "./drama.ts";
import {
  checkDramaUnitsFit,
  importPastedDrama,
  novelPlanningBatches,
  preflightDramaSource,
  runeCount,
} from "./drama-source.ts";
import { readDramaText } from "./drama-source-blob.ts";
import { ProjectError } from "./errors.ts";

async function quoteNovelBatches(
  units: ReturnType<typeof preflightDramaSource>["units"],
  end: number,
  seconds: number,
  model: { id: string; revision: number },
  registry: SettingsRegistry,
) {
  const config = registry.agentBinding(model.id, model.revision).profile.config;
  const batches = novelPlanningBatches(units, end, config?.contextWindow);
  let credits = 0;
  const prices = new Map<number, number>();
  for (const batch of batches) {
    const price =
      prices.get(batch.chars) ??
      (await registry.dramaQuoteForModel(model, "plan", batch.chars, [batch.chars]));
    prices.set(batch.chars, price);
    credits += price;
  }
  const chars = units.slice(0, end).reduce((sum, unit) => sum + Array.from(unit.text).length, 0);
  return {
    batches: batches.length,
    credits,
    episodeMin: Math.max(1, Math.ceil((chars * 60) / (2500 * seconds))),
    episodeMax: Math.max(1, Math.ceil((chars * 60) / (1500 * seconds))),
    planSeconds: batches.length * registry.dramaStepSeconds(model, "plan"),
  };
}

export async function quoteDramaSource(
  input: {
    script: string;
    episodeSeconds?: number;
    textModel?: string;
    sourceKind?: "novel" | "script";
    rangeEnd?: number;
  },
  registry: SettingsRegistry,
) {
  const imported =
    input.sourceKind === "novel"
      ? undefined
      : importPastedDrama(input.script, input.episodeSeconds);
  const result = imported ?? preflightDramaSource(input.script, "novel");
  try {
    const chars = runeCount(result.source.text);
    const quote = await registry.dramaJobQuote("analyze", chars, [chars], input.textModel);
    const base = {
      ...(!registry.provider(quote.model.id).config?.pricing && { priceUnavailable: true }),
      kindSignals: result.kindSignals,
      kindGuess: result.kindGuess,
      issues: result.issues,
      chars: result.source.chars,
      kind: result.source.kind,
      units: result.units.length,
    };
    if (!imported) {
      const seconds = input.episodeSeconds ?? 60;
      const end = input.rangeEnd || result.units.length;
      const { credits, batches, episodeMin, episodeMax, planSeconds } = await quoteNovelBatches(
        result.units,
        end,
        seconds,
        quote.model,
        registry,
      );
      return {
        model: quote.model,
        preview: {
          ...base,
          credits: credits + quote.estimate,
          planning: {
            rangeEnd: end,
            batches,
            episodeMin,
            episodeMax,
            minutes: Math.ceil(
              (planSeconds + registry.dramaStepSeconds(quote.model, "analyze")) / 60,
            ),
          },
        },
      };
    }
    checkDramaUnitsFit(
      result.units,
      registry.agentBinding(quote.model.id, quote.model.revision).profile.config?.contextWindow,
    );
    return {
      model: quote.model,
      preview: { ...base, exactEpisodes: imported.episodes.length, credits: quote.estimate },
    };
  } catch (error) {
    if (error instanceof ProviderError && error.code === "DRAMA_NO_TEXT_MODEL")
      throw new ProjectError(
        "DRAMA_NO_TEXT_MODEL",
        "请在模型与渠道中启用 Agent 模型，并为其渠道配置 API Key。",
      );
    throw error;
  }
}

export async function estimateDramaSource(
  input: Parameters<typeof quoteDramaSource>[0],
  registry: SettingsRegistry,
): Promise<DramaSourcePreview> {
  return (await quoteDramaSource(input, registry)).preview;
}

export async function quoteDramaContinuation(
  doc: DramaDocument,
  rangeEnd: number,
  registry: SettingsRegistry,
  directory?: string,
) {
  const plan = doc.planning,
    source = doc.source;
  if (!plan || !source || plan.phase !== "done" || plan.end !== plan.cursor)
    notReady("当前规划阶段不能扩大范围");
  const end = rangeEnd === 0 ? source.total : rangeEnd;
  if (!Number.isInteger(end) || end <= plan.end || end > source.total)
    notReady("新范围必须包含尚未规划的原文");
  const units = preflightDramaSource(await readDramaText(source, directory), "novel").units.slice(
    plan.cursor,
    end,
  );
  return registry.withDramaTextModel(
    doc.board_settings?.textModel || plan.model.id,
    async (model) => {
      const { credits, episodeMin, episodeMax, planSeconds } = await quoteNovelBatches(
        units,
        units.length,
        doc.episode_seconds ?? 60,
        model,
        registry,
      );
      return {
        model,
        end,
        estimate: { credits, episodeMin, episodeMax, minutes: Math.ceil(planSeconds / 60) },
      };
    },
  );
}

function notReady(message: string): never {
  throw new ProjectError("DRAMA_STEP_NOT_READY", message);
}

export function checkStoryboardTakes(doc: DramaDocument, episodeNo: number) {
  if (doc.segments?.some((segment) => segment.episode_no === episodeNo && segment.take_ids?.length))
    throw new ProjectError(
      "DRAMA_STORYBOARD_HAS_TAKES",
      "这一集已有生成结果，重新生成分镜会清空片段",
    );
}

export function storyboardLimits(
  input: DramaJobRequest,
  preferred: string | undefined,
  registry: Pick<SettingsRegistry, "list">,
) {
  const key = input.video_model || preferred;
  if (!key) return { max_seconds: input.max_seconds ?? 15, max_audios: 0 };
  const catalog = registry.list();
  const model = canvasAgentMediaModels(catalog).find(
    (entry) => entry.kind === "video" && entry.provider.id === key,
  )?.provider;
  if (!model || dramaVideoModelIssue(model, catalog.plugins)) {
    if (input.video_model)
      throw new ProjectError("DRAMA_STEP_NOT_READY", "所选视频模型已不可用，请重新选择");
    return { max_seconds: input.max_seconds ?? 15, max_audios: 0 };
  }
  const plugin = catalog.plugins.find((entry) => entry.hash === model.pluginHash);
  const options = modelGenerationOptions(
    "video",
    plugin?.origin === "builtin" ? plugin.key : undefined,
    model.model,
    model.channel,
    model.config,
  );
  const seconds =
    options.durationRange?.max ?? (options.durations.length ? Math.max(...options.durations) : 15);
  return {
    max_seconds: input.max_seconds ?? Math.max(4, Math.min(60, Math.floor(seconds))),
    max_audios: options.references.audio ?? 0,
  };
}

export async function estimateDramaJob(
  doc: DramaDocument,
  input: unknown,
  registry: SettingsRegistry,
  state?: ProjectState,
) {
  if (!Value.Check(DramaJobRequest, input))
    throw new ProjectError("VALIDATION_FAILED", "短剧工具参数格式不对");
  const { step, episodes } = input;
  if ((step === "compose" || step === "storyboard") && episodes.length !== 1)
    throw new ProjectError(
      "VALIDATION_FAILED",
      `${step === "compose" ? "合成" : "分镜"}须且只能选择一集`,
    );
  if (step === "scripts" && doc.source && !doc.planning) notReady("剧本型输入不能生成分集剧本");
  const selected = new Set(episodes);
  if (selected.size !== episodes.length)
    throw new ProjectError("VALIDATION_FAILED", "集号须为1至100000且不能重复");
  const scope = doc.episodes
    .filter((episode) => !selected.size || selected.has(episode.episode_no))
    .sort((first, second) => first.episode_no - second.episode_no);
  for (const episode of scope) {
    if (step === "scripts" && episode.locked)
      throw new ProjectError("DRAMA_EPISODE_LOCKED", "本集已拆解锁定");
    if (
      step === "breakdown" &&
      (episode.locked || episode.script_status === "failed" || !episode.script_md.trim())
    )
      notReady("所选集须已有剧本且尚未拆解");
    if (
      step === "storyboard" &&
      (!episode.locked || episode.script_status === "failed" || !episode.script_md.trim())
    )
      notReady("所选集须已拆解资产且剧本已就绪");
    if (step === "storyboard") checkStoryboardTakes(doc, episode.episode_no);
    if (step === "compose" && !episode.locked) notReady("所选集须已拆解锁定");
  }
  if (scope.length > 200) throw new ProjectError("VALIDATION_FAILED", "单次最多选择200集");
  if (!scope.length || (selected.size && scope.length !== selected.size)) notReady("所选集不存在");
  let nodes: string[] | undefined;
  if (step === "asset_prompts") {
    const numbers = scope.map((episode) => episode.episode_no);
    const blank = state
      ? projectCanvas(state.canvas).nodes.flatMap((node) =>
          node.type === "creative" && dramaAssetMeta(node.data) && !node.data.text?.trim()
            ? [node.id]
            : [],
        )
      : [];
    const jobs = (doc.jobs ?? []).filter(
      (job) => (job.episode_order ?? 0) === (doc.episode_order ?? 0),
    );
    nodes = pendingDramaPromptIds(jobs, numbers, new Set(blank));
    if (!nodes.length) notReady("没有待补写提示词的资产");
  }
  if (step === "compose") {
    const episode = scope[0]!;
    const segments = (doc.segments ?? [])
      .filter((segment) => segment.episode_no === episode.episode_no)
      .sort((left, right) => left.seq - right.seq);
    const asset_ids: string[] = [];
    const skipped_seqs: number[] = [];
    for (const segment of segments) {
      if (!segment.chosen_task_id) {
        skipped_seqs.push(segment.seq);
        continue;
      }
      const take =
        state &&
        segmentTakes(state, segment).find((entry) => entry.task_id === segment.chosen_task_id);
      if (take?.status !== "succeeded" || !take.asset)
        throw new ProjectError("ASSET_READ_FAILED", "采用视频不可用，请重新采用片段");
      asset_ids.push(take.asset.id);
    }
    if (!asset_ids.length)
      throw new ProjectError("DRAMA_NOTHING_TO_COMPOSE", "这一集还没有可合成的片段");
    return {
      estimate: 0,
      episodes: [episode.episode_no],
      compose_input: { segment_version: episode.segment_version ?? 0, asset_ids, skipped_seqs },
    };
  }
  const limits =
    step === "storyboard" ? storyboardLimits(input, doc.video_model, registry) : undefined;
  const quote = await registry.dramaJobQuote(
    step,
    Array.from(doc.outline_md).length + Array.from(doc.planning?.summary ?? "").length,
    scope.map((episode) => Array.from(episode.script_md).length),
    doc.board_settings?.textModel,
  );
  return {
    ...quote,
    ...(limits && { storyboardLimits: limits }),
    ...(nodes && { estimate: quote.estimate * Math.ceil(nodes.length / dramaPromptBatchSize) }),
    episodes: scope.map((episode) => episode.episode_no),
    ...(nodes && { nodes }),
  };
}
