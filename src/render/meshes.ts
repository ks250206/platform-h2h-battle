import {
  Container3D,
  CubeGeometry,
  CylinderGeometry,
  Geometry3D,
  Material3D,
  Mesh3D,
  SphereGeometry,
  TorusGeometry,
} from "@pixi/3d";
import type { Fighter } from "../game/types";

const TAU = Math.PI * 2;

/** All characters are actual low-poly 3D meshes; shared resources are owned here. */
export class MeshLibrary {
  readonly cube = new CubeGeometry();
  readonly sphere = new SphereGeometry({ radius: 1, widthSegments: 10, heightSegments: 7 });
  readonly pebble = new SphereGeometry({ radius: 1, widthSegments: 6, heightSegments: 4 });
  readonly cylinder = new CylinderGeometry({
    radiusTop: 1,
    radiusBottom: 1,
    height: 1,
    radialSegments: 12,
  });
  readonly cone = new CylinderGeometry({
    radiusTop: 0,
    radiusBottom: 1,
    height: 1,
    radialSegments: 4,
  });
  readonly ring = new TorusGeometry({
    radius: 1,
    tube: 0.025,
    radialSegments: 4,
    tubularSegments: 64,
  });
  readonly disc = makeDisc();
  readonly arc = makeArc();
  readonly blade = makeBlade();
  private readonly materials = new Map<string, Material3D>();

  material(color: number, alpha = 1, glow = 0): Material3D {
    const key = `${color}/${alpha}/${glow}`;
    let result = this.materials.get(key);
    if (!result) {
      result = new Material3D({
        baseColor: color,
        roughness: 0.78,
        metallic: 0,
        flatShading: true,
        ...(alpha < 1 ? { alpha, alphaMode: "blend" as const } : {}),
        doubleSided: true,
        ...(glow > 0 ? { emissive: { color, strength: glow } } : {}),
      });
      this.materials.set(key, result);
    }
    return result;
  }

  mesh(
    parent: Container3D,
    geometry: Geometry3D,
    material: Material3D,
    x = 0,
    y = 0,
    z = 0,
    sx = 1,
    sy = sx,
    sz = sx,
  ): Mesh3D {
    const mesh = new Mesh3D({ geometry, material, castShadow: false, receiveShadow: false });
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    parent.addChild(mesh);
    return mesh;
  }

  box(
    parent: Container3D,
    color: number,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
  ): Mesh3D {
    return this.mesh(parent, this.cube, this.material(color), x, y, z, sx, sy, sz);
  }

  ball(
    parent: Container3D,
    color: number,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy = sx,
    sz = sx,
  ): Mesh3D {
    return this.mesh(parent, this.sphere, this.material(color), x, y, z, sx, sy, sz);
  }

  destroy(): void {
    for (const material of this.materials.values()) material.destroy();
    for (const geometry of [
      this.cube,
      this.sphere,
      this.pebble,
      this.cylinder,
      this.cone,
      this.ring,
      this.disc,
      this.arc,
      this.blade,
    ])
      geometry.destroy(true);
    this.materials.clear();
  }
}

function makeDisc(): Geometry3D {
  const positions = [0, 0, 0];
  const normals = [0, 1, 0];
  const indices: number[] = [];
  for (let i = 0; i <= 40; i++) {
    positions.push(Math.sin((i / 40) * TAU), 0, Math.cos((i / 40) * TAU));
    normals.push(0, 1, 0);
    if (i < 40) indices.push(0, i + 1, i + 2);
  }
  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
  });
}

function makeArc(): Geometry3D {
  const positions: number[] = [],
    normals: number[] = [],
    indices: number[] = [];
  for (let i = 0; i <= 28; i++) {
    const t = i / 28;
    const angle = (t - 0.5) * Math.PI * 1.25;
    for (const radius of [1 - Math.sin(t * Math.PI) * 0.22, 1]) {
      positions.push(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
      normals.push(0, 1, 0);
    }
    if (i < 28) {
      const v = i * 2;
      indices.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    }
  }
  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
  });
}

/** A broad tapered blade with a real raised ridge and a sharp diamond tip. */
function makeBlade(): Geometry3D {
  const positions: number[] = [],
    normals: number[] = [],
    indices: number[] = [];
  const vertices = [
    [-0.23, 0, 0],
    [0, 0, 0.11],
    [0.23, 0, 0],
    [0, 0, -0.11],
    [-0.2, 1.55, 0],
    [0, 1.55, 0.095],
    [0.2, 1.55, 0],
    [0, 1.55, -0.095],
    [0, 1.95, 0],
  ];
  const faces = [
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
    [4, 5, 8],
    [5, 6, 8],
    [6, 7, 8],
    [7, 4, 8],
    [0, 3, 2],
    [0, 2, 1],
  ];
  for (const face of faces) {
    const [a, b, c] = face.map((i) => vertices[i]!);
    const u = b!.map((v, i) => v - a![i]!);
    const v = c!.map((n, i) => n - a![i]!);
    const n = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
    const length = Math.hypot(...n);
    const start = positions.length / 3;
    for (const point of [a!, b!, c!]) {
      positions.push(...point);
      normals.push(...n.map((x) => x / length));
    }
    indices.push(start, start + 1, start + 2);
  }
  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
  });
}

