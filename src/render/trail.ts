import { FlatMaterial, Geometry3D, Mesh3D } from "@pixi/3d";
import type { Container3D } from "@pixi/3d";
import { lerpV, norm, slerpDir, sub } from "./math3";
import type { V3 } from "./math3";

const SEGMENTS = 30;
const LIFE = 0.17;
/**
 * Once the cut is over the ribbon is not left to fade on its own: it ages this many times faster
 * and at half strength, so it is gone within about two frames of the recovery starting and never
 * lingers looking like a live blade (`spentLife`).
 */
export const SPENT_DRAIN = 5;
/** Seconds a ribbon outlives its cut: everything is gone this long after the strength drops. */
export const spentLife = (): number => LIFE / SPENT_DRAIN;

interface Sample {
  base: V3;
  tip: V3;
  age: number;
}

/**
 * The air the blade has just cut: a ribbon rebuilt every frame from where the edge actually was,
 * so it always matches the swing instead of being a canned arc.
 */
export class SwordTrail {
  readonly mesh: Mesh3D;
  private readonly geometry: Geometry3D;
  private readonly material: FlatMaterial;
  private readonly positions = new Float32Array((SEGMENTS + 1) * 6);
  private readonly colors = new Float32Array((SEGMENTS + 1) * 8);
  private readonly samples: Sample[] = [];
  private lastBase: V3 | null = null;
  private lastTip: V3 | null = null;
  /** The cut has ended: what is left of the ribbon drains fast and dim. */
  private spent = false;

  constructor(parent: Container3D, color: number) {
    const normals = new Float32Array(this.positions.length);
    const indices: number[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      normals[i * 6 + 1] = normals[i * 6 + 4] = 1;
      if (i < SEGMENTS) {
        const v = i * 2;
        indices.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      }
    }
    this.geometry = new Geometry3D({
      positions: this.positions,
      normals,
      colors: this.colors,
      indices: new Uint16Array(indices),
      dynamic: true,
    });
    this.material = new FlatMaterial({
      baseColor: color,
      vertexColors: true,
      doubleSided: true,
      alphaMode: "blend",
    });
    this.mesh = new Mesh3D({
      geometry: this.geometry,
      material: this.material,
      castShadow: false,
      receiveShadow: false,
    });
    this.mesh.visible = false;
    parent.addChild(this.mesh);
  }

  /**
   * `base` and `tip` are world positions of the cutting edge. `strength` is 1 while the swing is
   * live; at 0 no new ribbon is laid and what is left drains away within `spentLife()`.
   */
  update(base: V3, tip: V3, strength: number, dt: number): void {
    const cutting = strength > 0.02;
    if (cutting) this.spent = false;
    else if (this.samples.length) this.spent = true;
    const aging = this.spent ? dt * SPENT_DRAIN : dt;
    for (const sample of this.samples) sample.age += aging;
    while (this.samples.length && this.samples[this.samples.length - 1]!.age > LIFE)
      this.samples.pop();
    if (cutting && dt > 0) {
      if (this.lastBase && this.lastTip && this.samples.length) {
        // Slow frames would leave a faceted fan: fill the gap along the arc the blade swung.
        const from = norm(sub(this.lastTip, this.lastBase));
        const to = norm(sub(tip, base));
        const length = Math.hypot(tip.x - base.x, tip.y - base.y, tip.z - base.z);
        const moved = Math.hypot(
          tip.x - this.lastTip.x,
          tip.y - this.lastTip.y,
          tip.z - this.lastTip.z,
        );
        const extra = Math.min(6, Math.floor(moved / 0.35));
        for (let i = 1; i <= extra; i++) {
          const t = i / (extra + 1);
          const origin = lerpV(this.lastBase, base, t);
          const direction = slerpDir(from, to, t);
          this.samples.unshift({
            base: origin,
            tip: {
              x: origin.x + direction.x * length,
              y: origin.y + direction.y * length,
              z: origin.z + direction.z * length,
            },
            age: dt * (1 - t),
          });
        }
      }
      this.samples.unshift({ base: { ...base }, tip: { ...tip }, age: 0 });
      if (this.samples.length > SEGMENTS + 1) this.samples.length = SEGMENTS + 1;
      this.lastBase = { ...base };
      this.lastTip = { ...tip };
    } else {
      this.lastBase = this.lastTip = null;
    }
    const count = this.samples.length;
    this.mesh.visible = count >= 2;
    if (count < 2) return;
    const dim = this.spent ? 0.5 : 1;
    for (let i = 0; i <= SEGMENTS; i++) {
      const sample = this.samples[Math.min(i, count - 1)]!;
      const life = Math.min(1, sample.age / LIFE);
      // The ribbon thins toward the point as it ages, like a smear left by the outer edge.
      const inner = lerpV(sample.base, sample.tip, 0.3 + life * 0.6);
      const p = i * 6;
      this.positions[p] = inner.x;
      this.positions[p + 1] = inner.y;
      this.positions[p + 2] = inner.z;
      this.positions[p + 3] = sample.tip.x;
      this.positions[p + 4] = sample.tip.y;
      this.positions[p + 5] = sample.tip.z;
      const fade = i >= count ? 0 : (1 - life) * (1 - life) * dim;
      const c = i * 8;
      this.colors[c] = this.colors[c + 1] = this.colors[c + 2] = 1;
      this.colors[c + 3] = fade * 0.12;
      this.colors[c + 4] = this.colors[c + 5] = this.colors[c + 6] = 1;
      this.colors[c + 7] = fade * 0.85;
    }
    this.geometry.attributes.aPosition!.buffer.update();
    this.geometry.attributes.aColor!.buffer.update();
  }

  /** Whether any of the ribbon is still on screen. */
  get visible(): boolean {
    return this.mesh.visible;
  }

  clear(): void {
    this.samples.length = 0;
    this.lastBase = this.lastTip = null;
    this.spent = false;
    this.mesh.visible = false;
  }

  destroy(): void {
    this.mesh.destroy();
    this.geometry.destroy(true);
    this.material.destroy();
  }
}
