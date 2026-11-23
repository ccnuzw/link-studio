import { useCallback, useEffect, useRef, useState } from "react";

import { canGreet, IDLE_SLEEP_MS, type PetMode } from "./mood";

const GREET_CLEAR_MS = 1200;

export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

export function useReducedMotionPref(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function usePetSleep(mode: PetMode, onWake: () => void) {
  const [asleep, setAsleep] = useState(false);
  const last = useRef(0);
  const asleepRef = useRef(false);
  const wakeRef = useRef(onWake);
  useEffect(() => {
    wakeRef.current = onWake;
  });

  useEffect(() => {
    last.current = Date.now();
  }, []);

  const touch = useCallback(() => {
    last.current = Date.now();
    if (asleepRef.current) {
      asleepRef.current = false;
      setAsleep(false);
      wakeRef.current();
    }
  }, []);

  useEffect(() => {
    const events = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    for (const name of events) window.addEventListener(name, touch, { passive: true });
    return () => {
      for (const name of events) window.removeEventListener(name, touch);
    };
  }, [touch]);

  useEffect(() => {
    if (mode !== "lively" || asleep) return;
    let timer = 0;
    const tick = () => {
      const rest = IDLE_SLEEP_MS - (Date.now() - last.current);
      if (rest <= 0) {
        asleepRef.current = true;
        setAsleep(true);
      } else {
        timer = window.setTimeout(tick, rest);
      }
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [mode, asleep]);

  return { asleep: asleep && mode === "lively", touch };
}

export function usePetGreeting(mode: PetMode) {
  const [greet, setGreet] = useState(false);
  const lastGreetAt = useRef<number | null>(null);

  useEffect(() => {
    if (!greet) return;
    const timer = window.setTimeout(() => setGreet(false), GREET_CLEAR_MS);
    return () => window.clearTimeout(timer);
  }, [greet]);

  const onHover = useCallback(() => {
    const now = Date.now();
    if (mode !== "lively" || !canGreet(lastGreetAt.current, now)) return;
    lastGreetAt.current = now;
    setGreet(true);
  }, [mode]);

  const wave = useCallback(() => setGreet(true), []);
  const clear = useCallback(() => setGreet(false), []);
  return { greet, onHover, wave, clear };
}