export interface FighterMesh {
  root: Container3D;
  body: Container3D;
  head: Container3D;
  sword: Container3D;
  tail: Container3D;
  arms: [Container3D, Container3D];
  legs: [Container3D, Container3D];
  slash: Mesh3D;
  chargeHalo: Mesh3D;
  shadow: Mesh3D;
  footRing: Mesh3D;
  pointer: Mesh3D;
  clock: number;
  lastX: number;
  lastZ: number;
}

export function createFighterMesh(a: MeshLibrary, parent: Container3D, f: Fighter): FighterMesh {
  const root = new Container3D();
  const body = new Container3D();
  const head = new Container3D();
  const sword = new Container3D();
  const tail = new Container3D();
  const arms: [Container3D, Container3D] = [new Container3D(), new Container3D()];
  const legs: [Container3D, Container3D] = [new Container3D(), new Container3D()];
  const color = f.color;
  const cream = 0xffeaca;
  const dark = 0x253441;
  const fur =
    f.species === "bear"
      ? 0xc79672
      : f.species === "rabbit"
        ? 0xbadbe0
        : f.species === "raccoon"
          ? 0xa3a6b7
          : color;
  parent.addChild(root);
  root.addChild(body);
  body.addChild(head, sword, tail, ...arms, ...legs);
  a.ball(body, fur, 0, 0.77, 0, 0.33, 0.42, 0.27);
  a.ball(body, cream, 0, 0.75, 0.21, 0.23, 0.29, 0.095);
  // A small jacket and scarf make the fighter's allegiance visible from behind.
  a.box(body, dark, 0, 0.53, -0.015, 0.52, 0.2, 0.42);
  a.box(body, color, 0, 1.04, 0, 0.68, 0.15, 0.48);
  a.box(body, color, -0.25, 0.85, -0.25, 0.18, 0.42, 0.09).rotation.z = -0.18;
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    legs[i]!.position.set(side * 0.18, 0.44, 0);
    a.box(legs[i]!, dark, 0, -0.14, 0, 0.21, 0.29, 0.22);
    a.ball(legs[i]!, cream, 0, -0.28, 0.075, 0.16, 0.13, 0.22);
    arms[i]!.position.set(side * 0.3, 0.97, 0.04);
    a.ball(arms[i]!, fur, side * 0.04, -0.18, 0, 0.13, 0.25, 0.13);
    a.ball(arms[i]!, dark, side * 0.04, -0.36, 0.05, 0.14, 0.13, 0.15);
  }
  head.position.set(0, 1.36, 0.015);
  a.ball(head, fur, 0, 0, 0, 0.48, 0.44, 0.4);
  if (f.species === "fox") {
    for (const side of [-1, 1]) {
      const ear = a.mesh(head, a.cone, a.material(fur), side * 0.31, 0.46, -0.015, 0.2, 0.55, 0.16);
      ear.rotation.z = side * -0.14;
      a.mesh(head, a.cone, a.material(dark), side * 0.32, 0.47, 0.1, 0.11, 0.32, 0.035).rotation.z =
        side * -0.14;
      a.ball(head, cream, side * 0.22, -0.15, 0.27, 0.25, 0.2, 0.17);
    }
  } else if (f.species === "rabbit") {
    for (const side of [-1, 1]) {
      a.ball(head, fur, side * 0.23, 0.63, -0.04, 0.13, 0.45, 0.13).rotation.z = side * -0.15;
      a.ball(head, 0xeaaeb2, side * 0.23, 0.66, 0.065, 0.066, 0.31, 0.035).rotation.z =
        side * -0.15;
    }
    a.ball(head, cream, 0, -0.16, 0.34, 0.26, 0.18, 0.15);
  } else {
    for (const side of [-1, 1]) {
      a.ball(head, fur, side * 0.36, 0.32, -0.035, 0.19, 0.2, 0.12);
      a.ball(
        head,
        f.species === "bear" ? 0x8d6758 : dark,
        side * 0.36,
        0.33,
        0.06,
        0.1,
        0.11,
        0.045,
      );
      if (f.species === "raccoon") a.ball(head, dark, side * 0.22, 0.02, 0.34, 0.18, 0.13, 0.075);
    }
    a.ball(head, cream, 0, -0.13, 0.34, 0.25, 0.2, 0.15);
  }
  for (const side of [-1, 1]) {
    a.ball(head, 0x132431, side * 0.19, 0.025, 0.376, 0.064, 0.085, 0.035);
    a.ball(head, 0xffffff, side * 0.19 - 0.013, 0.047, 0.405, 0.019, 0.022, 0.013);
    a.ball(head, 0xe79b8b, side * 0.32, -0.095, 0.328, 0.075, 0.04, 0.024);
  }
  a.ball(head, dark, 0, -0.11, 0.492, 0.07, 0.048, 0.045);
  a.box(head, dark, 0, -0.2, 0.463, 0.09, 0.018, 0.013);
  tail.position.set(0, 0.58, -0.23);
  if (f.species === "fox" || f.species === "raccoon") {
    tail.rotation.x = -0.45;
    a.ball(tail, fur, 0, 0.05, -0.39, 0.24, 0.25, 0.52);
    a.ball(tail, f.species === "fox" ? cream : dark, 0, 0.07, -0.77, 0.19, 0.2, 0.23);
    if (f.species === "raccoon") a.ball(tail, dark, 0, 0.05, -0.36, 0.25, 0.26, 0.09);
  } else a.ball(tail, cream, 0, 0, -0.1, 0.2);
  sword.position.set(0.38, 0.9, 0.22);
  a.box(sword, dark, 0, 0.04, 0, 0.13, 0.46, 0.13);
  a.ball(sword, 0xd2b575, 0, -0.2, 0, 0.12, 0.11, 0.12);
  a.box(sword, 0xd2b575, 0, 0.29, 0, 0.66, 0.13, 0.22);
  a.mesh(sword, a.blade, a.material(0xdde5e2), 0, 0.36, 0);
  a.box(sword, 0x708a93, 0, 0.55, 0.113, 0.055, 0.28, 0.02);
  a.box(sword, color, 0, 0.34, 0.115, 0.13, 0.16, 0.03);
  const slash = a.mesh(root, a.arc, a.material(0xe9fadc, 0.6, 0.6), 0, 0.9, 0, 2.7);
  slash.visible = false;
  const chargeHalo = a.mesh(root, a.ring, a.material(0xf6cf7a, 0.8, 0.4), 0, 0.07, 0, 0.85);
  chargeHalo.rotation.x = Math.PI / 2;
  chargeHalo.visible = false;
  const shadow = a.mesh(parent, a.disc, a.material(0x152b31, 0.23), 0, 0.025, 0, 0.65, 1, 0.45);
  const footRing = a.mesh(
    parent,
    a.ring,
    a.material(f.human ? 0xffd7a2 : color, 0.75, 0.25),
    0,
    0.035,
    0,
    0.69,
  );
  footRing.rotation.x = Math.PI / 2;
  const pointer = a.mesh(root, a.cone, a.material(0xffe3b5, 1, 0.35), 0, 2.47, 0, 0.13, 0.2, 0.13);
  pointer.rotation.z = Math.PI;
  pointer.visible = f.human;
  return {
    root,
    body,
    head,
    sword,
    tail,
    arms,
    legs,
    slash,
    chargeHalo,
    shadow,
    footRing,
    pointer,
    clock: 0,
    lastX: f.x,
    lastZ: f.z,
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.max(0, Math.min(1, t));
const ease = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);

