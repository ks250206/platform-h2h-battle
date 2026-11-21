// The 3D floor of a stage. Every slab drawn here comes from the stage's tile list in
// game/stages.ts, the same list collision reads, and a slab is shown exactly while
// `isTileSupported` says it is there: no floor without a slab, no slab that will not hold a fighter.
// Everything else in this file (pillars, arches, rails, the pit's shaft) is decoration: it never
// stands where a fighter can, and never between the camera and the floor.

import { Container3D, Geometry3D } from "@pixi/3d";
import type { Mesh3D } from "@pixi/3d";
import { isTileSupported, STAGES } from "../game/stages";
import type { StageDefinition, StageId, StageTile } from "../game/stages";
import type { GameState } from "../game/types";
import type { MeshLibrary } from "./meshes";
import { PALETTE } from "./palette";

const TAU = Math.PI * 2;

/** A box of a merged mesh: its length runs along local Z, tilted by `pitch`, then turned by `yaw`. */
interface BoxPart {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  yaw?: number;
  pitch?: number;
}

/** Normal and the two edge directions of each face of a unit cube (u × v = normal). */
const BOX_FACES: readonly (readonly [number[], number[], number[]])[] = [
  [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  [
    [-1, 0, 0],
    [0, 0, 1],
    [0, 1, 0],
  ],
  [
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 0],
  ],
  [
    [0, -1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ],
  [
    [0, 0, 1],
    [1, 0, 0],
    [0, 1, 0],
  ],
  [
    [0, 0, -1],
    [0, 1, 0],
    [1, 0, 0],
  ],
];

/** Several boxes as one lit mesh: a whole arch or a pair of rails costs one draw. */
function mergeBoxes(parts: readonly BoxPart[]): Geometry3D {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const part of parts) {
    const cp = Math.cos(part.pitch ?? 0);
    const sp = Math.sin(part.pitch ?? 0);
    const cy = Math.cos(part.yaw ?? 0);
    const sy = Math.sin(part.yaw ?? 0);
    const turn = (x: number, y: number, z: number): [number, number, number] => {
      const py = y * cp - z * sp;
      const pz = y * sp + z * cp;
      return [x * cy + pz * sy, py, -x * sy + pz * cy];
    };
    for (const [n, u, v] of BOX_FACES) {
      const first = positions.length / 3;
      const normal = turn(n[0]!, n[1]!, n[2]!);
      for (const [a, b] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const corner = [0, 1, 2].map(
          (axis) => (n[axis]! + a! * u[axis]! + b! * v[axis]!) * 0.5,
        ) as [number, number, number];
        const p = turn(corner[0] * part.sx, corner[1] * part.sy, corner[2] * part.sz);
        positions.push(p[0] + part.x, p[1] + part.y, p[2] + part.z);
        normals.push(...normal);
      }
      indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
    }
  }
  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
  });
}

/** A flat arrowhead on the floor pointing along +Z: two thick strokes meeting at the tip. */
function makeChevron(): Geometry3D {
  const half = 0.56;
  const tip = 0.3;
  const back = -0.2;
  const stroke = 0.27;
  const positions = [
    0,
    0,
    tip,
    -half,
    0,
    back,
    -half,
    0,
    back - stroke,
    0,
    0,
    tip - stroke,
    0,
    0,
    tip,
    0,
    0,
    tip - stroke,
    half,
    0,
    back - stroke,
    half,
    0,
    back,
  ];
  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(Array.from({ length: 8 }, () => [0, 1, 0]).flat()),
    // Wound to face up.
    indices: new Uint16Array([0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6]),
  });
}

/**
 * The rock under an island: a block that tapers downward. Its top is the square ±1 at y = 0 and
 * its foot the square ±0.3 at y = -1; scaled to the island it hangs under.
 */
function makeUnderside(): Geometry3D {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const foot = 0.3;
  const ring = (r: number, y: number) => [
    [-r, y, -r],
    [-r, y, r],
    [r, y, r],
    [r, y, -r],
  ];
  const top = ring(1, 0);
  const bottom = ring(foot, -1);
  const quad = (points: number[][], normal: number[]) => {
    const first = positions.length / 3;
    for (const p of points) {
      positions.push(...p);
      normals.push(...normal);
    }
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  };
  const slope = 1 - foot;
  const outward = [
    [-1, -slope, 0],
    [0, -slope, 1],
    [1, -slope, 0],
    [0, -slope, -1],
  ];
  for (let side = 0; side < 4; side++) {
    const next = (side + 1) % 4;
    const n = outward[side]!;
    const size = Math.hypot(n[0]!, n[1]!, n[2]!);
    quad(
      [top[side]!, bottom[side]!, bottom[next]!, top[next]!],
      n.map((value) => value / size),
    );
  }
  quad([...bottom].reverse(), [0, -1, 0]);
  // Capped, so the seams between the tiles above never show through it.
  quad(top, [0, 1, 0]);
  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
  });
}

