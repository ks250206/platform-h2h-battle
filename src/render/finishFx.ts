// KO and finish highlights in the 3D scene: a light beam where a fighter left the arena and rings
// on the floor. Purely visual and short-lived: nothing here is read by the simulation, nothing
// freezes the fighters, and every shape stays thin or flat so fighters, tiles, bomb circles and
// the safe zone remain visible underneath.

import { Container3D } from "@pixi/3d";
import type { Mesh3D } from "@pixi/3d";
import type { Phase } from "../game/types";
import type { PresentationEvent } from "../game/presentation";
import type { MeshLibrary } from "./meshes";
import { fxSpot, fxStyle, type FxStyle } from "./finishFxLogic";

export { fxSpot, fxStyle, type FxKind, type FxStyle } from "./finishFxLogic";

interface Burst {
  root: Container3D;
  beam: Mesh3D | null;
  core: Mesh3D | null;
  rings: Mesh3D[];
  style: FxStyle;
  age: number;
}

const ease = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
const BURST_LIMIT = 8;

export class FinishFx {
  private readonly bursts: Burst[] = [];

  constructor(
    private readonly parent: Container3D,
    private readonly assets: MeshLibrary,
  ) {}

  /** Starts the highlight for one event; returns the shake to add (0 for none). */
  trigger(event: PresentationEvent, halfSize: number, reducedFlash: boolean): number {
    if (
      event.kind !== "stockKo" &&
      event.kind !== "elimination" &&
      event.kind !== "trainingKo" &&
      event.kind !== "finish"
    )
      return 0;
    while (this.bursts.length >= BURST_LIMIT) this.dispose(this.bursts.shift()!);
    const style = fxStyle(event.kind, reducedFlash);
    const a = this.assets;
    const root = new Container3D();
    const spot = fxSpot(event.x, event.y, event.z, halfSize);
    root.position.set(spot.x, 0.06, spot.z);
    this.parent.addChild(root);
    const beam =
      style.beamHeight > 0 ? a.mesh(root, a.cylinder, a.material(event.color, 0.42, 0.6)) : null;
    const core = style.core ? a.mesh(root, a.cylinder, a.material(0xffffff, 0.55, 1)) : null;
    const rings = Array.from({ length: style.rings }, () =>
      a.mesh(root, a.ring, a.material(event.color, 0.7, 0.5)),
    );
    const burst: Burst = { root, beam, core, rings, style, age: 0 };
    this.bursts.push(burst);
    this.pose(burst);
    return style.shake;
  }

  /** Advances the highlights by the rendered (not simulated) time; clears them off the match. */
  update(dt: number, phase: Phase): void {
    if (phase === "menu" || phase === "countdown") {
      this.clear();
      return;
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const burst = this.bursts[i]!;
      burst.age += dt;
      if (burst.age >= burst.style.life) {
        this.dispose(burst);
        this.bursts.splice(i, 1);
      } else this.pose(burst);
    }
  }

  get active(): number {
    return this.bursts.length;
  }

  private pose(burst: Burst): void {
    const { style } = burst;
    const t = burst.age / style.life;
    // The beam shoots up fast, then narrows away: it never stands in front of anyone for long.
    const height = style.beamHeight * ease(t * 5);
    const width = style.beamRadius * Math.max(0.02, 1 - t) ** 1.5;
    if (burst.beam) {
      burst.beam.scale.set(width, Math.max(0.01, height), width);
      burst.beam.position.set(0, height / 2, 0);
    }
    if (burst.core) {
      const core = width * 0.45 * Math.max(0, 1 - t * 2.2);
      burst.core.visible = core > 0.005;
      burst.core.scale.set(Math.max(0.001, core), Math.max(0.01, height), Math.max(0.001, core));
      burst.core.position.set(0, height / 2, 0);
    }
    burst.rings.forEach((ring, i) => {
      const local = Math.max(0, Math.min(1, (t - i * 0.12) / 0.75));
      ring.visible = local > 0 && local < 1;
      ring.scale.set(Math.max(0.01, style.ringRadius * ease(local)));
    });
  }

  private dispose(burst: Burst): void {
    burst.root.destroy({ children: true });
  }

  clear(): void {
    for (const burst of this.bursts) this.dispose(burst);
    this.bursts.length = 0;
  }
}
