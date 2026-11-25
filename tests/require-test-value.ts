export function requireTestValue<Value>(value: Value): NonNullable<Value> {
  if (value === undefined || value === null) throw new Error("测试预期存在的值缺失");
  return value;
}
