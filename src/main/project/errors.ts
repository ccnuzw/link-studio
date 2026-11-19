export type ProjectErrorCode =
  | "PROJECT_IN_USE"
  | "PROJECT_PATH_DENIED"
  | "PROJECT_FILESYSTEM_UNSUPPORTED"
  | "PROJECT_CORRUPT"
  | "PROJECT_VERSION_UNSUPPORTED"
  | "PROJECT_SCHEMA_INVALID"
  | "PROJECT_NAME_INVALID"
  | "PROJECT_CONFLICT"
  | "PROJECT_SAVE_FAILED"
  | "PROJECT_CLOSED"
  | "OPERATION_ID_REUSED";

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
