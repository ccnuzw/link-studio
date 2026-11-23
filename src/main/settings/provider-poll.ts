export function providerPollDelay(poll: unknown, submitting: boolean, attempts: number) {
  const settings = (poll ?? {}) as Partial<
    Record<"firstDelay" | "interval" | "maxInterval" | "jitter", number>
  >;
  if (submitting) return (settings.firstDelay || 10) * 1000;
  const interval = settings.interval || 5;
  const maximum = Math.max(interval, settings.maxInterval || 15);
  const wait = Math.min(maximum, interval * 2 ** Math.min(52, Math.max(0, attempts - 1)));
  return wait * (1 + (settings.jitter || 0.2) * (2 * Math.random() - 1)) * 1000;
}
