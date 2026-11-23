import { type Static, Type } from "@sinclair/typebox";

export const feedbackReasons = {
  misread: "没理解我的需求",
  wrong_edit: "画布改错了",
  slow: "步骤太多或太慢",
  bad_output: "生成结果不好",
  other: "其他",
} as const;
export const RunFeedback = Type.Object(
  {
    rating: Type.Union([Type.Literal(1), Type.Literal(-1)]),
    reasons: Type.Array(
      Type.Union(
        (Object.keys(feedbackReasons) as (keyof typeof feedbackReasons)[]).map((key) =>
          Type.Literal(key),
        ),
      ),
      { uniqueItems: true, maxItems: 5 },
    ),
    comment: Type.String({ maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type RunRating = Static<typeof RunFeedback>;
export const feedbackValue = Type.Union([RunFeedback, Type.Null()]);
export const feedbackStatuses = new Set([
  "succeeded",
  "failed",
  "canceled",
  "interrupted",
  "timeout",
  "step_limit",
  "expired",
  "budget_exhausted",
]);
