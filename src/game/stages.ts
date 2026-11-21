// The stages a match can be fought on. This file is the single source of truth for where there is
// floor: collision (`canStandAt`), spawns, respawns, the timed gimmicks, CPU navigation and the 3D
// floor meshes all read the same tiles from here, so what is drawn is exactly what can be stood on.
// Pure TypeScript, importable in node (tests): no DOM and no renderer.

import { GIMMICK_IDS as RULE_GIMMICK_IDS, type GimmickConstraints, type StageInfo } from "./rules";
import type { ZoneCircle } from "./safeZone";
import { RULES } from "./tuning";
import type { Vec2 } from "./types";

export type StageId = "garden" | "ruins" | "bridges" | "factory";
export const STAGE_IDS: readonly StageId[] = ["garden", "ruins", "bridges", "factory"];
export const DEFAULT_STAGE: StageId = "garden";
export const isStageId = (value: unknown): value is StageId => STAGE_IDS.includes(value as StageId);

export type TileKind = "floor" | "bridge" | "conveyor";

/** One slab of floor. Its standable area is the closed rectangle around its centre. */
export interface StageTile {
  /** Centre on the ground plane. */
  x: number;
  z: number;
  /** Full size along X and along Z. */
  width: number;
  depth: number;
  kind: TileKind;
  /** The part of the stage it belongs to (an island, a bridge, the ring round the pit …). */
  part: string;
  /** Conveyors only: where the belt carries a grounded fighter, in world units per second. */
  flow: Vec2 | null;
}

export type GimmickId = "collapse" | "safeZone" | "bombs" | "wind" | "conveyor";
export const GIMMICK_IDS: readonly GimmickId[] = [
  "collapse",
  "safeZone",
  "bombs",
  "wind",
  "conveyor",
];
export const GIMMICK_LABELS: Record<GimmickId, string> = {
  collapse: "崩落",
  safeZone: "安全地帯",
  bombs: "爆撃",
  wind: "風",
  conveyor: "コンベア",
};
/** `limited`: it happens, but held back so the stage stays playable. */
export type GimmickState = "on" | "limited" | "off";
export interface GimmickRule {
  state: GimmickState;
  /** What it does on this stage, in a few words. */
  note: string;
}

export interface StageDefinition {
  id: StageId;
  /** Japanese name, English title, and the short label on the selector button. */
  name: string;
  title: string;
  label: string;
  /** What the place is, in a few words. */
  tagline: string;
  /** What fighting here is about. */
  summary: string;
  /** Which timed gimmicks run here and how; shown on the title screen before the match. */
  gimmicks: Record<GimmickId, GimmickRule>;
  /** The same rules as one or two sentences. */
  gimmickNote: string;
  /** Half the side of the square the stage fits in, before any collapse. */
  halfSize: number;
  /** The outer collapse stops at this half size; equal to `halfSize` when nothing ever falls. */
  minHalfSize: number;
  /** Every point inside the rim is floor (no pit, no gap): the rim alone decides standing. */
  solid: boolean;
  tiles: readonly StageTile[];
  /** Fighters start this far from the centre, on the four cardinal directions. */
  spawnRadius: number;
  /**
   * Places to come back to after a fall, all on floor that never collapses and well clear of
   * every drop. Empty on a solid stage, where anywhere inside the rim will do.
   */
  respawns: readonly Vec2[];
}

const TILE = RULES.tileSize;
/** Tiles on the 9×9 grid run from column / row -4 to 4. */
const GRID = 4;
/** Speed of every conveyor belt. Walking is 4.6, so a belt can always be walked against. */
export const CONVEYOR_SPEED = 2.2;
/** Width of the plank bridges; the tiles beside them are 2 wide. */
export const BRIDGE_WIDTH = 1.6;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

const gridTile = (
  col: number,
  row: number,
  kind: TileKind,
  part: string,
  flow: Vec2 | null = null,
): StageTile => ({ x: col * TILE, z: row * TILE, width: TILE, depth: TILE, kind, part, flow });