/** The arch under a bridge 3 long (along Z): six stone blocks on a curve, highest at mid-span. */
function makeArch(): Geometry3D {
  const parts: BoxPart[] = [];
  const span = 1.5;
  const sag = (s: number) => -0.5 - 1.05 * (s / span) * (s / span);
  const count = 6;
  for (let i = 0; i < count; i++) {
    const from = -span + (i * 2 * span) / count;
    const to = -span + ((i + 1) * 2 * span) / count;
    const rise = sag(to) - sag(from);
    parts.push({
      x: 0,
      y: (sag(from) + sag(to)) / 2,
      z: (from + to) / 2,
      sx: 0.95,
      sy: 0.2,
      sz: Math.hypot(to - from, rise) + 0.04,
      pitch: -Math.atan2(rise, to - from),
    });
  }
  // Keystone and the two feet it springs from.
  parts.push({ x: 0, y: -0.36, z: 0, sx: 1.1, sy: 0.16, sz: 0.5 });
  for (const end of [-1, 1])
    parts.push({ x: 0, y: -1.45, z: end * (span + 0.12), sx: 1.25, sy: 0.5, sz: 0.36 });
  return mergeBoxes(parts);
}

/**
 * The rope rails of a bridge 3 long (along Z): a low post at each corner and a slack rope down
 * each side. They mark the edge and stop nobody: a fighter pushed sideways still goes over.
 */
function makeRopes(across: number): Geometry3D {
  const parts: BoxPart[] = [];
  const span = 1.44;
  for (const side of [-1, 1]) {
    for (const end of [-1, 1])
      parts.push({ x: side * across, y: 0.24, z: end * span, sx: 0.1, sy: 0.5, sz: 0.1 });
    for (const end of [-1, 1]) {
      // From the post's head (0.46) down to the rope's lowest point (0.26) at mid-span.
      parts.push({
        x: side * across,
        y: 0.36,
        z: (end * span) / 2,
        sx: 0.045,
        sy: 0.045,
        sz: Math.hypot(span, 0.2),
        pitch: end * -Math.atan2(0.2, span),
      });
    }
  }
  return mergeBoxes(parts);
}

/** The two brass rails of a belt tile whose belt runs along +Z. */
function makeRails(): Geometry3D {
  return mergeBoxes(
    [-1, 1].map((side) => ({ x: side * 0.86, y: 0.035, z: 0, sx: 0.1, sy: 0.07, sz: 2 })),
  );
}

/** The eight teeth of a cog lying flat (its axle is Y); the wheel itself is a cylinder. */
function makeCogTeeth(): Geometry3D {
  return mergeBoxes(
    Array.from({ length: 8 }, (_, i) => {
      const angle = (i / 8) * TAU;
      return {
        x: Math.sin(angle) * 0.95,
        y: 0,
        z: Math.cos(angle) * 0.95,
        sx: 0.3,
        sy: 0.2,
        sz: 0.36,
        yaw: angle,
      };
    }),
  );
}

/** Geometry every stage view shares; owned by the renderer and destroyed with it. */
export class StageShapes {
  readonly chevron = makeChevron();
  readonly underside = makeUnderside();
  readonly arch = makeArch();
  readonly ropes = makeRopes(0.71);
  readonly rails = makeRails();
  readonly cogTeeth = makeCogTeeth();

  destroy(): void {
    for (const geometry of [
      this.chevron,
      this.underside,
      this.arch,
      this.ropes,
      this.rails,
      this.cogTeeth,
    ])
      geometry.destroy(true);
  }
}

interface TileView {
  tile: StageTile;
  root: Container3D;
  top: Mesh3D;
  /** The pulsing ring of a collapse warning; only tiles that can fall have one. */
  outline: Mesh3D | null;
  tint: number;
  unsafeTint: number;
  fallenAt: number | null;
}

