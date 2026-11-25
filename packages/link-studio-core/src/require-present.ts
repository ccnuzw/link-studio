export function requirePresent<Value>(value: Value, context: string): NonNullable<Value> {
  if (value === null || value === undefined) throw new Error(`缺少必要数据：${context}`);
  return value;
}