/** Every cell of the 9×9 grid for which `pick` returns a tile, row by row. */
function gridTiles(pick: (col: number, row: number) => StageTile | null): StageTile[] {
  const tiles: StageTile[] = [];
  for (let row = -GRID; row <= GRID; row++) {
    for (let col = -GRID; col <= GRID; col++) {
      const tile = pick(col, row);
      if (tile) tiles.push(tile);
    }
  }
  return tiles;
}

const ringOf = (col: number, row: number): number => Math.max(Math.abs(col), Math.abs(row));

/** The floating garden: all 81 tiles. */
const gardenTiles = (): StageTile[] =>
  gridTiles((col, row) => gridTile(col, row, "floor", "garden"));

/** The sunken ruins: the same square with its middle 3×3 tiles missing. */
function ruinsTiles(): StageTile[] {
  return gridTiles((col, row) => {
    const ring = ringOf(col, row);
    if (ring <= 1) return null;
    return gridTile(col, row, "floor", ring === 2 ? "rim" : ring === 3 ? "ring" : "outer");
  });
}

/**
 * The sky bridges: an island at each cardinal end (4 deep, 6 wide), a 4×4 plaza in the middle,
 * and a plank bridge 3 long and 1.6 wide from the plaza to each island.
 */
function bridgesTiles(): StageTile[] {
  const tiles: StageTile[] = [];
  const arms = [
    { part: "west", x: -1, z: 0 },
    { part: "east", x: 1, z: 0 },
    { part: "north", x: 0, z: -1 },
    { part: "south", x: 0, z: 1 },
  ];
  for (const arm of arms) {
    // Along the arm the island covers 5…9; across it, -3…3.
    for (const along of [3, 4]) {
      for (const across of [-1, 0, 1]) {
        const col = arm.x !== 0 ? arm.x * along : across;
        const row = arm.z !== 0 ? arm.z * along : across;
        tiles.push(gridTile(col, row, "floor", `${arm.part}-island`));
      }
    }
  }
  for (const z of [-1, 1]) {
    for (const x of [-1, 1])
      tiles.push({ x, z, width: TILE, depth: TILE, kind: "floor", part: "plaza", flow: null });
  }
  for (const arm of arms) {
    // Three planks, each 1 long, from the plaza's edge (2) to the island's (5).
    for (const along of [2.5, 3.5, 4.5]) {
      tiles.push({
        x: arm.x * along,
        z: arm.z * along,
        width: arm.x !== 0 ? 1 : BRIDGE_WIDTH,
        depth: arm.z !== 0 ? 1 : BRIDGE_WIDTH,
        kind: "bridge",
        part: `${arm.part}-bridge`,
        flow: null,
      });
    }
  }
  return tiles;
}

/**
 * The conveyor works: the full square, with a rotary belt circling the middle 3×3 tiles and an
 * express lane along the far and the near edge. Everything turns the same way round: belts on
 * the -Z side run toward +X, belts on the +Z side run toward -X, so each lane ends by carrying
 * its riders off the stage.
 */
function factoryTiles(): StageTile[] {
  const s = CONVEYOR_SPEED;
  return gridTiles((col, row) => {
    const ring = ringOf(col, row);
    if (ring === 2) {
      const flow =
        row === -2 && col < 2
          ? { x: s, z: 0 }
          : col === 2 && row < 2
            ? { x: 0, z: s }
            : row === 2 && col > -2
              ? { x: -s, z: 0 }
              : { x: 0, z: -s };
      return gridTile(col, row, "conveyor", "rotary", flow);
    }
    if (row === -GRID) return gridTile(col, row, "conveyor", "far-lane", { x: s, z: 0 });
    if (row === GRID) return gridTile(col, row, "conveyor", "near-lane", { x: -s, z: 0 });
    return gridTile(col, row, "floor", ring <= 1 ? "core" : "deck");
  });
}

const ruinsRespawns = (): Vec2[] => {
  const points: Vec2[] = [];
  for (const z of [-5, 0, 5])
    for (const x of [-5, 0, 5]) if (x !== 0 || z !== 0) points.push({ x, z });
  return points;
};