interface BeltView {
  chevrons: Mesh3D[];
  /** Unit direction of the belt and its speed in world units per second. */
  dirX: number;
  dirZ: number;
  speed: number;
  /** The belt goes on, the same way, into / out of the next tile: arrows cross the seam whole. */
  joinsBefore: boolean;
  joinsAfter: boolean;
}

/** Arrows are this far apart along a belt, so each 2-long tile carries two. */
const CHEVRON_GAP = 1;
/** An arrow grows over this distance where a belt starts, and shrinks where it ends. */
const CHEVRON_FADE = 0.4;

const checker = (tile: StageTile): boolean =>
  ((Math.floor(tile.x / tile.width) + Math.floor(tile.z / tile.depth)) & 1) === 1;

/** One stage's floor and scenery. Built from `STAGES[stageId]`; swap it to change stage. */
export class StageView {
  readonly root = new Container3D();
  readonly stageId: StageId;
  private readonly a: MeshLibrary;
  private readonly shapes: StageShapes;
  private readonly stage: StageDefinition;
  private readonly tiles: TileView[] = [];
  private readonly byCentre = new Map<string, TileView>();
  private readonly belts: BeltView[] = [];
  private readonly spinners: { node: Container3D; speed: number }[] = [];
  private readonly flames: Mesh3D[] = [];

  constructor(assets: MeshLibrary, shapes: StageShapes, stageId: StageId) {
    this.a = assets;
    this.shapes = shapes;
    this.stageId = stageId;
    this.stage = STAGES[stageId];
    for (const tile of this.stage.tiles) this.addTile(tile);
    if (stageId === "garden") this.decorateGarden();
    else if (stageId === "ruins") this.decorateRuins();
    else if (stageId === "bridges") this.decorateBridges();
    else this.decorateFactory();
  }

  /** The tile centred on (x, z): scenery that stands on a tile falls with it. */
  private tileAt(x: number, z: number): TileView {
    const view = this.byCentre.get(`${x},${z}`);
    if (!view) throw new Error(`No tile at ${x}, ${z} on ${this.stageId}`);
    return view;
  }

  private addTile(tile: StageTile): void {
    const a = this.a;
    const root = new Container3D();
    root.position.set(tile.x, 0, tile.z);
    this.root.addChild(root);
    const [tint, unsafeTint] = this.tints(tile);
    const top = a.mesh(root, a.tile, a.flatMaterial(tint));
    // Planks are a thin deck; everything else is the garden's deep slab, sized to the tile.
    top.scale.set(tile.width / 2, tile.kind === "bridge" ? 0.42 : 1, tile.depth / 2);
    // Only takes effect while the shadow-receiving tile material is in use.
    top.receiveShadow = true;
    let outline: Mesh3D | null = null;
    if (!isTileSupported(tile, this.stage.minHalfSize)) {
      outline = a.mesh(
        root,
        a.ring,
        a.material(PALETTE.floor.warnRing, 0.9, 0.2),
        0,
        0.025,
        0,
        0.75,
      );
      outline.visible = false;
    }
    const view: TileView = { tile, root, top, outline, tint, unsafeTint, fallenAt: null };
    this.tiles.push(view);
    this.byCentre.set(`${tile.x},${tile.z}`, view);
    if (tile.kind === "conveyor" && tile.flow) this.addBelt(view, tile);
  }

  /** A tile's colour, and the washed-out one it takes outside the safe zone. */
  private tints(tile: StageTile): [number, number] {
    const odd = checker(tile);
    if (this.stageId === "ruins") {
      const c = PALETTE.ruins;
      const tint =
        tile.part === "rim"
          ? odd
            ? c.rimDark
            : c.rimLight
          : tile.part === "outer"
            ? odd
              ? c.outerDark
              : c.outerLight
            : odd
              ? c.dark
              : c.light;
      return [tint, c.unsafe];
    }
    if (this.stageId === "bridges") {
      const c = PALETTE.bridges;
      const tint =
        tile.kind === "bridge"
          ? odd
            ? c.plankDark
            : c.plankLight
          : tile.part === "plaza"
            ? odd
              ? c.plazaDark
              : c.plazaLight
            : odd
              ? c.islandDark
              : c.islandLight;
      return [tint, c.unsafe];
    }
    if (this.stageId === "factory") {
      const c = PALETTE.factory;
      if (tile.kind === "conveyor") return [odd ? c.beltDark : c.belt, c.beltUnsafe];
      const border = Math.max(Math.abs(tile.x), Math.abs(tile.z)) >= 8;
      const tint = border
        ? odd
          ? c.edgeDark
          : c.edgeLight
        : tile.part === "core"
          ? odd
            ? c.coreDark
            : c.coreLight
          : odd
            ? c.dark
            : c.light;
      return [tint, c.unsafe];
    }
    const c = PALETTE.floor;
    const border = Math.max(Math.abs(tile.x), Math.abs(tile.z)) >= 8;
    const tint = border ? (odd ? c.edgeDark : c.edgeLight) : odd ? c.dark : c.light;
    return [tint, c.unsafe];
  }

