const MAX_PITCH = 85;
const wrapYaw = (yaw: number) => ((((yaw + 180) % 360) + 360) % 360) - 180;

export const MIN_FOV = 10;
export const MAX_FOV = 120;

const TILT_PER_PIXEL = 0.02;
const ZOOM_PER_PIXEL = 0.001;
const MIN_GRAB_DEPTH = 0.5;
const MAX_GRAB_DEPTH = 60;
const DEFAULT_GRAB_DEPTH = 8;

const DEG = Math.PI / 180;

type Vec = [number, number, number];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const dot = (a: Readonly<Vec>, b: Readonly<Vec>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function pixelRay(ndcX: number, ndcY: number, vfov: number, aspect: number): Vec {
  const tan = Math.tan((vfov / 2) * DEG);
  const x = ndcX * tan * aspect;
  const y = ndcY * tan;
  const length = Math.hypot(x, y, 1);
  return [x / length, y / length, -1 / length];
}

export function rotateByLook(yaw: number, pitch: number, v: Readonly<Vec>): Vec {
  const cp = Math.cos(pitch * DEG);
  const sp = Math.sin(pitch * DEG);
  const x1 = v[0];
  const y1 = v[1] * cp - v[2] * sp;
  const z1 = v[1] * sp + v[2] * cp;
  const theta = -yaw * DEG;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [x1 * c + z1 * s, y1, -x1 * s + z1 * c];
}

const wrapRad = (angle: number) => {
  const wrapped = ((((angle + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return wrapped === -Math.PI ? Math.PI : wrapped;
};

function solveLook(v: Readonly<Vec>, d: Readonly<Vec>, currentPitch: number) {
  const a = Math.hypot(v[1], v[2]);
  const phi = Math.atan2(v[2], v[1]);
  const base = Math.acos(clamp(d[1] / a, -1, 1));
  const limit = MAX_PITCH * DEG;
  const current = currentPitch * DEG;
  const candidates = [wrapRad(-phi + base), wrapRad(-phi - base)];
  const inRange = candidates.filter((p) => Math.abs(p) <= limit);
  const pool = inRange.length > 0 ? inRange : candidates;
  const best = pool.reduce((nearest, p) =>
    Math.abs(p - current) < Math.abs(nearest - current) ? p : nearest,
  );
  const pitch = clamp(best, -limit, limit);

  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const wx = v[0];
  const wz = v[1] * sp + v[2] * cp;

  if (Math.hypot(d[0], d[2]) < 1e-9 || Math.hypot(wx, wz) < 1e-9) {
    return { yaw: null, pitch: pitch / DEG };
  }
  const theta = Math.atan2(d[0], d[2]) - Math.atan2(wx, wz);
  return { yaw: wrapYaw(-theta / DEG), pitch: pitch / DEG };
}

export function grabLook(
  start: { yaw: number; pitch: number },
  from: { x: number; y: number },
  to: { x: number; y: number },
  vfov: number,
  aspect: number,
): { yaw: number; pitch: number } {
  const grabbed = rotateByLook(start.yaw, start.pitch, pixelRay(from.x, from.y, vfov, aspect));
  const solved = solveLook(pixelRay(to.x, to.y, vfov, aspect), grabbed, start.pitch);
  return { yaw: solved.yaw ?? start.yaw, pitch: solved.pitch };
}

export function normalizeWheel(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * 400;
  return delta;
}

export function tiltByWheel(pitch: number, deltaY: number): number {
  return clamp(pitch - deltaY * TILT_PER_PIXEL, -MAX_PITCH, MAX_PITCH);
}

export function zoomByWheel(fov: number, deltaY: number): number {
  return clamp(fov * Math.exp(deltaY * ZOOM_PER_PIXEL), MIN_FOV, MAX_FOV);
}

export function moveInput(keys: ReadonlySet<string>): { forward: number; right: number } {
  const has = (...names: string[]) => names.some((name) => keys.has(name));
  return {
    forward: (has("w", "arrowup") ? 1 : 0) - (has("s", "arrowdown") ? 1 : 0),
    right: (has("d", "arrowright") ? 1 : 0) - (has("a", "arrowleft") ? 1 : 0),
  };
}

export function walk(
  position: { x: number; y: number; z: number },
  yaw: number,
  input: { forward: number; right: number },
  distance: number,
): { x: number; y: number; z: number } {
  const length = Math.hypot(input.forward, input.right);
  if (length === 0) return { ...position };
  const f = input.forward / length;
  const r = input.right / length;
  const sin = Math.sin(yaw * DEG);
  const cos = Math.cos(yaw * DEG);
  return {
    x: position.x + (sin * f + cos * r) * distance,
    y: position.y,
    z: position.z + (-cos * f + sin * r) * distance,
  };
}

export function grabDepth(
  position: { x: number; y: number; z: number },
  direction: Readonly<Vec>,
): number {
  if (direction[1] < -1e-3) {
    const t = -position.y / direction[1];
    if (t > 0) return clamp(t, MIN_GRAB_DEPTH, MAX_GRAB_DEPTH);
  }
  return DEFAULT_GRAB_DEPTH;
}

export function panPosition(
  pose: { x: number; y: number; z: number; yaw: number; pitch: number },
  pinned: Readonly<Vec>,
  to: { x: number; y: number },
  vfov: number,
  aspect: number,
): { x: number; y: number; z: number } {
  const forward = rotateByLook(pose.yaw, pose.pitch, [0, 0, -1]);
  const depth = dot([pinned[0] - pose.x, pinned[1] - pose.y, pinned[2] - pose.z], forward);
  const ray = rotateByLook(pose.yaw, pose.pitch, pixelRay(to.x, to.y, vfov, aspect));
  const along = dot(ray, forward);
  if (!(along > 1e-6)) return { x: pose.x, y: pose.y, z: pose.z };
  const s = depth / along;
  return { x: pinned[0] - ray[0] * s, y: pinned[1] - ray[1] * s, z: pinned[2] - ray[2] * s };
}
