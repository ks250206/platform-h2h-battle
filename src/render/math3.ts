/** Minimal vector/quaternion helpers for the procedural rig. Pure: no Pixi, safe in node tests. */
export interface V3 {
  x: number;
  y: number;
  z: number;
}
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const mul = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
export function norm(a: V3, fallback: V3 = { x: 0, y: 1, z: 0 }): V3 {
  const d = len(a);
  return d > 1e-6 ? { x: a.x / d, y: a.y / d, z: a.z / d } : { ...fallback };
}
export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerpV = (a: V3, b: V3, t: number): V3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});
/** Shortest signed difference between two angles. */
export const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Remove from `v` its component along the unit vector `n`, then normalize. */
export function reject(v: V3, n: V3, fallback: V3): V3 {
  const r = sub(v, mul(n, dot(v, n)));
  if (len(r) > 1e-4) return norm(r);
  const f = sub(fallback, mul(n, dot(fallback, n)));
  if (len(f) > 1e-4) return norm(f);
  // `fallback` was parallel to `n` too: any perpendicular will do.
  return norm(cross(n, Math.abs(n.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 }));
}

/** Great-circle interpolation of unit directions; near-opposite inputs pivot around `up`. */
export function slerpDir(a: V3, b: V3, t: number, up: V3 = { x: 0, y: 1, z: 0 }): V3 {
  const d = clamp(dot(a, b), -1, 1);
  if (d > 0.9995) return norm(lerpV(a, b, t), a);
  let axis: V3;
  if (d < -0.995) axis = reject(up, a, { x: 1, y: 0, z: 0 });
  else axis = norm(cross(a, b));
  return qRotate(qAxis(axis, Math.acos(d) * t), a);
}

export const qIdentity = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });
export function qAxis(axis: V3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(angle / 2) };
}
export function qMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
export function qRotate(q: Quat, v: V3): V3 {
  // v + 2w(q × v) + 2 q × (q × v)
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}
const X_AXIS: V3 = { x: 1, y: 0, z: 0 };
const Y_AXIS: V3 = { x: 0, y: 1, z: 0 };
const Z_AXIS: V3 = { x: 0, y: 0, z: 1 };
/**
 * Yaw about +Y (turns +Z toward +X), then pitch about +X (tips +Y toward +Z, i.e. leans
 * forward), then roll about +Z (tips +X toward +Y).
 */
export function qEuler(yaw: number, pitch: number, roll: number): Quat {
  return qMul(qMul(qAxis(Y_AXIS, yaw), qAxis(X_AXIS, pitch)), qAxis(Z_AXIS, roll));
}
export function qNlerp(a: Quat, b: Quat, t: number): Quat {
  const sign = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
  const x = a.x + (b.x * sign - a.x) * t;
  const y = a.y + (b.y * sign - a.y) * t;
  const z = a.z + (b.z * sign - a.z) * t;
  const w = a.w + (b.w * sign - a.w) * t;
  const d = Math.hypot(x, y, z, w) || 1;
  return { x: x / d, y: y / d, z: z / d, w: w / d };
}
/** Rotation whose local axes are the given orthonormal, right-handed basis. */
export function qFromBasis(xAxis: V3, yAxis: V3, zAxis: V3): Quat {
  const m00 = xAxis.x,
    m01 = yAxis.x,
    m02 = zAxis.x;
  const m10 = xAxis.y,
    m11 = yAxis.y,
    m12 = zAxis.y;
  const m20 = xAxis.z,
    m21 = yAxis.z,
    m22 = zAxis.z;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = { w: s / 4, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s };
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = { w: (m21 - m12) / s, x: s / 4, y: (m01 + m10) / s, z: (m02 + m20) / s };
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = { w: (m02 - m20) / s, x: (m01 + m10) / s, y: s / 4, z: (m12 + m21) / s };
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: s / 4 };
  }
  const d = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / d, y: q.y / d, z: q.z / d, w: q.w / d };
}
/** Orientation with local +Y along `y` and local +Z as close to `zHint` as possible. */
export function qLook(y: V3, zHint: V3, fallback: V3 = Z_AXIS): Quat {
  const z = reject(zHint, y, fallback);
  return qFromBasis(cross(y, z), y, z);
}

/** Unit direction from a yaw (0 = forward +Z, positive toward +X) and an elevation. */
export function dirYE(yawDeg: number, elevDeg: number): V3 {
  const yaw = yawDeg * DEG,
    e = elevDeg * DEG;
  return { x: Math.sin(yaw) * Math.cos(e), y: Math.sin(e), z: Math.cos(yaw) * Math.cos(e) };
}

/**
 * Two-bone IK. Returns the middle joint and the (possibly clamped) end joint; the bend points
 * toward `pole`.
 */
export function twoBone(
  root: V3,
  target: V3,
  l1: number,
  l2: number,
  pole: V3,
): { mid: V3; end: V3; stretched: boolean } {
  const to = sub(target, root);
  const raw = len(to);
  const max = (l1 + l2) * 0.999;
  const min = Math.abs(l1 - l2) + 0.02;
  const dist = clamp(raw, min, max);
  const dir = norm(to, { x: 0, y: -1, z: 0 });
  const end = add(root, mul(dir, dist));
  const along = (l1 * l1 + dist * dist - l2 * l2) / (2 * dist);
  const height = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  const side = reject(pole, dir, Z_AXIS);
  return {
    mid: add(add(root, mul(dir, along)), mul(side, height)),
    end,
    stretched: raw > max,
  };
}

/** Semi-implicit damped spring; stable for the frame times this game clamps to. */
export class Spring {
  value = 0;
  velocity = 0;
  constructor(
    private readonly frequency: number,
    private readonly damping: number,
  ) {}
  step(target: number, dt: number): number {
    const steps = Math.max(1, Math.ceil(dt / 0.012));
    const h = dt / steps;
    const k = this.frequency * this.frequency;
    const c = 2 * this.damping * this.frequency;
    for (let i = 0; i < steps; i++) {
      this.velocity += (k * (target - this.value) - c * this.velocity) * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
  kick(impulse: number): void {
    this.velocity += impulse;
  }
  reset(value = 0): void {
    this.value = value;
    this.velocity = 0;
  }
}

export const easeIn = (t: number): number => t * t;
export const easeInCubic = (t: number): number => t * t * t;
export const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeInOut = (t: number): number => t * t * (3 - 2 * t);
/** Overshoots past 1 and settles back: a heavy thing arriving. */
export const easeOutBack = (t: number): number => {
  const c = 1.9;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};
