import {
  type CreativeData,
  type generationModes,
  modelGenerationModes,
  modelGenerationOptions,
  type SettingsValues,
  validCustomName,
  validCustomValue,
} from "@link-studio/core";
import { Value } from "@sinclair/typebox/value";
import { GenerationParameters } from "../../../packages/link-studio-core/src/generation-parameters";
import {
  canvasParameterKey,
  exportVideoCanvasParameters,
} from "../../../packages/link-studio-core/src/video-canvas-parameters";
import { ProjectError } from "./errors";

type Mode = (typeof generationModes)[number];
type NodeSettings = {
  model?: string;
  mode?: Mode;
  params?: Record<string, string | number | boolean>;
};

export function boundModel(data: CreativeData, settings: SettingsValues["list"]) {
  const key = data.generation?.providerId ?? data.generation?.modelKey;
  const provider = key && settings.providers.find((entry) => entry.id === key);
  if (!provider) return;
  const plugin = settings.plugins.find((entry) => entry.hash === provider.pluginHash);
  const kind = data.kind === "script" ? "text" : data.kind;
  const options = modelGenerationOptions(
    kind,
    plugin?.origin === "builtin" ? plugin.key : undefined,
    provider.model,
    provider.channel,
    provider.config,
  );
  const modes = options.modes ?? modelGenerationModes(kind, options);
  return { provider, options, modes, auto: modes.includes("t2i") && modes.includes("i2i") };
}

export function generationDetail(data: CreativeData, settings: SettingsValues["list"]) {
  const model = data.generation?.providerId ?? data.generation?.modelKey;
  const bound = boundModel(data, settings);
  const chosen = data.videoMode ?? data.imageMode;
  const params = {
    ...data.generation?.params?.customParams,
    ...exportVideoCanvasParameters(data),
    ...(chosen && { op: chosen }),
  };
  return {
    model,
    params,
    mode:
      bound && (data.kind === "video" || data.kind === "image")
        ? bound.auto
          ? { op: "", auto: true }
          : { op: chosen && bound.modes.includes(chosen) ? chosen : "", options: bound.modes }
        : undefined,
  };
}

export function editNodeGeneration(
  data: CreativeData,
  edit: NodeSettings,
  settings: SettingsValues["list"],
): CreativeData {
  if (edit.model === undefined && !edit.mode && !Object.keys(edit.params ?? {}).length) return data;
  const generation = {
    ...data.generation,
    ...(data.generation?.params && { params: { ...data.generation.params } }),
  };
  if (edit.model !== undefined) {
    delete generation.providerId;
    if (edit.model) generation.modelKey = edit.model;
    else delete generation.modelKey;
  }
  const next = { ...data, generation };
  const bound = boundModel(next, settings);
  if (edit.mode) {
    const imageMode = edit.mode === "t2i" || edit.mode === "i2i";
    if (data.kind !== (imageMode ? "image" : "video"))
      throw new ProjectError("CANVAS_OPERATION_INVALID", "生成方式与节点类型不符");
    if (!(generation.providerId ?? generation.modelKey))
      throw new ProjectError("CANVAS_OPERATION_INVALID", "请先给节点选择模型");
    if (bound?.auto)
      throw new ProjectError("CANVAS_OPERATION_INVALID", "此模型根据参考图自动选择生成方式");
    if (bound && !bound.modes.includes(edit.mode))
      throw new ProjectError("CANVAS_OPERATION_INVALID", "此模型不支持所选生成方式");
    if (edit.mode === "t2i" || edit.mode === "i2i") next.imageMode = edit.mode;
    else next.videoMode = edit.mode;
  }
  for (const [name, value] of Object.entries(edit.params ?? {})) {
    generation.params ??= {};
    const params = generation.params;
    const key = canvasParameterKey(name);
    if (key) {
      if (!Value.Check(GenerationParameters.properties[key], value))
        throw new ProjectError("CANVAS_OPERATION_INVALID", `检查生成参数 ${name}`);
      Object.assign(params, { [key]: value });
      if (key === "duration") delete generation.durationInput;
      if (key === "size" || key === "aspectRatio" || key === "resolution")
        delete generation.sizeInput;
    } else {
      const config = bound?.provider.config;
      const field = config?.customParams?.[name];
      if (
        !validCustomName(name) ||
        !field ||
        (config?.parameterOrder && !config.parameterOrder.includes(name)) ||
        !validCustomValue(field, value)
      )
        throw new ProjectError("CANVAS_OPERATION_INVALID", `不可写入生成参数 ${name}`);
      params.customParams = { ...params.customParams, [name]: value };
    }
  }
  return next;
}