const bridgesRespawns = (): Vec2[] => {
  const points: Vec2[] = [{ x: 0, z: 0 }];
  for (const sign of [-1, 1]) {
    for (const across of [-2, 0, 2]) {
      points.push({ x: sign * 7, z: across });
      points.push({ x: across, z: sign * 7 });
    }
  }
  return points;
};

export const STAGES: Record<StageId, StageDefinition> = {
  garden: {
    id: "garden",
    name: "浮遊庭園",
    title: "THE FLOATING GARDEN",
    label: "庭園",
    tagline: "終わりゆく足場",
    summary: "穴のない広い足場。外周から崩れ、最後は中央の小さな足場で決着がつく。",
    gimmicks: {
      collapse: { state: "on", note: "外周が2回崩れる" },
      safeZone: { state: "on", note: "予告した場所へ大きく移動する" },
      bombs: { state: "on", note: "予告のあとに落ちる" },
      wind: { state: "on", note: "ときどき弱く吹く" },
      conveyor: { state: "off", note: "なし" },
    },
    gimmickNote:
      "崩落・安全地帯・爆撃・風がすべて起きる。外周は2回崩れ、5×5タイルの足場まで狭くなる。",
    halfSize: RULES.arenaHalfSize,
    minHalfSize: RULES.minHalfSize,
    solid: true,
    tiles: gardenTiles(),
    spawnRadius: 3.5,
    respawns: [],
  },
  ruins: {
    id: "ruins",
    name: "中央穴の遺跡",
    title: "SUNKEN RUINS",
    label: "遺跡",
    tagline: "底なしの穴を囲む石の環",
    summary: "中央の大穴を囲む環状の足場。穴にも外にも落とせて、回り込んで挟み撃ちにできる。",
    gimmicks: {
      collapse: { state: "limited", note: "外周の1列だけ崩れる" },
      safeZone: { state: "on", note: "穴のまわりを周回する" },
      bombs: { state: "on", note: "足場の上にだけ落ちる" },
      wind: { state: "on", note: "ときどき弱く吹く" },
      conveyor: { state: "off", note: "なし" },
    },
    gimmickNote:
      "崩落は外周の1列だけ。安全地帯は穴のまわりを周回し、穴の真上には来ない。爆撃は足場の上にだけ落ちる。",
    halfSize: RULES.arenaHalfSize,
    minHalfSize: 7,
    solid: false,
    tiles: ruinsTiles(),
    spawnRadius: 6,
    respawns: ruinsRespawns(),
  },
  bridges: {
    id: "bridges",
    name: "細い橋の回廊",
    title: "SKY BRIDGES",
    label: "回廊",
    tagline: "四つの島をつなぐ細い橋",
    summary: "4つの島と中央の広場を細い橋が結ぶ。島で斬り合い、橋の上では一撃が命取り。",
    gimmicks: {
      collapse: { state: "off", note: "崩れない" },
      safeZone: { state: "on", note: "橋づたいに島を巡る" },
      bombs: { state: "on", note: "島と橋の上にだけ落ちる" },
      wind: { state: "off", note: "吹かない" },
      conveyor: { state: "off", note: "なし" },
    },
    gimmickNote:
      "崩落と風はなし。安全地帯は中央の広場から橋づたいに島を巡る。爆撃は島と橋の上にだけ落ちる。",
    halfSize: RULES.arenaHalfSize,
    minHalfSize: RULES.arenaHalfSize,
    solid: false,
    tiles: bridgesTiles(),
    spawnRadius: 7,
    respawns: bridgesRespawns(),
  },
  factory: {
    id: "factory",
    name: "コンベア工場",
    title: "CONVEYOR WORKS",
    label: "工場",
    tagline: "止まらない空の工房",
    summary:
      "矢印の向きへ流れるコンベアの工場。環状ベルトは中央を一周し、外側の2本は場外へ流れ出る。",
    gimmicks: {
      collapse: { state: "limited", note: "2回まで崩れる" },
      safeZone: { state: "on", note: "予告した場所へ大きく移動する" },
      bombs: { state: "on", note: "予告のあとに落ちる" },
      wind: { state: "off", note: "吹かない" },
      conveyor: { state: "on", note: "地上の全員を同じ速さで運ぶ" },
    },
    gimmickNote:
      "コンベアは地上の全員を同じ速さで運ぶ（空中と一時停止中は止まる。稽古でも動く）。崩落は2回まで、風はなし。",
    halfSize: RULES.arenaHalfSize,
    minHalfSize: 5,
    solid: true,
    tiles: factoryTiles(),
    spawnRadius: 6,
    respawns: [],
  },
};