  /** Rails along the belt's sides and two arrows that travel with it. */
  private addBelt(view: TileView, tile: StageTile): void {
    const a = this.a;
    const flow = tile.flow!;
    const speed = Math.hypot(flow.x, flow.z);
    const dirX = flow.x / speed;
    const dirZ = flow.z / speed;
    const yaw = Math.atan2(dirX, dirZ);
    const rails = a.mesh(view.root, this.shapes.rails, a.material(PALETTE.factory.rail));
    rails.rotation.y = yaw;
    const arrow = a.material(PALETTE.factory.chevron, 1, 0.6);
    const chevrons = [0, 1].map(() => {
      const chevron = a.mesh(view.root, this.shapes.chevron, arrow, 0, 0.014, 0);
      chevron.rotation.y = yaw;
      return chevron;
    });
    const sameWay = (x: number, z: number): boolean =>
      this.stage.tiles.some(
        (other) =>
          other.x === x &&
          other.z === z &&
          other.flow !== null &&
          Math.abs(other.flow.x - flow.x) + Math.abs(other.flow.z - flow.z) < 1e-6,
      );
    this.belts.push({
      chevrons,
      dirX,
      dirZ,
      speed,
      joinsBefore: sameWay(tile.x - dirX * tile.width, tile.z - dirZ * tile.depth),
      joinsAfter: sameWay(tile.x + dirX * tile.width, tile.z + dirZ * tile.depth),
    });
  }

  /** The garden as it has always looked: shards under the rim, a few inlays, the compass. */
  private decorateGarden(): void {
    const a = this.a;
    for (const view of this.tiles) {
      const col = view.tile.x / 2;
      const row = view.tile.z / 2;
      const border = Math.abs(row) === 4 || Math.abs(col) === 4;
      if (border && (col + row) % 3 === 0) {
        const shard = a.mesh(
          view.root,
          a.cone,
          a.material(PALETTE.floor.shard),
          0,
          -1.09,
          0,
          1.03,
          1.1 + ((col * row + 17) % 3) * 0.4,
          0.94,
        );
        shard.rotation.z = Math.PI;
        shard.rotation.y = 0.4;
      }
      // Quiet decorative inlay: it never denotes a collider or hazard.
      if (!border && (row + col + 12) % 5 === 0) {
        a.box(view.root, PALETTE.floor.inlay, -0.57, 0.006, -0.5, 0.34, 0.012, 0.045).rotation.y =
          0.5;
        a.box(view.root, PALETTE.floor.inlay, -0.45, 0.007, -0.43, 0.18, 0.012, 0.045).rotation.y =
          -0.45;
      }
    }
    // A pale compass is a useful reference for depth and directional inputs.
    a.mesh(this.root, a.ring, a.material(PALETTE.floor.compass, 0.5), 0, 0.012, 0, 2.6);
    for (let i = 0; i < 4; i++) {
      const mark = a.box(
        this.root,
        PALETTE.floor.compass,
        Math.sin((i * Math.PI) / 2) * 2.6,
        0.016,
        Math.cos((i * Math.PI) / 2) * 2.6,
        0.09,
        0.013,
        0.44,
      );
      mark.rotation.y = (i * Math.PI) / 2;
    }
  }

  /** A column standing just outside the floor, on a bracket from the tile it belongs to. */
  private column(parent: Container3D, x: number, z: number, height: number, capital: boolean) {
    const a = this.a;
    const c = PALETTE.ruins;
    a.box(parent, c.pillarShade, x * 0.86, -0.3, z * 0.86, 0.8, 0.44, 0.8);
    a.box(parent, c.pillarShade, x, 0.02, z, 0.66, 0.2, 0.66);
    a.mesh(parent, a.cylinder, a.material(c.pillar), x, 0.12 + height / 2, z, 0.23, height, 0.23);
    a.box(parent, c.inlay, x, 0.12 + height * 0.72, z, 0.5, 0.07, 0.5);
    if (capital) a.box(parent, c.pillarShade, x, 0.2 + height, z, 0.62, 0.16, 0.62);
  }