export function poseFighter(view: FighterMesh, f: Fighter, dt: number): void {
  if (f.hitstop <= 0) view.clock += dt;
  const t = view.clock;
  // Walking is positional in the simulation; vx/vz only store knockback impulses.
  const travelled = Math.hypot(f.x - view.lastX, f.z - view.lastZ);
  const speed = dt > 0 && f.hitstop <= 0 ? Math.min(1, travelled / dt / 4.6) : 0;
  view.lastX = f.x;
  view.lastZ = f.z;
  const moving = f.grounded && f.mode === "idle" ? speed : 0;
  const stride = Math.sin(t * 13) * moving;
  const p = f.modeDuration > 0 ? Math.min(1, f.modeTime / f.modeDuration) : 0;
  view.root.visible = f.mode !== "dead";
  view.root.position.set(f.x, f.y, f.z);
  view.root.rotation.y = f.facing;
  view.body.position.y =
    Math.abs(stride) * 0.06 + (f.mode === "idle" ? Math.sin(t * 2.5) * 0.018 : 0);
  view.body.rotation.set(0, 0, 0);
  view.head.rotation.set(0, 0, 0);
  view.tail.rotation.y = Math.sin(t * 5) * (0.12 + moving * 0.2);
  view.legs[0].rotation.x = stride * 0.58;
  view.legs[1].rotation.x = -stride * 0.58;
  view.arms[0].rotation.set(-stride * 0.2, 0, -0.1);
  view.arms[1].rotation.set(0.16, 0, 0.12);
  view.sword.position.set(0.4, 0.93, 0.2);
  view.sword.rotation.set(-0.5, 0, -0.34);
  view.slash.visible = f.mode === "active";
  view.slash.position.set(0, 0.82, 0);
  view.slash.rotation.set(0, 0, 0);
  view.slash.scale.set(2.45);
  view.chargeHalo.visible = f.mode === "charge";
  view.chargeHalo.scale.set(0.75 + Math.min(1, f.charge) * 0.22 + Math.sin(t * 11) * 0.03);
  view.pointer.position.y = 2.48 + Math.sin(t * 3) * 0.06;
  const shrinking = 1 / (1 + Math.max(0, f.y) * 0.1);
  view.shadow.position.set(f.x, 0.026, f.z);
  view.shadow.scale.set(0.65 * shrinking, 1, 0.47 * shrinking);
  view.footRing.position.set(f.x, 0.04, f.z);
  view.shadow.visible = f.mode !== "dead" && f.y >= -0.2;
  view.footRing.visible = view.shadow.visible;
  if (!f.grounded) {
    view.legs[0].rotation.x = -0.35;
    view.legs[1].rotation.x = 0.32;
  }
  if (f.mode === "step") {
    view.body.position.y = -0.14;
    view.body.rotation.x = 0.2;
    view.legs[0].rotation.x = 0.7;
    view.legs[1].rotation.x = -0.65;
  }
  if (f.mode === "hitstun" || f.mode === "clash") {
    view.body.rotation.x = -0.32;
    view.head.rotation.x = -0.14;
    view.sword.rotation.x = -0.9;
    view.arms[0].rotation.z = -0.65;
  }
  if (f.mode === "grab" || f.mode === "grabbed" || f.mode === "throw") {
    view.arms[0].rotation.x = -1.35;
    view.arms[1].rotation.x = -1.35;
    view.body.rotation.x = 0.16;
    view.sword.rotation.set(-0.9, 0, -0.65);
  }
  if (f.attack && ["charge", "windup", "active", "recovery"].includes(f.mode)) {
    const preparing = f.mode === "charge" || f.mode === "windup";
    const active = f.mode === "active";
    const swing = preparing ? 0 : active ? ease(p) : 1;
    const recovery = f.mode === "recovery" ? ease(p) : 0;
    view.arms[0].rotation.set(-0.75, 0.35, -0.1);
    view.arms[1].rotation.set(-0.9, -0.3, 0.15);
    switch (f.attack) {
      case "overhead":
        view.sword.position.set(lerp(0.08, 0.4, recovery), 1.16, 0.22);
        view.sword.rotation.set(
          lerp(lerp(-0.9, 2.05, swing), -0.5, recovery),
          0,
          lerp(0, -0.34, recovery),
        );
        view.body.rotation.x = lerp(lerp(-0.12, 0.24, swing), 0, recovery);
        view.slash.rotation.z = Math.PI / 2;
        view.slash.scale.set(2.55, 2.55, 2.55);
        break;
      case "rising":
        view.sword.position.set(0.15, lerp(0.6, 1.15, swing), 0.25);
        view.sword.rotation.set(lerp(lerp(2.2, -0.55, swing), -0.5, recovery), 0, -0.1);
        view.body.rotation.x = lerp(0.2, -0.12, swing) * (1 - recovery);
        view.slash.rotation.z = Math.PI / 2;
        view.slash.position.y = 1.15;
        break;
      case "sweep":
        view.sword.rotation.set(
          lerp(Math.PI / 2, -0.5, recovery),
          lerp(lerp(-1.4, 1.4, swing), 0, recovery),
          lerp(0, -0.34, recovery),
        );
        view.sword.position.set(0.08, 0.93, 0.13);
        view.body.rotation.y = lerp(lerp(-0.35, 0.35, swing), 0, recovery);
        view.slash.rotation.y = lerp(-0.6, 0.6, swing);
        view.slash.scale.set(2.25);
        break;
      case "thrust":
        view.sword.position.set(0.11, 0.94, lerp(lerp(-0.45, 0.75, swing), 0.2, recovery));
        view.sword.rotation.set(lerp(Math.PI / 2, -0.5, recovery), 0, lerp(0, -0.34, recovery));
        view.body.rotation.x = 0.14 * (1 - recovery);
        view.slash.scale.set(0.22, 0.22, 3.1);
        view.slash.position.z = 0.4;
        break;
    }
  }
}
