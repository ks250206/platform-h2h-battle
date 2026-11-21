import { Container3D, CylinderGeometry, Geometry3D } from "@pixi/3d";
import type { Mesh3D } from "@pixi/3d";
import type { Fighter, Species } from "../game/types";
import type { MeshLibrary } from "./meshes";
import type { MotionFrame } from "./motion";
import { PALETTE } from "./palette";
import { BODY } from "./skeleton";
import type { Joint, Limb } from "./skeleton";

/** Geometry only the fighters use; owned by the renderer next to the shared MeshLibrary. */
export class RigAssets {
  /** A unit limb: radius 1 at the top, tapering, hanging from y = 0 down to y = -1. */
  readonly limb = new CylinderGeometry({
    radiusTop: 1,
    radiusBottom: 0.78,
    height: 1,
    radialSegments: 7,
  });
  readonly blade = makeBlade();
  /** A chevron lying on the floor, pointing along +Z. */
  readonly chevron = makeChevron();

  destroy(): void {
    this.limb.destroy(true);
    this.blade.destroy(true);
    this.chevron.destroy(true);
  }
}

/**
 * A greatsword blade from the guard (y = 0) to the point: a wide diamond section with a
 * strong central ridge, so the two bevels of each face catch the light differently.
 */
function makeBlade(): Geometry3D {
  const length = BODY.bladeTip - BODY.bladeBase;
  // [distance along the blade, half width, half thickness]
  const sections = [
    [0, 0.15, 0.05],
    [0.1, 0.2, 0.052],
    [length * 0.72, 0.18, 0.045],
    [length * 0.9, 0.13, 0.034],
  ];
  const rings = sections.map(([y, w, t]) => [
    [-w!, y!, 0],
    [0, y!, t!],
    [w!, y!, 0],
    [0, y!, -t!],
  ]);
  const tip = [0, length, 0];
  const positions: number[] = [],
    normals: number[] = [],
    indices: number[] = [];
  const triangle = (a: number[], b: number[], c: number[]) => {
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const n = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
    const d = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    const start = positions.length / 3;
    for (const p of [a, b, c]) {
      positions.push(p[0]!, p[1]!, p[2]!);
      normals.push(n[0]! / d, n[1]! / d, n[2]! / d);
    }
    indices.push(start, start + 1, start + 2);
  };
  for (let ring = 0; ring < rings.length - 1; ring++) {
    for (let side = 0; side < 4; side++) {
      const next = (side + 1) % 4;
      const lower = rings[ring]!,
        upper = rings[ring + 1]!;
      triangle(lower[side]!, lower[next]!, upper[next]!);
      triangle(lower[side]!, upper[next]!, upper[side]!);
    }
  }
  const last = rings[rings.length - 1]!;
  for (let side = 0; side < 4; side++) triangle(last[side]!, last[(side + 1) % 4]!, tip);
  const first = rings[0]!;
  triangle(first[0]!, first[3]!, first[2]!);
  triangle(first[0]!, first[2]!, first[1]!);
  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
  });
}

function makeChevron(): Geometry3D {
  const points = [
    [0, 0, 0.34],
    [0.2, 0, 0.06],
    [0.08, 0, 0.06],
    [0, 0, 0.17],
    [-0.08, 0, 0.06],
    [-0.2, 0, 0.06],
  ];
  return new Geometry3D({
    positions: new Float32Array(points.flat()),
    normals: new Float32Array(points.flatMap(() => [0, 1, 0])),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5]),
  });
}

interface LimbNodes {
  upper: Container3D;
  lower: Container3D;
  end: Container3D;
}
export interface FighterRig {
  /** World position and facing. */
  root: Container3D;
  /** Squash and stretch, anchored at the feet. */
  squash: Container3D;
  /** Whole-body tumble about the centre of mass. */
  pivot: Container3D;
  pelvis: Container3D;
  belly: Container3D;
  chest: Container3D;
  head: Container3D;
  sword: Container3D;
  arms: [LimbNodes, LimbNodes];
  legs: [LimbNodes, LimbNodes];
  tail: Container3D[];
  ears: Container3D[];
  scarf: Container3D[];
  chargeHalo: Mesh3D;
  pointer: Mesh3D;
  /** Floor markers live in the scene, not under the fighter, so jumps leave them behind. */
  shadow: Mesh3D;
  footRing: Mesh3D;
  heading: Mesh3D;
}

