import type { ProjectErrorCode } from "../../../packages/link-studio-core/src/projects-api.ts";

export type { ProjectErrorCode };

export class ProjectError extends Error {
  constructor(
    readonly code: ProjectErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectError";
  }
}

export class CanvasGenerationFeedback extends ProjectError {}
