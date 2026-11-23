import type { SettingsValues } from "@link-studio/core";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";

export function TrialFoldableCode({
  text,
  limit = 1500,
  initiallyOpen = false,
}: {
  text: string;
  limit?: number;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const preview = text.split("\n").slice(0, 12).join("\n").slice(0, limit);
  const Icon = open ? ChevronUp : ChevronDown;
  return (
    <div className="trial-foldable-code">
      <pre>{open || preview === text ? text : `${preview}\n…`}</pre>
      {preview !== text && (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon size={12} />
          {open ? "收起" : `展开全部（${text.length} 字符）`}
        </button>
      )}
    </div>
  );
}

export function TrialRequestPreview({
  request,
  time,
}: {
  request: NonNullable<SettingsValues["modelTrial"]["request"]>;
  time: number;
}) {
  let json: unknown = request.body;
  if (request.body) {
    try {
      json = JSON.parse(request.body);
    } catch {
      json = request.body;
    }
  }
  const text = JSON.stringify(
    {
      ...(json !== undefined && { json }),
      method: request.method,
      responseType: request.responseType,
      url: request.endpoint,
    },
    null,
    2,
  );
  return (
    <div className="trial-request-preview">
      <time dateTime={new Date(time).toISOString()}>{new Date(time).toLocaleTimeString()}</time>
      <TrialFoldableCode text={text} initiallyOpen />
    </div>
  );
}