  /**
   * The sunken ruins: a jade kerb along the pit's mouth, a dark shaft below it ringed by glowing
   * runes, and columns and two gates outside the far and side edges. The corner nearest the
   * camera stays bare, so nothing ever stands in front of the floor.
   */
  private decorateRuins(): void {
    const a = this.a;
    const c = PALETTE.ruins;
    // The kerb sits on the visible lip of the tiles round the pit (collision ends at 3).
    for (const side of [-1, 1]) {
      a.box(this.root, c.curb, side * 3.1, 0.05, 0, 0.18, 0.1, 6.02);
      a.box(this.root, c.curb, 0, 0.05, side * 3.1, 6.02, 0.1, 0.18);
      for (const other of [-1, 1])
        a.box(this.root, c.curb, side * 3.1, 0.07, other * 3.1, 0.3, 0.14, 0.3);
    }
    // The shaft: four walls under the kerb, far below the floor, never above it.
    for (const side of [-1, 1]) {
      a.box(this.root, c.wall, side * 3.34, -3.9, 0, 0.44, 6.8, 7.1);
      a.box(this.root, c.wall, 0, -3.9, side * 3.34, 7.1, 6.8, 0.44);
    }
    a.mesh(this.root, a.cube, a.material(c.abyss, 1, 0.2), 0, -7.2, 0, 6.3, 0.2, 6.3);
    // Two glowing bands of runes round the shaft: they give the fall its depth.
    const glow = a.material(c.glow, 1, 0.9);
    for (const [depth, height] of [
      [-1.7, 0.14],
      [-3.5, 0.09],
    ]) {
      for (const side of [-1, 1]) {
        a.mesh(this.root, a.cube, glow, side * 3.1, depth!, 0, 0.05, height!, 6.2);
        a.mesh(this.root, a.cube, glow, 0, depth!, side * 3.1, 6.2, height!, 0.05);
      }
    }
    // Rock under the outer ring, as under the garden's rim; it falls with its tile.
    for (const view of this.tiles) {
      const col = view.tile.x / 2;
      const row = view.tile.z / 2;
      if (view.tile.part === "outer" && (col + row) % 3 === 0) {
        const shard = a.mesh(
          view.root,
          a.cone,
          a.material(c.shard),
          0,
          -1.09,
          0,
          1.03,
          1.1 + ((col * row + 17) % 3) * 0.4,
          0.94,
        );
        shard.rotation.z = Math.PI;
        shard.rotation.y = 0.4;
      }
      // Worn glyphs on some of the sandstone.
      if (view.tile.part === "ring" && (row + col + 12) % 4 === 0) {
        a.box(view.root, c.inlay, -0.5, 0.006, -0.45, 0.4, 0.012, 0.05).rotation.y = 0.5;
        a.box(view.root, c.inlay, -0.36, 0.007, -0.36, 0.2, 0.012, 0.05).rotation.y = -0.5;
      }
    }
    // Columns off the far corner and the two side corners; each belongs to its corner tile.
    this.column(this.tileAt(-8, -8).root, -1.5, -1.5, 2.3, true);
    this.column(this.tileAt(-8, 8).root, -1.5, 1.5, 1.5, false);
    this.column(this.tileAt(8, -8).root, 1.5, -1.5, 1.5, false);
    // A gate in the middle of each far edge: two columns and a lintel.
    const west = this.tileAt(-8, 0).root;
    this.column(west, -1.5, -0.78, 1.9, false);
    this.column(west, -1.5, 0.78, 1.9, false);
    a.box(west, c.pillar, -1.5, 2.16, 0, 0.6, 0.28, 2.4);
    const north = this.tileAt(0, -8).root;
    this.column(north, -0.78, -1.5, 1.9, false);
    this.column(north, 0.78, -1.5, 1.9, false);
    a.box(north, c.pillar, 0, 2.16, -1.5, 2.4, 0.28, 0.6);
  }

