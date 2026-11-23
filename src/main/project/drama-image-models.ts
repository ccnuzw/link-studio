import {
  type CanvasOperation,
  dramaAssetMeta,
} from "../../../packages/link-studio-core/src/canvas.ts";
import { canvasAgentMediaModels } from "../../../packages/link-studio-core/src/canvas-agent.ts";
import type { DramaBoardSettings } from "../../../packages/link-studio-core/src/drama.ts";
import { dramaImageFields } from "../../../packages/link-studio-core/src/drama-image-params.ts";
import { modelGenerationOptions } from "../../../packages/link-studio-core/src/media-generation.ts";
import { planModelSwitch } from "../../../packages/link-studio-core/src/model-switch.ts";
import type { ProjectState } from "../../../packages/link-studio-core/src/project.ts";
import type { SettingsValues } from "../../../packages/link-studio-core/src/settings-api.ts";
import { applyCanvas, projectCanvas } from "./canvas.ts";

const assetSlots = { character: "characterModel", scene: "sceneModel", prop: "propModel" } as const;
export function assetModel(
  settings: DramaBoardSettings | undefined,
  type: keyof typeof assetSlots,
) {
  return settings?.[assetSlots[type]] ?? "";
}

export function dramaImageModels(settings: SettingsValues["list"]) {
  return canvasAgentMediaModels(settings)
    .filter((entry) => entry.kind === "image")
    .map(({ provider }) => {
      const plugin = settings.plugins.find((entry) => entry.hash === provider.pluginHash);
      return {
        id: provider.id,
        fields: dramaImageFields(provider, settings.plugins),
        options: modelGenerationOptions(
          "image",
          plugin?.origin === "builtin" ? plugin.key : undefined,
          provider.model,
          provider.channel,
          provider.config,
        ),
      };
    });
}

export function switchDramaAssetModels(
  state: ProjectState,
  previous: DramaBoardSettings | undefined,
  next: DramaBoardSettings,
  models: ReturnType<typeof dramaImageModels>,
) {
  const fallback = models[0];
  if (!fallback) return;
  const running = new Set(
    Object.values(state.jobs).flatMap((job) =>
      job &&
      typeof job === "object" &&
      !Array.isArray(job) &&
      typeof job.nodeId === "string" &&
      ["queued", "submitting", "running", "downloading"].includes(String(job.status))
        ? [job.nodeId]
        : [],
    ),
  );
  const byId = new Map(models.map((model) => [model.id, model]));
  const operations: CanvasOperation[] = [];
  const assets = Object.values(state.assets);
  for (const node of projectCanvas(state.canvas).nodes) {
    if (
      node.type !== "creative" ||
      node.data.kind !== "image" ||
      node.data.uploaded ||
      node.data.assetId ||
      running.has(node.id)
    )
      continue;
    const meta = dramaAssetMeta(node.data);
    if (!meta?.episodes || assetModel(previous, meta.type) === assetModel(next, meta.type))
      continue;
    const target = byId.get(assetModel(next, meta.type)) ?? fallback;
    const draft = node.data.generation;
    const selected = draft?.providerId ?? draft?.modelKey ?? fallback.id;
    if (selected === target.id) continue;
    const references = node.data.manualReferenceIds ?? [];
    const plan = planModelSwitch(
      (byId.get(selected) ?? fallback).options,
      target.options,
      {
        params: draft?.params ?? {},
        size: draft?.sizeInput ?? "",
        duration: "",
        mode: undefined,
        references,
      },
      assets,
      false,
    );
    operations.push({
      type: "putNode",
      node: {
        ...node,
        data: {
          ...node.data,
          generation: {
            providerId: target.id,
            ...(Object.keys(plan.params).length && { params: plan.params }),
            ...(plan.size && { sizeInput: plan.size }),
          },
          ...(references.length !== plan.references.length && {
            manualReferenceIds: plan.references,
          }),
        },
      },
    });
  }
  if (operations.length) state.canvas = applyCanvas(state, operations);
}