export const STAGE_LIST: readonly StageDefinition[] = STAGE_IDS.map((id) => STAGES[id]);

/**
 * The stage's gimmick constraints for `effectiveRules` (`rules.ts`): any timed gimmick marked
 * `"off"` on the stage is locked off with the stage's reason so the title disables its toggle and
 * explains why before the match begins.
 */
export function stageInfoFor(stageId: StageId): StageInfo {
  const stage = STAGES[stageId];
  const constraints: GimmickConstraints = {};
  for (const id of RULE_GIMMICK_IDS) {
    const rule = stage.gimmicks[id];
    if (rule.state === "off")
      constraints[id] = { forced: false, reason: `${stage.name}では${rule.note}` };
  }
  return { id: stage.id, name: stage.title, constraints };
}

/** Stages with at least one belt; the others skip the conveyor step of the simulation entirely. */
const HAS_CONVEYORS: Record<StageId, boolean> = {
  garden: false,
  ruins: false,
  bridges: false,
  factory: true,
};
for (const stage of STAGE_LIST)
  HAS_CONVEYORS[stage.id] = stage.tiles.some((tile) => tile.kind === "conveyor");
export const hasConveyors = (stageId: StageId): boolean => HAS_CONVEYORS[stageId];

/** The half sizes a stage goes through as its outer ring collapses, largest first. */
export function collapseSteps(stageId: StageId): number[] {
  const { halfSize, minHalfSize } = STAGES[stageId];
  const steps: number[] = [];
  for (let size = halfSize; size >= minHalfSize; size -= TILE) steps.push(size);
  return steps;
}

/** A tile is still there while its centre is inside the surviving square. */
export function isTileSupported(tile: StageTile, halfSize: number): boolean {
  return Math.abs(tile.x) < halfSize && Math.abs(tile.z) < halfSize;
}

const tileContains = (tile: StageTile, x: number, z: number): boolean =>
  Math.abs(x - tile.x) <= tile.width / 2 && Math.abs(z - tile.z) <= tile.depth / 2;

/** Lookup cells are 1×1 and cover -10…10; each lists the tiles that touch it. */
const INDEX_SPAN = 10;
const INDEX_SIZE = INDEX_SPAN * 2;
const indexes = new Map<StageId, StageTile[][]>();

function tileIndex(stage: StageDefinition): StageTile[][] {
  let cells = indexes.get(stage.id);
  if (cells) return cells;
  cells = Array.from({ length: INDEX_SIZE * INDEX_SIZE }, () => []);
  for (const tile of stage.tiles) {
    for (let iz = 0; iz < INDEX_SIZE; iz++) {
      for (let ix = 0; ix < INDEX_SIZE; ix++) {
        const x0 = ix - INDEX_SPAN;
        const z0 = iz - INDEX_SPAN;
        if (
          tile.x - tile.width / 2 <= x0 + 1 &&
          tile.x + tile.width / 2 >= x0 &&
          tile.z - tile.depth / 2 <= z0 + 1 &&
          tile.z + tile.depth / 2 >= z0
        )
          cells[iz * INDEX_SIZE + ix]!.push(tile);
      }
    }
  }
  indexes.set(stage.id, cells);
  return cells;
}