  /**
   * The sky bridges: rock under each island and the plaza, an arch under every bridge, rope
   * rails with a lamp on each post, and a pennant beyond the two far islands.
   */
  private decorateBridges(): void {
    const a = this.a;
    const c = PALETTE.bridges;
    const rock = a.material(c.rock);
    const under = (x: number, z: number, halfX: number, halfZ: number, depth: number) => {
      a.mesh(this.root, this.shapes.underside, rock, x, -0.6, z, halfX, depth, halfZ);
    };
    under(0, 0, 1.86, 1.86, 3.4);
    for (const arm of [
      { x: -1, z: 0 },
      { x: 1, z: 0 },
      { x: 0, z: -1 },
      { x: 0, z: 1 },
    ]) {
      const alongX = arm.x !== 0;
      under(arm.x * 7, arm.z * 7, alongX ? 1.86 : 2.86, alongX ? 2.86 : 1.86, 2.9);
      const bridge = new Container3D();
      bridge.position.set(arm.x * 3.5, 0, arm.z * 3.5);
      bridge.rotation.y = alongX ? Math.PI / 2 : 0;
      this.root.addChild(bridge);
      a.mesh(bridge, this.shapes.arch, a.material(c.arch));
      a.mesh(bridge, this.shapes.ropes, a.material(c.rope));
      const lamp = a.material(c.lamp, 1, 0.8);
      for (const side of [-1, 1]) {
        for (const end of [-1, 1])
          a.mesh(bridge, a.cube, lamp, side * 0.71, 0.55, end * 1.44, 0.15, 0.15, 0.15);
      }
    }
    // Pennants beyond the outer ends of the two far islands, where nothing is behind them.
    for (const [x, z] of [
      [-9.5, 0],
      [0, -9.5],
    ]) {
      a.box(this.root, c.rock, x! * 0.97, -0.35, z! * 0.97, 0.5, 0.5, 0.5);
      a.box(this.root, c.pole, x!, 1.15, z!, 0.09, 2.5, 0.09);
      const flag = a.box(this.root, c.banner, x!, 2.05, z!, 0.05, 0.56, 0.9);
      // Flying along the island's outer edge.
      flag.position.set(x! + (z === 0 ? 0 : 0.48), 2.05, z! + (z === 0 ? 0.48 : 0));
      flag.rotation.y = z === 0 ? 0 : Math.PI / 2;
    }
  }

  /**
   * The conveyor works: a brass ring on the calm middle, thrusters under the rim, and two
   * smokestacks and a turning cog beyond the far edges. The belts themselves (navy slabs, brass
   * rails, travelling arrows) are built with their tiles in `addBelt`.
   */
  private decorateFactory(): void {
    const a = this.a;
    const c = PALETTE.factory;
    a.mesh(this.root, a.ring, a.material(c.brass, 0.85), 0, 0.012, 0, 2.3);
    for (let i = 0; i < 4; i++) {
      const angle = (i * Math.PI) / 2 + Math.PI / 4;
      a.mesh(
        this.root,
        a.cylinder,
        a.material(c.brass),
        Math.sin(angle) * 2.3,
        0.01,
        Math.cos(angle) * 2.3,
        0.16,
        0.04,
        0.16,
      );
    }
    for (const view of this.tiles) {
      const col = view.tile.x / 2;
      const row = view.tile.z / 2;
      const border = Math.abs(row) === 4 || Math.abs(col) === 4;
      if (!border || (col + row) % 3 !== 0) continue;
      // A thruster where the garden has a shard of rock; it falls with its tile.
      a.mesh(view.root, a.cylinder, a.material(c.ironDark), 0, -1.2, 0, 0.42, 0.9, 0.42);
      a.mesh(view.root, a.cylinder, a.material(c.brass), 0, -1.68, 0, 0.5, 0.12, 0.5);
      const flame = a.mesh(
        view.root,
        a.cone,
        a.material(c.flame, 0.85, 1),
        0,
        -2.25,
        0,
        0.3,
        1,
        0.3,
      );
      flame.rotation.z = Math.PI;
      this.flames.push(flame);
    }
    // Smokestacks beyond the far edges, each on a bracket from an outer tile.
    for (const [tx, tz, ox, oz] of [
      [-8, -4, -1.5, 0],
      [-4, -8, 0, -1.5],
    ]) {
      const parent = this.tileAt(tx!, tz!).root;
      a.box(parent, c.ironDark, ox! * 0.86, -0.3, oz! * 0.86, 0.9, 0.44, 0.9);
      a.mesh(parent, a.cylinder, a.material(c.iron), ox!, 1.05, oz!, 0.36, 2.5, 0.36);
      a.mesh(parent, a.cylinder, a.material(c.brass), ox!, 2.2, oz!, 0.43, 0.2, 0.43);
      a.mesh(parent, a.cylinder, a.material(c.ironDark), ox!, 2.36, oz!, 0.3, 0.12, 0.3);
    }
    // The big cog off the far corner, facing the camera and turning with the belts.
    const corner = this.tileAt(-8, -8).root;
    a.box(corner, c.ironDark, -1.3, -0.3, -1.3, 0.9, 0.44, 0.9);
    a.box(corner, c.ironDark, -1.55, 0.7, -1.55, 0.22, 1.6, 0.22);
    const mount = new Container3D();
    mount.position.set(-1.4, 1.55, -1.4);
    mount.rotation.y = Math.PI / 4;
    corner.addChild(mount);
    const upright = new Container3D();
    upright.rotation.x = Math.PI / 2;
    mount.addChild(upright);
    const cog = new Container3D();
    upright.addChild(cog);
    a.mesh(cog, a.cylinder, a.material(c.brass), 0, 0, 0, 0.86, 0.16, 0.86);
    a.mesh(cog, this.shapes.cogTeeth, a.material(c.brass));
    a.mesh(cog, a.cylinder, a.material(c.ironDark), 0, 0, 0, 0.3, 0.24, 0.3);
    this.spinners.push({ node: cog, speed: 0.9 });
  }

