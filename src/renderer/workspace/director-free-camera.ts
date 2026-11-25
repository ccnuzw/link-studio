import {
  grabDepth,
  grabLook,
  moveInput,
  normalizeWheel,
  panPosition,
  pixelRay,
  rotateByLook,
  tiltByWheel,
  walk,
  zoomByWheel,
} from "./director-free-look";
import type { CameraPose as LookPose } from "./director-sample";

export type CameraDriver = {
  read: () => LookPose | undefined;
  write: (patch: Partial<LookPose>) => void;
  begin: () => void;
  end: () => void;
};

const WALK_SPEED = 3;
const MAX_STEP_SECONDS = 0.1;
const WHEEL_IDLE_MS = 400;

const MOVE_KEYS: Record<string, string> = {
  KeyW: "w",
  KeyA: "a",
  KeyS: "s",
  KeyD: "d",
  ArrowUp: "arrowup",
  ArrowDown: "arrowdown",
  ArrowLeft: "arrowleft",
  ArrowRight: "arrowright",
};

const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest(
    "input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=true], [role=separator], .director-divider, [data-director-menu]",
  );

type Drag =
  | { kind: "look"; start: LookPose; from: Ndc; started: boolean }
  | { kind: "pan"; start: LookPose; pinned: [number, number, number]; from: Ndc; started: boolean };
type Ndc = { x: number; y: number };

export function attachFreeCamera(options: {
  element: HTMLElement;
  camera: { fov: number; aspect: number };
  driver: CameraDriver;
  allowPan: boolean;
  gizmoBusy?: { current: boolean };
}): { tick: (seconds: number) => void; dispose: () => void } {
  const { element, camera, driver, allowPan, gizmoBusy } = options;

  const holders = new Set<string>();
  const hold = (reason: string) => {
    if (holders.has(reason)) return;
    if (holders.size === 0) driver.begin();
    holders.add(reason);
  };
  const release = (reason: string) => {
    if (!holders.delete(reason)) return;
    if (holders.size === 0) driver.end();
  };

  const ndcOf = (event: { clientX: number; clientY: number }): Ndc => {
    const rect = element.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: 1 - ((event.clientY - rect.top) / rect.height) * 2,
    };
  };

  let drag: Drag | null = null;
  const endDrag = (pointerId?: number) => {
    if (!drag) return;
    release("drag");
    drag = null;
    element.style.cursor = "grab";
    if (pointerId !== undefined && element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    const pan = event.button === 1 || event.button === 2;
    if (event.button !== 0 && !(pan && allowPan)) return;
    const start = driver.read();
    if (!start) return;
    element.setPointerCapture(event.pointerId);
    const from = ndcOf(event);
    if (pan) {
      const direction = rotateByLook(
        start.yaw,
        start.pitch,
        pixelRay(from.x, from.y, camera.fov, camera.aspect),
      );
      const depth = grabDepth(start, direction);
      const pinned: [number, number, number] = [
        start.x + direction[0] * depth,
        start.y + direction[1] * depth,
        start.z + direction[2] * depth,
      ];
      drag = { kind: "pan", start, pinned, from, started: false };
    } else {
      drag = { kind: "look", start, from, started: false };
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!drag) return;

    if (gizmoBusy?.current) {
      endDrag();
      return;
    }
    if (!drag.started) {
      drag.started = true;
      hold("drag");
      element.style.cursor = "grabbing";
    }
    const now = ndcOf(event);
    if (drag.kind === "look") {
      driver.write(grabLook(drag.start, drag.from, now, camera.fov, camera.aspect));
    } else {
      driver.write(panPosition(drag.start, drag.pinned, now, camera.fov, camera.aspect));
    }
  };

  const onPointerUp = (event: PointerEvent) => endDrag(event.pointerId);

  let wheelTimer: ReturnType<typeof setTimeout> | undefined;
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const pose = driver.read();
    const delta = normalizeWheel(event.deltaY, event.deltaMode);
    if (!pose || delta === 0) return;
    hold("wheel");
    if (event.ctrlKey || event.altKey) driver.write({ fov: zoomByWheel(pose.fov, delta) });
    else driver.write({ pitch: tiltByWheel(pose.pitch, delta) });
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => release("wheel"), WHEEL_IDLE_MS);
  };

  const held = new Set<string>();
  const onKeyDown = (event: KeyboardEvent) => {
    const name = MOVE_KEYS[event.code];
    if (!name || event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) {
      return;
    }

    if (!driver.read()) return;

    event.preventDefault();
    held.add(name);
    hold("keys");
  };
  const onKeyUp = (event: KeyboardEvent) => {
    const name = MOVE_KEYS[event.code];
    if (!name) return;
    held.delete(name);
    if (held.size === 0) release("keys");
  };
  const onBlur = () => {
    held.clear();
    release("keys");
  };

  const onContextMenu = (event: Event) => {
    if (allowPan) event.preventDefault();
  };

  element.style.cursor = "grab";
  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointercancel", onPointerUp);
  element.addEventListener("wheel", onWheel, { passive: false });
  element.addEventListener("contextmenu", onContextMenu);

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);

  return {
    tick: (seconds) => {
      if (held.size === 0) return;
      const input = moveInput(held);
      const pose = driver.read();
      if (!pose || (input.forward === 0 && input.right === 0)) return;
      const next = walk(pose, pose.yaw, input, WALK_SPEED * Math.min(seconds, MAX_STEP_SECONDS));
      driver.write({ x: next.x, z: next.z });
    },
    dispose: () => {
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerUp);
      element.removeEventListener("pointercancel", onPointerUp);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      clearTimeout(wheelTimer);
      element.style.cursor = "";

      held.clear();
      drag = null;
      for (const reason of [...holders]) release(reason);
    },
  };
}