/**
 * The standing tile under (x, z), or null over a pit, a gap, a collapsed tile or open sky. Where
 * tiles meet, a conveyor wins over plain floor so a belt's edge behaves like the belt.
 */
export function tileAt(stageId: StageId, x: number, z: number, halfSize: number): StageTile | null {
  const ix = Math.floor(x + INDEX_SPAN);
  const iz = Math.floor(z + INDEX_SPAN);
  if (!(ix >= 0 && ix < INDEX_SIZE && iz >= 0 && iz < INDEX_SIZE)) return null;
  let found: StageTile | null = null;
  for (const tile of tileIndex(STAGES[stageId])[iz * INDEX_SIZE + ix]!) {
    if (!isTileSupported(tile, halfSize) || !tileContains(tile, x, z)) continue;
    if (tile.kind === "conveyor") return tile;
    found ??= tile;
  }
  return found;
}

/**
 * Whether a fighter can stand at (x, z) while the stage's surviving square has this half size.
 * A solid stage (the garden, the factory) is its whole square; elsewhere it is exactly the
 * tiles still there, so pits, gaps between bridges and collapsed tiles all drop fighters.
 */
export function canStandAtStage(stageId: StageId, x: number, z: number, halfSize: number): boolean {
  if (STAGES[stageId].solid) return Math.abs(x) <= halfSize && Math.abs(z) <= halfSize;
  return tileAt(stageId, x, z, halfSize) !== null;
}

/** Standing at (x, z) with at least `margin` of floor in every direction. */
export function hasClearance(
  stageId: StageId,
  x: number,
  z: number,
  halfSize: number,
  margin: number,
): boolean {
  if (!canStandAtStage(stageId, x, z, halfSize)) return false;
  if (margin <= 0) return true;
  for (const dz of [-margin, 0, margin]) {
    for (const dx of [-margin, 0, margin]) {
      if ((dx !== 0 || dz !== 0) && !canStandAtStage(stageId, x + dx, z + dz, halfSize))
        return false;
    }
  }
  return true;
}

const STILL: Vec2 = Object.freeze({ x: 0, z: 0 });

/**
 * Where the belt under (x, z) carries a grounded fighter (units per second); zero off the belts.
 * The simulation applies it to every grounded fighter alike, player or CPU.
 */
export function conveyorVelocityAt(stageId: StageId, x: number, z: number, halfSize: number): Vec2 {
  if (!HAS_CONVEYORS[stageId]) return STILL;
  return tileAt(stageId, x, z, halfSize)?.flow ?? STILL;
}

/**
 * The standable point closest to (x, z), at least `inset` away from the edge of the tile it is
 * on (so `inset` away from any drop). The point itself when it already has that much room.
 */
export function nearestWalkablePoint(
  stageId: StageId,
  x: number,
  z: number,
  halfSize: number,
  inset = 0,
): Vec2 {
  const stage = STAGES[stageId];
  if (stage.solid) {
    const limit = Math.max(0, halfSize - inset);
    return { x: clamp(x, -limit, limit), z: clamp(z, -limit, limit) };
  }
  if (hasClearance(stageId, x, z, halfSize, inset)) return { x, z };
  let best: Vec2 | null = null;
  let bestDistance = Infinity;
  for (const tile of stage.tiles) {
    if (!isTileSupported(tile, halfSize)) continue;
    const reachX = Math.max(0, tile.width / 2 - inset);
    const reachZ = Math.max(0, tile.depth / 2 - inset);
    const px = clamp(x, tile.x - reachX, tile.x + reachX);
    const pz = clamp(z, tile.z - reachZ, tile.z + reachZ);
    const distance = Math.hypot(px - x, pz - z);
    if (distance < bestDistance - 1e-9) {
      best = { x: px, z: pz };
      bestDistance = distance;
    }
  }
  return best ?? { x: 0, z: 0 };
}

/**
 * Every standable point of a square lattice with this spacing (through the origin), each with
 * `margin` of floor around it. For tests, navigation and anything that needs "all of the floor".
 */
