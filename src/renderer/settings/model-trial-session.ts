import type { SettingsAPI } from "@link-studio/core";

type Outcome = Awaited<ReturnType<SettingsAPI["modelTrial"]>>;
type Session = { id: string; outcome?: Outcome; expiry?: number };
const sessions = new Map<string, Session>();
const listeners = new Set<() => void>();

export function subscribeTrialSessions(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const trialSession = (key: string) => sessions.get(key);

export function restoreTrialSession(
  key: string,
  id: string,
  outcome?: Outcome,
  expiresAt = Date.now() + 15 * 60_000,
) {
  forget(key);
  if (outcome) {
    const expiry = window.setTimeout(
      () => {
        forget(key);
        notify();
      },
      Math.max(0, expiresAt - Date.now()),
    );
    sessions.set(key, { id, outcome, expiry });
    const finished = [...sessions].filter(([, session]) => session.outcome);
    for (const [oldest] of finished.slice(0, -32)) forget(oldest);
  } else sessions.set(key, { id });
  notify();
}

function notify() {
  for (const listener of listeners) listener();
}

function forget(key: string) {
  window.clearTimeout(sessions.get(key)?.expiry);
  sessions.delete(key);
}

export async function startTrialSession(key: string, id: string, submit: () => Promise<Outcome>) {
  if (sessions.has(key) && !sessions.get(key)?.outcome) return;
  forget(key);
  sessions.set(key, { id });
  notify();
  let outcome: Outcome;
  try {
    outcome = await submit();
  } catch {
    outcome = { ok: false, code: "PROVIDER_TEST_FAILED" };
  }
  restoreTrialSession(key, id, outcome);
}