const { cream: CREAM, dark: DARK, leather: LEATHER, gold: GOLD, steel: STEEL } = PALETTE.fighter;
const { fuller: FULLER, iron: IRON } = PALETTE.fighter;

const TRAITS: Record<Species, { fur: number | null; bulk: number; head: number }> = {
  // The fox's coat is its team colour, a shade deeper so the scarf still reads.
  fox: { fur: null, bulk: 1, head: 1 },
  rabbit: { fur: PALETTE.fighter.fur.rabbit, bulk: 0.93, head: 0.97 },
  bear: { fur: PALETTE.fighter.fur.bear, bulk: 1.16, head: 1.05 },
  raccoon: { fur: PALETTE.fighter.fur.raccoon, bulk: 1.03, head: 1 },
};

function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 255) * factor));
  const g = Math.min(255, Math.round(((color >> 8) & 255) * factor));
  const b = Math.min(255, Math.round((color & 255) * factor));
  return (r << 16) | (g << 8) | b;
}

/** A jointed, low-poly animal with a two-handed greatsword. Every part is a real 3D mesh. */
export function createFighterRig(
  a: MeshLibrary,
  g: RigAssets,
  parent: Container3D,
  f: Fighter,
): FighterRig {
  const trait = TRAITS[f.species];
  const team = f.color;
  const fur = trait.fur ?? shade(team, 0.88);
  const b = trait.bulk;
  const node = (into: Container3D, x = 0, y = 0, z = 0): Container3D => {
    const child = new Container3D();
    child.position.set(x, y, z);
    into.addChild(child);
    return child;
  };
  const limb = (into: Container3D, color: number, radius: number, length: number): Mesh3D =>
    a.mesh(into, g.limb, a.material(color), 0, -length / 2, 0, radius, length, radius);

  const root = node(parent);
  const squash = node(root);
  const pivot = node(squash, 0, BODY.pivot, 0);
  const body = node(pivot, 0, -BODY.pivot, 0);

  // --- Trunk --------------------------------------------------------------------------
  const pelvis = node(body);
  a.ball(pelvis, DARK, 0, 0.01, 0, 0.255 * b, 0.19, 0.215 * b);
  a.box(pelvis, LEATHER, 0, 0.12, 0, 0.5 * b, 0.07, 0.42 * b);
  a.box(pelvis, GOLD, 0, 0.12, 0.215 * b, 0.1, 0.085, 0.03);
  // A short skirt of the tunic in the team colour, visible from every side.
  a.box(pelvis, shade(team, 0.82), 0, 0.02, -0.19 * b, 0.34 * b, 0.2, 0.05).rotation.x = -0.12;

  const belly = node(body);
  a.ball(belly, fur, 0, 0, 0, 0.25 * b, 0.21, 0.205 * b);
  a.ball(belly, CREAM, 0, -0.02, 0.105 * b, 0.17 * b, 0.16, 0.115);

  const chest = node(body);
  a.mesh(chest, a.sphere, a.material(DARK), 0, 0.05, -0.005, 0.31 * b, 0.25, 0.235 * b);
  a.ball(chest, CREAM, 0, 0.1, 0.165 * b, 0.16 * b, 0.13, 0.085);
  // Scarf: the team colour that stays visible from behind and from above.
  a.mesh(chest, a.cylinder, a.material(team), 0, 0.225, 0, 0.235 * b, 0.1, 0.215 * b);
  a.ball(chest, team, 0.11, 0.2, 0.175 * b, 0.075, 0.07, 0.06);
  a.mesh(chest, a.pebble, a.material(IRON), 0.305 * b, 0.19, 0, 0.165, 0.115, 0.175);
  a.mesh(chest, a.pebble, a.material(IRON), -0.305 * b, 0.19, 0, 0.14, 0.095, 0.15);
  const scarf: Container3D[] = [];
  {
    const first = node(chest, -0.03, 0.22, -0.2 * b);
    a.box(first, team, 0, -0.01, -0.13, 0.13, 0.035, 0.26);
    const second = node(first, 0, 0, -0.25);
    a.box(second, shade(team, 0.9), 0, -0.01, -0.12, 0.11, 0.03, 0.24);
    scarf.push(first, second);
  }

  // --- Head ---------------------------------------------------------------------------
  const head = node(body);
  const skull = node(head, 0, 0.27, 0.02);
  skull.scale.set(0.76 * trait.head);
  a.ball(skull, fur, 0, 0, 0, 0.48, 0.44, 0.42);
  const ears: Container3D[] = [];
  const ear = (side: number, x: number, y: number, tilt: number): Container3D => {
    const base = node(skull, side * x, y, -0.02);
    base.rotation.z = side * tilt;
    ears.push(base);
    return base;
  };
  if (f.species === "fox") {
    for (const side of [-1, 1]) {
      const base = ear(side, 0.3, 0.3, -0.16);
      a.mesh(base, a.cone, a.material(fur), 0, 0.2, 0, 0.2, 0.56, 0.16);
      a.mesh(base, a.cone, a.material(DARK), 0.005 * side, 0.2, 0.1, 0.11, 0.34, 0.035);
      a.ball(skull, CREAM, side * 0.22, -0.15, 0.28, 0.25, 0.2, 0.17);
    }
    a.ball(skull, CREAM, 0, -0.14, 0.4, 0.17, 0.13, 0.15);
  } else if (f.species === "rabbit") {
    for (const side of [-1, 1]) {
      const base = ear(side, 0.2, 0.32, -0.14);
      a.ball(base, fur, 0, 0.36, -0.02, 0.13, 0.46, 0.12);
      a.ball(base, PALETTE.fighter.innerEar, 0, 0.38, 0.075, 0.066, 0.32, 0.035);
    }
    a.ball(skull, CREAM, 0, -0.16, 0.35, 0.26, 0.18, 0.15);
  } else {
    for (const side of [-1, 1]) {
      const base = ear(side, 0.35, 0.3, 0);
      a.ball(base, fur, 0, 0.04, 0, 0.19, 0.2, 0.12);
      a.ball(
        base,
        f.species === "bear" ? PALETTE.fighter.bearEar : DARK,
        0,
        0.05,
        0.09,
        0.1,
        0.11,
        0.045,
      );
      if (f.species === "raccoon") a.ball(skull, DARK, side * 0.22, 0.02, 0.35, 0.18, 0.13, 0.075);
    }
    a.ball(skull, CREAM, 0, -0.13, 0.35, 0.25, 0.2, 0.15);
  }
  for (const side of [-1, 1]) {
    a.ball(skull, PALETTE.fighter.eye, side * 0.19, 0.03, 0.388, 0.066, 0.088, 0.035);
    a.ball(skull, 0xffffff, side * 0.19 - 0.013, 0.052, 0.418, 0.02, 0.023, 0.013);
    a.ball(skull, PALETTE.fighter.cheek, side * 0.32, -0.095, 0.338, 0.075, 0.04, 0.024);
    // A hard brow gives the face some resolve.
    a.box(skull, DARK, side * 0.19, 0.14, 0.4, 0.13, 0.03, 0.03).rotation.z = side * -0.32;
  }
  a.ball(skull, DARK, 0, -0.11, f.species === "fox" ? 0.545 : 0.5, 0.07, 0.048, 0.045);

  // --- Limbs --------------------------------------------------------------------------
  const arms = [0, 1].map(() => {
    const upper = node(body);
    a.ball(upper, fur, 0, 0, 0, 0.105 * b);
    limb(upper, fur, 0.088 * b, BODY.upperArm);
    const lower = node(body);
    a.ball(lower, fur, 0, 0, 0, 0.082 * b);
    limb(lower, fur, 0.078 * b, BODY.foreArm);
    a.mesh(lower, a.cylinder, a.material(LEATHER), 0, -0.2, 0, 0.09 * b, 0.17, 0.09 * b);
    const end = node(body);
    a.ball(end, CREAM, 0, 0, 0, 0.105, 0.095, 0.115);
    return { upper, lower, end };
  }) as [LimbNodes, LimbNodes];
  const legs = [0, 1].map(() => {
    const upper = node(body);
    a.ball(upper, DARK, 0, 0, 0, 0.125 * b);
    limb(upper, DARK, 0.118 * b, BODY.thigh);
    const lower = node(body);
    a.ball(lower, DARK, 0, 0, 0, 0.098 * b);
    limb(lower, fur, 0.088 * b, BODY.shin);
    a.mesh(lower, a.cylinder, a.material(LEATHER), 0, -0.25, 0, 0.092 * b, 0.14, 0.092 * b);
    const end = node(body);
    a.ball(end, CREAM, 0, 0.005, 0.075, 0.118, 0.075, 0.2);
    a.ball(end, fur, 0, 0.03, -0.02, 0.09, 0.075, 0.1);
    return { upper, lower, end };
  }) as [LimbNodes, LimbNodes];

  // --- Tail ---------------------------------------------------------------------------
  const tail: Container3D[] = [];
  if (f.species === "fox" || f.species === "raccoon") {
    const tip = f.species === "fox" ? CREAM : DARK;
    const first = node(pelvis, 0, 0.05, -0.19 * b);
    a.ball(first, fur, 0, 0, -0.15, 0.13, 0.13, 0.21);
    const second = node(first, 0, 0, -0.27);
    a.ball(second, fur, 0, 0, -0.15, 0.18, 0.18, 0.24);
    if (f.species === "raccoon") a.ball(second, DARK, 0, 0, -0.13, 0.186, 0.186, 0.07);
    const third = node(second, 0, 0, -0.29);
    a.ball(third, tip, 0, 0, -0.11, 0.145, 0.145, 0.2);
    if (f.species === "raccoon") a.ball(third, fur, 0, 0, -0.02, 0.165, 0.165, 0.07);
    tail.push(first, second, third);
  } else {
    const puff = node(pelvis, 0, 0.06, -0.21 * b);
    a.ball(puff, CREAM, 0, 0, -0.04, f.species === "bear" ? 0.13 : 0.17);
    tail.push(puff);
  }

  // --- Greatsword ---------------------------------------------------------------------
  const sword = node(body);
  a.mesh(sword, a.cylinder, a.material(PALETTE.fighter.grip), 0, 0, 0, 0.04, 0.5, 0.04);
  a.mesh(sword, a.pebble, a.material(GOLD), 0, -0.28, 0, 0.07, 0.075, 0.07);
  a.box(sword, GOLD, 0, 0.29, 0, 0.6, 0.075, 0.12);
  for (const side of [-1, 1])
    a.box(sword, GOLD, side * 0.3, 0.265, 0, 0.07, 0.13, 0.13).rotation.z = side * 0.3;
  a.ball(sword, team, 0, 0.29, 0, 0.075, 0.075, 0.085);
  a.mesh(sword, g.blade, a.material(STEEL), 0, BODY.bladeBase, 0);
  a.box(sword, FULLER, 0, BODY.bladeBase + 0.56, 0, 0.07, 1.02, 0.098);
  a.box(sword, team, 0, BODY.bladeBase + 0.045, 0, 0.36, 0.07, 0.115);

  // --- Markers ------------------------------------------------------------------------
  const chargeHalo = a.mesh(
    root,
    a.ring,
    a.material(PALETTE.fighter.chargeHalo, 0.9, 0.4),
    0,
    0.07,
    0,
    0.85,
  );
  chargeHalo.visible = false;
  const pointer = a.mesh(
    root,
    a.cone,
    a.material(PALETTE.fighter.pointer, 1, 0.35),
    0,
    2.6,
    0,
    0.15,
    0.24,
    0.15,
  );
  pointer.rotation.z = Math.PI;
  pointer.visible = f.human;
  const shadow = a.mesh(
    parent,
    a.disc,
    a.material(PALETTE.fighter.shadow, 0.22),
    0,
    0.025,
    0,
    0.65,
    1,
    0.45,
  );
  // Pale rings vanish on the pale floor, so every ring is its fighter's own saturated colour.
  const ringColor = team;
  const footRing = a.mesh(parent, a.ring, a.material(ringColor, 0.9, 0.25), 0, 0.035, 0, 0.69);
  const heading = a.mesh(parent, g.chevron, a.material(ringColor, 0.95, 0.3), 0, 0.04, 0);

  return {
    root,
    squash,
    pivot,
    pelvis,
    belly,
    chest,
    head,
    sword,
    arms,
    legs,
    tail,
    ears,
    scarf,
    chargeHalo,
    pointer,
    shadow,
    footRing,
    heading,
  };
}

