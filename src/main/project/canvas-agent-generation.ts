import {
  configuredGenerationInput,
  fanoutFields,
  type GenerationInput,
  jobIsTerminal,
  type ProjectCanvasView,
  type SettingsValues,
} from "@link-studio/core";
import type { GenerationKind } from "../../../packages/link-studio-core/src/generation";
import type { ModelConfig } from "../../../packages/link-studio-core/src/model-config";
import { paramNames } from "../../../packages/link-studio-core/src/model-document";
import { quoteModel } from "../../../packages/link-studio-core/src/model-price";
import type { ProjectState } from "../../../packages/link-studio-core/src/project";
import { composeLinkedPrompt } from "../../shared/compose-canvas-prompt";
import { boundModel } from "./canvas-agent-model";
import { agentReferenceInput, agentSources, type RoleJob } from "./canvas-agent-references";
import { CanvasGenerationFeedback, ProjectError } from "./errors";

export function quotePreparedGeneration(
  config: ModelConfig | undefined,
  kind: GenerationKind,
  input: GenerationInput,
  assets: Readonly<Record<string, Pick<ProjectState["assets"][string], "mediaType">>>,
) {
  if (!config?.pricing) return undefined;
  const params: Record<string, string | number | boolean> = { ...input.customParams };
  for (const [field, wire] of Object.entries(paramNames)) {
    const value = input[field as keyof typeof paramNames];
    if (value !== undefined) params[field] = params[wire] = value;
  }
  if (input.generateAudio !== undefined)
    params.generate_audio = params.generateAudio = input.generateAudio;
  const estimate = quoteModel(config.pricing, {
    op:
      kind === "image"
        ? input.referenceAssetIds.length ||
          (config.modes?.includes("i2i") && !config.modes.includes("t2i"))
          ? "i2i"
          : "t2i"
        : input.op,
    refVideo: input.referenceAssetIds.some((id) => assets[id]?.mediaType === "video"),
    params,
    promptChars: Array.from(input.prompt).length + Array.from(config.systemPrompt ?? "").length,
    outputTokens: config.maxOutputTokens,
  });
  return estimate === undefined ? undefined : Math.max(0, estimate);
}

export function nodeGenerationInput(
  graph: ProjectCanvasView,
  revision: number,
  nodeId: string,
  assets: ProjectState["assets"],
  settings: SettingsValues["list"],
  jobs: readonly RoleJob[],
): GenerationInput {
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  if (node?.type !== "creative" || node.data.storyboard || node.data.director)
    throw new ProjectError("JOB_INPUT_INVALID", "请选择可生成的节点");
  const data = node.data,
    draft = data.generation;
  const name = `节点 ${JSON.stringify(nodeId)}（${data.label}）`;
  if (data.assetId || data.outputs?.length || data.uploaded)
    throw new CanvasGenerationFeedback(
      "JOB_INPUT_INVALID",
      `${name}已经有产物，生成不会覆盖已有产物。需要新版本请用 canvas_apply_ops 新建一个节点再申请生成。`,
    );
  if (jobs.some((job) => job.nodeId === nodeId && !job.purpose && !jobIsTerminal(job.status)))
    throw new CanvasGenerationFeedback("JOB_INPUT_INVALID", `${name}正在生成中。`);
  const key = draft?.providerId ?? draft?.modelKey;
  if (!key)
    throw new CanvasGenerationFeedback(
      "JOB_MODEL_UNAVAILABLE",
      `${name}还没有选模型。先用 model_list 挑一个，再用 canvas_apply_ops 的 update_node 设置 model；用户没指定模型时用 ask_user（kind=model）问。`,
    );
  const bound = boundModel(data, settings);
  const plugin =
    bound && settings.plugins.find((entry) => entry.hash === bound.provider.pluginHash);
  if (
    !bound?.provider.enabled ||
    bound.provider.pending ||
    bound.provider.channelEnabled === false ||
    bound.provider.config?.kind === "agent" ||
    plugin?.disabled
  )
    throw new CanvasGenerationFeedback(
      "JOB_MODEL_UNAVAILABLE",
      `${name}选的模型 ${JSON.stringify(key)} 不可用或已下线，请用 model_list 重新挑选。`,
    );
  const { provider: target, options, modes } = bound;
  const kind = data.kind === "script" ? "text" : data.kind;
  const modelKind = target.config?.kind ?? plugin?.kind;
  if (modelKind && modelKind !== kind)
    throw new CanvasGenerationFeedback(
      "JOB_INPUT_INVALID",
      `${name}是${data.kind}节点，模型 ${JSON.stringify(key)} 是${modelKind}模型，种类对不上。`,
    );
  const sources = agentSources(graph, nodeId);
  let references: ReturnType<typeof agentReferenceInput>;
  try {
    references = agentReferenceInput(
      sources,
      data,
      assets,
      jobs,
      options,
      modes,
      !target.config?.generateAudio ||
        configuredGenerationInput(target.config, { ...draft?.params }).generateAudio !== false,
    );
  } catch (error) {
    if (error instanceof CanvasGenerationFeedback)
      throw new CanvasGenerationFeedback(error.code, `${name}：${error.message}`);
    throw error;
  }
  const { mode: op, refs } = references;
  const prompt = composeLinkedPrompt(data.text, sources, kind === "video", refs, "agent");
  const length = Array.from(prompt).length;
  const promptError = !prompt.trim()
    ? "提示词不能为空"
    : length > options.promptLimit
      ? `提示词不能超过 ${options.promptLimit} 个字符（当前 ${length} 个）`
      : undefined;
  if (promptError)
    throw new CanvasGenerationFeedback(
      "JOB_INPUT_INVALID",
      `${name}的参数不合法：prompt：${promptError}。请用 canvas_apply_ops 修正后再申请。`,
    );
  const params = { ...draft?.params };
  if (draft?.sizeInput) {
    params.size = draft.sizeInput;
    delete params.aspectRatio;
    delete params.resolution;
  }
  if (draft?.durationInput) params.duration = Number(draft.durationInput);
  else if (params.duration === undefined && data.videoDuration !== undefined)
    params.duration = data.videoDuration;
  if (params.count !== undefined || target.config?.params?.count) params.count = 1;
  for (const [key] of fanoutFields(target.config)) {
    const custom = target.config?.customParams?.[key];
    if (custom)
      params.customParams = {
        ...params.customParams,
        [key]: custom.type === "enum" && custom.values.includes("1") ? "1" : 1,
      };
    else Object.assign(params, { [key]: 1 });
  }
  return {
    ...params,
    nodeId,
    providerId: target.id,
    expectedProviderRevision: target.revision,
    expectedCanvasRevision: revision,
    prompt,
    referenceAssetIds: refs.map((asset) => asset.assetId),
    ...(op === "t2v" || op === "i2v" || op === "omni" ? { op } : {}),
  };
}