export function walkablePoints(
  stageId: StageId,
  halfSize: number,
  spacing = 1,
  margin = 0,
): Vec2[] {
  const points: Vec2[] = [];
  const steps = Math.floor(STAGES[stageId].halfSize / spacing);
  for (let iz = -steps; iz <= steps; iz++) {
    for (let ix = -steps; ix <= steps; ix++) {
      const x = ix * spacing;
      const z = iz * spacing;
      if (hasClearance(stageId, x, z, halfSize, margin)) points.push({ x, z });
    }
  }
  return points;
}

export interface SpawnPoint extends Vec2 {
  /** Facing the middle of the stage. */
  facing: number;
}

/**
 * Where a match's fighters start: opposite each other in a duel (and in training), on the four
 * cardinal directions in a rumble. Always on floor that is there from the first second.
 */
export function spawnPoints(stageId: StageId, fighterCount: number): SpawnPoint[] {
  const radius = STAGES[stageId].spawnRadius;
  return Array.from({ length: fighterCount }, (_, id) => {
    const theta =
      fighterCount === 2
        ? id === 0
          ? -Math.PI / 2
          : Math.PI / 2
        : (id * Math.PI) / 2 - Math.PI / 2;
    return { x: Math.sin(theta) * radius, z: Math.cos(theta) * radius, facing: theta + Math.PI };
  });
}

/** How much floor a returning fighter gets around its landing spot. */
const RESPAWN_MARGIN = 0.7;
/** The room it still gets when no spot with the full margin is inside the safe zone. */
const RESPAWN_FALLBACK_MARGIN = 0.4;

/**
 * Where a fighter may come back after a fall: inside the safe zone when it is active (`zone`),
 * else near the middle of the stage. Every point is over floor, away from pits and edges; the
 * engine picks the one farthest from the opponents that no bomb is about to hit.
 *
 * Never empty, so the engine always has somewhere to put a fighter. A zone too tight or too far
 * off the floor to hold a spot with the full margin (over the pit, between two bridges) gets the
 * floor nearest its centre instead, with a smaller margin: within 0.6 of a centre that is over
 * floor, and as close as the floor comes to one that is not (which can be outside the zone).
 */
export function respawnCandidates(
  stageId: StageId,
  halfSize: number,
  zone: ZoneCircle | null,
): Vec2[] {
  const stage = STAGES[stageId];
  const centre = zone ? { x: zone.x, z: zone.z } : { x: 0, z: 0 };
  const ring = zone ? zone.radius * 0.55 : 3;
  const around: Vec2[] = [centre];
  for (let k = 0; k < 8; k++) {
    const angle = (k * Math.PI) / 4;
    around.push({ x: centre.x + Math.sin(angle) * ring, z: centre.z + Math.cos(angle) * ring });
  }
  if (stage.solid) {
    const limit = Math.max(0, halfSize - 1);
    return around.map((p) => ({ x: clamp(p.x, -limit, limit), z: clamp(p.z, -limit, limit) }));
  }
  const within = (p: Vec2, share: number): boolean =>
    !zone || Math.hypot(p.x - zone.x, p.z - zone.z) <= zone.radius * share + 1e-9;
  const points = stage.respawns.filter(
    (p) => hasClearance(stageId, p.x, p.z, halfSize, RESPAWN_MARGIN) && within(p, 0.8),
  );
  // Around a zone that sits between the fixed points: the nearest floor to its centre and ring.
  if (zone) {
    for (const p of around) {
      const spot = nearestWalkablePoint(stageId, p.x, p.z, halfSize, RESPAWN_MARGIN);
      const known = points.some((q) => Math.hypot(q.x - spot.x, q.z - spot.z) < 0.25);
      if (!known && within(spot, 0.9)) points.push(spot);
    }
  }
  // Nothing with the full margin is in reach: the nearest floor of all, which is standable for
  // as long as a single tile of the stage is left.
  if (points.length === 0) {
    points.push(
      nearestWalkablePoint(stageId, centre.x, centre.z, halfSize, RESPAWN_FALLBACK_MARGIN),
    );
  }
  return points;
}