function place(node: Container3D, joint: Joint): void {
  node.position.set(joint.p.x, joint.p.y, joint.p.z);
  node.quaternion.set(joint.q.x, joint.q.y, joint.q.z, joint.q.w);
}
function placeLimb(nodes: LimbNodes, limb: Limb): void {
  place(nodes.upper, limb.upper);
  place(nodes.lower, limb.lower);
  place(nodes.end, limb.end);
}

/** Writes one solved animation frame onto the scene nodes. */
export function applyFrame(rig: FighterRig, frame: MotionFrame, f: Fighter, time: number): void {
  const { skeleton } = frame;
  rig.root.visible = f.mode !== "dead";
  rig.root.position.set(frame.origin.x, frame.origin.y, frame.origin.z);
  rig.root.rotation.y = frame.facing;
  const s = skeleton.squash;
  rig.squash.scale.set(1 + s * 0.5, 1 - s, 1 + s * 0.5);
  const angle = Math.hypot(skeleton.tumble.x, skeleton.tumble.y, skeleton.tumble.z);
  if (angle > 1e-4) {
    const k = Math.sin(angle / 2) / angle;
    rig.pivot.quaternion.set(
      skeleton.tumble.x * k,
      skeleton.tumble.y * k,
      skeleton.tumble.z * k,
      Math.cos(angle / 2),
    );
  } else rig.pivot.quaternion.set(0, 0, 0, 1);
  place(rig.pelvis, skeleton.pelvis);
  place(rig.belly, skeleton.belly);
  place(rig.chest, skeleton.chest);
  place(rig.head, skeleton.head);
  place(rig.sword, skeleton.sword);
  placeLimb(rig.arms[0], skeleton.arms[0]);
  placeLimb(rig.arms[1], skeleton.arms[1]);
  placeLimb(rig.legs[0], skeleton.legs[0]);
  placeLimb(rig.legs[1], skeleton.legs[1]);
  rig.tail.forEach((segment, i) => {
    const motion = frame.tail[Math.min(i, frame.tail.length - 1)]!;
    segment.rotation.set((i === 0 ? 0.42 : 0.16) + motion.pitch, motion.yaw, 0);
  });
  for (const ear of rig.ears) ear.rotation.x = -frame.ears * 0.6;
  rig.scarf[0]!.rotation.set(-frame.scarf.pitch, frame.scarf.yaw, 0);
  rig.scarf[1]!.rotation.set(-frame.scarf.pitch * 0.6 - 0.15, frame.scarf.yaw * 0.8, 0);

  rig.chargeHalo.visible = f.mode === "charge";
  rig.chargeHalo.scale.set(0.75 + Math.min(1, f.charge) * 0.22 + Math.sin(time * 11) * 0.03);
  rig.pointer.position.y = 2.6 + Math.sin(time * 3) * 0.06;
  const shrinking = 1 / (1 + Math.max(0, f.y) * 0.1);
  const marked = f.mode !== "dead" && f.y >= -0.2;
  rig.shadow.visible = marked;
  rig.footRing.visible = marked;
  rig.heading.visible = marked;
  rig.shadow.position.set(f.x, 0.026, f.z);
  rig.shadow.scale.set(0.65 * shrinking, 1, 0.47 * shrinking);
  rig.footRing.position.set(f.x, 0.04, f.z);
  // The chevron sits just outside the ring and shows where the next swing will go.
  rig.heading.position.set(f.x + Math.sin(f.facing) * 0.66, 0.045, f.z + Math.cos(f.facing) * 0.66);
  rig.heading.rotation.y = f.facing;
}

export function destroyFighterRig(rig: FighterRig): void {
  rig.root.destroy({ children: true });
  rig.shadow.destroy();
  rig.footRing.destroy();
  rig.heading.destroy();
}