  /**
   * Shows the stage as it is in `state`. `time` is the renderer's visual clock (frozen while
   * paused); `beltTime` only runs while belts do (while playing, and as a preview on the title),
   * so their arrows wait out the countdown and stop with the match.
   */
  update(state: GameState, time: number, beltTime: number, shadows: boolean, reset: boolean): void {
    const a = this.a;
    const { halfSize, safeZone: safe, warningRing } = state.arena;
    for (const view of this.tiles) {
      const { tile } = view;
      const supported = isTileSupported(tile, halfSize);
      if (reset || supported) view.fallenAt = null;
      if (!supported && view.fallenAt === null) view.fallenAt = time;
      const falling = view.fallenAt === null ? 0 : time - view.fallenAt;
      view.root.visible = supported || falling < 1.1;
      view.root.position.y = supported ? 0 : -falling * falling * 16;
      view.root.rotation.set(
        supported ? 0 : falling * 0.35,
        0,
        supported ? 0 : falling * 0.2 * Math.sign(tile.x || 1),
      );
      const warning =
        supported && warningRing && Math.max(Math.abs(tile.x), Math.abs(tile.z)) >= halfSize - 2;
      const unsafe = safe.active && Math.hypot(tile.x - safe.x, tile.z - safe.z) > safe.radius;
      view.top.material = a.tileMaterial(
        warning
          ? Math.sin(time * 7) > 0
            ? PALETTE.floor.warnA
            : PALETTE.floor.warnB
          : unsafe
            ? view.unsafeTint
            : view.tint,
        shadows,
      );
      if (view.outline) {
        view.outline.visible = warning;
        if (warning) view.outline.scale.set(0.5 + (Math.sin(time * 5) + 1) * 0.12);
      }
    }
    for (const belt of this.belts) {
      const travelled = beltTime * belt.speed;
      for (const [k, chevron] of belt.chevrons.entries()) {
        // Along the tile from -1 (where the belt enters it) to 1 (where it leaves).
        const along = ((((k * CHEVRON_GAP + travelled) % 2) + 2) % 2) - 1;
        const grow = belt.joinsBefore ? 1 : (along + 1) / CHEVRON_FADE;
        const shrink = belt.joinsAfter ? 1 : (1 - along) / CHEVRON_FADE;
        chevron.position.set(belt.dirX * along, 0.014, belt.dirZ * along);
        chevron.scale.set(Math.max(0.001, Math.min(1, grow, shrink)));
      }
    }
    for (const spinner of this.spinners) spinner.node.rotation.y = beltTime * spinner.speed;
    for (const [i, flame] of this.flames.entries()) {
      const flicker = 0.85 + Math.sin(beltTime * 17 + i * 1.7) * 0.15;
      flame.scale.set(0.3, flicker, 0.3);
    }
  }

  /** Removes the stage's meshes. Shared geometry and materials stay with their owners. */
  destroy(): void {
    this.root.destroy({ children: true });
  }
}
