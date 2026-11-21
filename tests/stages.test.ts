import { describe, expect, test } from "vite-plus/test";
import { BattleEngine, canStandAt, matchTimeLimit } from "../src/game/engine";
import { DEFAULT_MATCH_OPTIONS, sanitizeMatchOptions, type AiLevel } from "../src/game/match";
import { clearWalk, routeDirection, walkDistance } from "../src/game/navigation";
import {
  BRIDGE_WIDTH,
  canStandAtStage,
  collapseSteps,
  CONVEYOR_SPEED,
  conveyorVelocityAt,
  GIMMICK_IDS,
  hasClearance,
  hasConveyors,
  isTileSupported,
  nearestWalkablePoint,
  respawnCandidates,
  safeZoneAt,
  spawnPoints,
  STAGE_IDS,
  STAGE_LIST,
  STAGES,
  tileAt,
  walkablePoints,
  type StageId,
  type StageTile,
} from "../src/game/stages";
import { RULES } from "../src/game/tuning";
import {
  emptyInput,
  type Fighter,
  type GameState,
  type MatchMode,
  type PlayerInput,
  type Vec2,
} from "../src/game/types";

const DT = 1 / 60;
const LEVELS: AiLevel[] = ["easy", "normal", "hard"];
const NEW_STAGES: StageId[] = ["ruins", "bridges", "factory"];
/** The stages with a pit or gaps: floor is only where a tile is. */
const GAPPED_STAGES: StageId[] = ["ruins", "bridges"];

/** A started match, already past the countdown. */
function match(
  stage: StageId,
  mode: MatchMode = "duel",
  difficulty: AiLevel = "normal",
  seed = 4242,
) {
  const engine = new BattleEngine(seed);
  engine.start(mode, { stage, stocks: 3, difficulty, overrides: {} });
  engine.state.phase = "playing" as GameState["phase"];
  return engine;
}

function advance(engine: BattleEngine, seconds: number, input: PlayerInput = emptyInput()) {
  for (let frame = 0; frame < Math.round(seconds / DT); frame++) engine.update(DT, input);
}

/** What a CPU would press this tick (the engine's private decision function). */
const think = (engine: BattleEngine, f: Fighter): PlayerInput =>
  (engine as unknown as { ai(f: Fighter, dt: number): PlayerInput }).ai(f, DT);

const inside = (tile: StageTile, x: number, z: number): boolean =>
  Math.abs(x - tile.x) <= tile.width / 2 && Math.abs(z - tile.z) <= tile.depth / 2;

/** Every point of a fine lattice over the square the stages fit in, and a little beyond. */
function lattice(step: number, span = 10): Vec2[] {
  const points: Vec2[] = [];
  const count = Math.round(span / step);
  for (let iz = -count; iz <= count; iz++)
    for (let ix = -count; ix <= count; ix++) points.push({ x: ix * step, z: iz * step });
  return points;
}

/** The lattice points reachable from `start` by steps to a standable neighbour. */
function reachable(stage: StageId, halfSize: number, start: Vec2, step = 0.5): Set<string> {
  const key = (p: Vec2) => `${Math.round(p.x / step)},${Math.round(p.z / step)}`;
  const seen = new Set<string>([key(start)]);
  const queue = [start];
  while (queue.length > 0) {
    const p = queue.pop()!;
    for (const [dx, dz] of [
      [step, 0],
      [-step, 0],
      [0, step],
      [0, -step],
    ]) {
      const next = { x: p.x + dx!, z: p.z + dz! };
      if (seen.has(key(next)) || !canStandAtStage(stage, next.x, next.z, halfSize)) continue;
      seen.add(key(next));
      queue.push(next);
    }
  }
  return seen;
}

describe("the stage catalogue", () => {
  test("has the garden and three new stages, each fully described", () => {
    expect(STAGE_IDS).toEqual(["garden", "ruins", "bridges", "factory"]);
    expect(STAGE_LIST.map((stage) => stage.title)).toEqual([
      "THE FLOATING GARDEN",
      "SUNKEN RUINS",
      "SKY BRIDGES",
      "CONVEYOR WORKS",
    ]);
    expect(STAGE_LIST.map((stage) => stage.name)).toEqual([
      "浮遊庭園",
      "中央穴の遺跡",
      "細い橋の回廊",
      "コンベア工場",
    ]);
    for (const stage of STAGE_LIST) {
      expect(STAGES[stage.id]).toBe(stage);
      for (const text of [stage.label, stage.tagline, stage.summary, stage.gimmickNote])
        expect(text.length).toBeGreaterThan(1);
      // Every gimmick has a rule and words for the selection screen.
      for (const id of GIMMICK_IDS) {
        expect(["on", "limited", "off"]).toContain(stage.gimmicks[id].state);
        expect(stage.gimmicks[id].note.length).toBeGreaterThan(1);
      }
      expect(stage.gimmicks.conveyor.state !== "off").toBe(hasConveyors(stage.id));
      expect(stage.minHalfSize).toBeLessThanOrEqual(stage.halfSize);
    }
  });

  test("the gimmick rules say what each stage really does", () => {
    expect(STAGES.garden.gimmicks.collapse.state).toBe("on");
    expect(STAGES.ruins.gimmicks.collapse.state).toBe("limited");
    expect(STAGES.bridges.gimmicks.collapse.state).toBe("off");
    expect(STAGES.factory.gimmicks.collapse.state).toBe("limited");
    expect(collapseSteps("garden")).toEqual([9, 7, 5, 3]);
    expect(collapseSteps("ruins")).toEqual([9, 7]);
    expect(collapseSteps("bridges")).toEqual([9]);
    expect(collapseSteps("factory")).toEqual([9, 7, 5]);
    expect(STAGE_IDS.filter((id) => STAGES[id].gimmicks.wind.state === "off")).toEqual([
      "bridges",
      "factory",
    ]);
    expect(STAGE_IDS.filter(hasConveyors)).toEqual(["factory"]);
    for (const stage of STAGE_LIST) {
      // A stage that collapses less than the garden, or not at all, says so.
      const full = stage.minHalfSize === RULES.minHalfSize;
      expect(stage.gimmicks.collapse.state === "on").toBe(full);
      expect(stage.gimmicks.collapse.state === "off").toBe(stage.minHalfSize === stage.halfSize);
    }
  });

  test("the stage is a match option: the garden by default and for options saved before stages", () => {
    expect(DEFAULT_MATCH_OPTIONS.stage).toBe("garden");
    expect(sanitizeMatchOptions({ stocks: 2, difficulty: "hard" }).stage).toBe("garden");
    expect(sanitizeMatchOptions({ stage: "volcano" }).stage).toBe("garden");
    expect(sanitizeMatchOptions({ stage: 3 }).stage).toBe("garden");
    expect(sanitizeMatchOptions(null).stage).toBe("garden");
    for (const id of STAGE_IDS) expect(sanitizeMatchOptions({ stage: id }).stage).toBe(id);
  });

  test("a match is fought on the chosen stage, rematches included, and the title shows it", () => {
    const engine = new BattleEngine(7);
    expect(engine.state.arena.stageId).toBe("garden");
    for (const id of STAGE_IDS) {
      engine.start("rumble", { stage: id });
      expect(engine.state.arena.stageId).toBe(id);
      expect(engine.state.options.stage).toBe(id);
      expect(engine.state.arena.halfSize).toBe(STAGES[id].halfSize);
      // Restarting without options keeps the stage.
      engine.start("duel");
      expect(engine.state.arena.stageId).toBe(id);
      engine.menu();
      expect(engine.state.phase).toBe("menu");
      expect(engine.state.arena.stageId).toBe(id);
    }
    // Picking another stage on the title swaps the one on show at once.
    engine.menu({ stage: "bridges" });
    expect(engine.state.phase).toBe("menu");
    expect(engine.state.arena.stageId).toBe("bridges");
    expect(engine.state.fighters.map((f) => [f.x, f.z])).toEqual(
      spawnPoints("bridges", 2).map((p) => [p.x, p.z]),
    );
  });
});

describe("what is drawn is what holds a fighter", () => {
  test.each(STAGE_IDS)("%s: standing floor is exactly the tiles still there", (id) => {
    const stage = STAGES[id];
    // The renderer draws a slab for each tile while isTileSupported says so; collision must be
    // the union of those slabs, at every size the collapse goes through.
    for (const halfSize of collapseSteps(id)) {
      const shown = stage.tiles.filter((tile) => isTileSupported(tile, halfSize));
      for (const p of lattice(0.25)) {
        const drawn = shown.some((tile) => inside(tile, p.x, p.z));
        expect(canStandAtStage(id, p.x, p.z, halfSize), `${id} ${halfSize} (${p.x}, ${p.z})`).toBe(
          drawn,
        );
        expect(tileAt(id, p.x, p.z, halfSize) !== null).toBe(drawn);
      }
    }
  });

  test.each(STAGE_IDS)("%s: tiles lie inside the square and never overlap", (id) => {
    const { tiles, halfSize } = STAGES[id];
    for (const tile of tiles) {
      expect(Math.abs(tile.x) + tile.width / 2).toBeLessThanOrEqual(halfSize);
      expect(Math.abs(tile.z) + tile.depth / 2).toBeLessThanOrEqual(halfSize);
      expect(tile.flow !== null).toBe(tile.kind === "conveyor");
    }
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        const a = tiles[i]!;
        const b = tiles[j]!;
        const overlapX =
          Math.min(a.x + a.width / 2, b.x + b.width / 2) -
          Math.max(a.x - a.width / 2, b.x - b.width / 2);
        const overlapZ =
          Math.min(a.z + a.depth / 2, b.z + b.depth / 2) -
          Math.max(a.z - a.depth / 2, b.z - b.depth / 2);
        expect(overlapX > 1e-9 && overlapZ > 1e-9, `${a.x},${a.z} / ${b.x},${b.z}`).toBe(false);
      }
    }
  });

  test("the garden is the square it has always been", () => {
    const garden = STAGES.garden;
    expect(garden.tiles).toHaveLength(81);
    expect(garden.solid).toBe(true);
    expect([garden.halfSize, garden.minHalfSize]).toEqual([RULES.arenaHalfSize, RULES.minHalfSize]);
    expect(garden.tiles.every((tile) => tile.kind === "floor" && tile.width === 2)).toBe(true);
    // The old rule, at any size: inside the rim and nothing else.
    for (const halfSize of [9, 7, 5, 3, 8.2, 4]) {
      for (const p of lattice(0.5)) {
        expect(canStandAtStage("garden", p.x, p.z, halfSize)).toBe(
          Math.abs(p.x) <= halfSize && Math.abs(p.z) <= halfSize,
        );
      }
    }
    // The old spawns, to the last bit.
    expect(spawnPoints("garden", 2)).toEqual([
      { x: Math.sin(-Math.PI / 2) * 3.5, z: Math.cos(-Math.PI / 2) * 3.5, facing: Math.PI / 2 },
      { x: Math.sin(Math.PI / 2) * 3.5, z: Math.cos(Math.PI / 2) * 3.5, facing: 1.5 * Math.PI },
    ]);
    expect(spawnPoints("garden", 4).map((p) => [p.x, p.z])).toEqual(
      [0, 1, 2, 3].map((id) => {
        const theta = (id * Math.PI) / 2 - Math.PI / 2;
        return [Math.sin(theta) * 3.5, Math.cos(theta) * 3.5];
      }),
    );
    // The old safe zone and the old respawn candidates.
    for (const elapsed of [18, 31, 55, 77.5, 118, 149, 260]) {
      for (const halfSize of [9, 7, 5, 3]) {
        const progress = Math.max(0, Math.min(1, (elapsed - RULES.safeZoneStart) / 100));
        const radius = Math.min(halfSize * 0.94, 8.4 - progress * 5.7);
        const margin = Math.max(0, halfSize - radius - 0.12);
        const zone = safeZoneAt("garden", elapsed, halfSize);
        expect(zone).toEqual({
          x: Math.sin(elapsed * 0.055) * margin,
          z: Math.cos(elapsed * 0.07) * margin,
          radius,
        });
        const limit = Math.max(0, halfSize - 1);
        const clamp = (v: number) => Math.max(-limit, Math.min(limit, v));
        const reach = zone.radius * 0.55;
        const ring = [...Array(8).keys()].map((k) => ({
          x: clamp(zone.x + Math.sin((k * Math.PI) / 4) * reach),
          z: clamp(zone.z + Math.cos((k * Math.PI) / 4) * reach),
        }));
        expect(respawnCandidates("garden", halfSize, zone)).toEqual([
          { x: clamp(zone.x), z: clamp(zone.z) },
          ...ring,
        ]);
      }
    }
    expect(respawnCandidates("garden", 9, null)[0]).toEqual({ x: 0, z: 0 });
    expect(respawnCandidates("garden", 9, null)[3]).toEqual({ x: 3, z: Math.cos(Math.PI / 2) * 3 });
  });

  test("the garden's match runs its old collapse, wind and bombs", () => {
    const engine = match("garden");
    for (const f of engine.state.fighters) Object.assign(f, { hitstop: 1000, invulnerable: 1000 });
    const sizes = new Set<number>();
    let wind = false;
    const bombs: Vec2[] = [];
    for (let t = 1; t <= 120; t++) {
      engine.state.elapsed = t;
      engine.update(DT, emptyInput());
      sizes.add(engine.state.arena.halfSize);
      wind ||= engine.state.arena.windActive;
      for (const bomb of engine.state.bombs) bombs.push({ x: bomb.x, z: bomb.z });
    }
    expect([...sizes]).toEqual([9, 7, 5, 3]);
    expect(wind).toBe(true);
    expect(bombs.length).toBeGreaterThan(0);
  });

  test("nearest floor and floor sampling agree with standing", () => {
    for (const id of STAGE_IDS) {
      for (const halfSize of collapseSteps(id)) {
        expect(walkablePoints(id, halfSize).length).toBeGreaterThan(0);
        for (const p of walkablePoints(id, halfSize, 0.5))
          expect(canStandAtStage(id, p.x, p.z, halfSize)).toBe(true);
        for (const p of lattice(1.5, 12)) {
          for (const inset of [0, 0.4, 0.7]) {
            const near = nearestWalkablePoint(id, p.x, p.z, halfSize, inset);
            expect(canStandAtStage(id, near.x, near.z, halfSize)).toBe(true);
            // A point with room to spare is its own nearest floor.
            if (hasClearance(id, p.x, p.z, halfSize, inset)) expect(near).toEqual(p);
          }
        }
      }
    }
    expect(walkablePoints("garden", 9)).toHaveLength(19 * 19);
    // In the pit the nearest floor is the rim beside it, a step in from its edge.
    const rim = nearestWalkablePoint("ruins", 2, 0.5, 9, 0.6);
    expect(rim.x).toBeCloseTo(3.6, 6);
    expect(Math.abs(rim.z - 0.5)).toBeLessThan(0.11);
    expect(hasClearance("ruins", rim.x, rim.z, 9, 0.6)).toBe(true);
    // Off the outside of an island it is that island, and beside a bridge the bridge.
    expect(nearestWalkablePoint("bridges", 10, 1, 9)).toEqual({ x: 9, z: 1 });
    expect(nearestWalkablePoint("bridges", 3.5, 2, 9)).toEqual({ x: 3.5, z: BRIDGE_WIDTH / 2 });
  });
});

describe("the sunken ruins: a pit in the middle, a ring to fight on", () => {
  test("the central pit has no floor and the whole ring round it has", () => {
    expect(STAGES.ruins.solid).toBe(false);
    expect(STAGES.ruins.tiles).toHaveLength(81 - 9);
    for (const p of lattice(0.25)) {
      const reach = Math.max(Math.abs(p.x), Math.abs(p.z));
      expect(canStandAtStage("ruins", p.x, p.z, 9), `(${p.x}, ${p.z})`).toBe(
        reach >= 3 && reach <= 9,
      );
    }
    // The ring is one piece: a rival can be flanked round either side of the hole.
    const ring = reachable("ruins", 9, { x: -6, z: 0 });
    for (const p of [
      { x: 6, z: 0 },
      { x: 0, z: 6 },
      { x: 0, z: -6 },
      { x: 8.5, z: -8.5 },
    ])
      expect(ring.has(`${p.x / 0.5},${p.z / 0.5}`)).toBe(true);
    expect(ring.has("0,0")).toBe(false);
  });

  test("a fighter over the pit falls in, and one on the ring stands", () => {
    const engine = match("ruins", "training");
    const [player, partner] = engine.state.fighters;
    expect(canStandAt(engine.state, player.x, player.z)).toBe(true);
    advance(engine, 0.5);
    expect(player.grounded).toBe(true);
    expect(player.y).toBe(0);
    // Walking from the ring toward the middle: the ground ends at the pit's mouth.
    Object.assign(partner, { x: 0, z: 0, y: 0, grounded: true });
    advance(engine, 0.2);
    expect(partner.grounded).toBe(false);
    expect(partner.y).toBeLessThan(0);
    const walk = { ...emptyInput(), move: { x: 1, z: 0 } };
    advance(engine, 0.55, walk);
    expect(player.x).toBeGreaterThan(-3.6);
    expect(player.grounded).toBe(true);
    advance(engine, 0.3, walk);
    expect(player.x).toBeGreaterThan(-3);
    expect(player.grounded).toBe(false);
    advance(engine, 1.2, walk);
    expect(player.mode).toBe("dead");
    expect(player.eliminationReason).toBe("場外に落下");
  });

  test("it loses only its outer ring, once", () => {
    const engine = match("ruins");
    for (const f of engine.state.fighters) Object.assign(f, { hitstop: 1000, invulnerable: 1000 });
    const sizes: number[] = [];
    let warned = 0;
    for (let t = 1; t <= matchTimeLimit(3); t++) {
      engine.state.elapsed = t;
      engine.update(DT, emptyInput());
      sizes.push(engine.state.arena.halfSize);
      if (engine.state.arena.warningRing) warned++;
    }
    expect(new Set(sizes)).toEqual(new Set([9, 7]));
    expect(sizes[30]).toBe(9);
    expect(sizes[32]).toBe(7);
    // Warned for the four seconds before the one collapse, and never again.
    expect(warned).toBe(RULES.collapseWarning);
    // The two rows round the pit are still there, and the pit is still a pit.
    expect(canStandAt(engine.state, 5, 5)).toBe(true);
    expect(canStandAt(engine.state, 7.5, 0)).toBe(false);
    expect(canStandAt(engine.state, 0, 0)).toBe(false);
  });
});

describe("the sky bridges: islands, a plaza and narrow bridges between them", () => {
  const ISLANDS: Vec2[] = [
    { x: -7, z: 0 },
    { x: 7, z: 0 },
    { x: 0, z: -7 },
    { x: 0, z: 7 },
  ];

  test("four islands and a plaza, joined by bridges narrower than a tile", () => {
    const parts = new Set(STAGES.bridges.tiles.map((tile) => tile.part));
    expect([...parts].sort()).toEqual(
      [
        "east-bridge",
        "east-island",
        "north-bridge",
        "north-island",
        "plaza",
        "south-bridge",
        "south-island",
        "west-bridge",
        "west-island",
      ].sort(),
    );
    expect(BRIDGE_WIDTH).toBeLessThan(RULES.tileSize);
    expect(BRIDGE_WIDTH).toBeGreaterThan(RULES.fighterRadius * 2);
    // Room to fight on an island and on the plaza.
    for (const island of ISLANDS)
      expect(hasClearance("bridges", island.x, island.z, 9, 1.9)).toBe(true);
    expect(hasClearance("bridges", 0, 0, 9, 1.9)).toBe(true);
    // A bridge holds a fighter on its centre line, with no room to sidestep.
    for (const along of [2.2, 3, 3.5, 4.2, 4.9]) {
      for (const [x, z] of [
        [along, 0],
        [-along, 0],
        [0, along],
        [0, -along],
      ]) {
        expect(canStandAtStage("bridges", x!, z!, 9)).toBe(true);
        expect(hasClearance("bridges", x!, z!, 9, BRIDGE_WIDTH / 2 + 0.05)).toBe(false);
      }
    }
    expect(canStandAtStage("bridges", 3.5, BRIDGE_WIDTH / 2, 9)).toBe(true);
    expect(canStandAtStage("bridges", 3.5, BRIDGE_WIDTH / 2 + 0.01, 9)).toBe(false);
  });

  test("every island can be walked to from every other, only over the bridges", () => {
    const floor = reachable("bridges", 9, ISLANDS[0]!);
    for (const island of ISLANDS)
      expect(floor.has(`${island.x / 0.5},${island.z / 0.5}`)).toBe(true);
    // All of the floor is one connected piece.
    expect(floor.size).toBe(walkablePoints("bridges", 9, 0.5).length);
    for (const from of ISLANDS) {
      for (const to of ISLANDS) {
        const distance = walkDistance("bridges", 9, from, to);
        expect(Number.isFinite(distance)).toBe(true);
        // Neighbours are 9.9 apart as the crow flies; on foot the way is through the plaza.
        if (from !== to) {
          expect(distance).toBeGreaterThan(12.5);
          expect(distance).toBeLessThan(15);
        }
      }
    }
  });

  test("the gaps beside the bridges and between the islands drop fighters", () => {
    for (const [x, z] of [
      [3.5, 1.2],
      [3.5, -1.2],
      [-1.2, 3.5],
      [6, 6],
      [-6, 6],
      [4, 4],
      [2.6, 2.6],
      [9, 3.5],
    ])
      expect(canStandAtStage("bridges", x!, z!, 9), `(${x}, ${z})`).toBe(false);
    const engine = match("bridges", "training");
    const [player] = engine.state.fighters;
    Object.assign(player, { x: 3.5, z: 0 });
    advance(engine, 0.2);
    expect(player.grounded).toBe(true);
    // One sidestep off the bridge.
    advance(engine, 0.35, { ...emptyInput(), move: { x: 0, z: 1 } });
    expect(Math.abs(player.z)).toBeGreaterThan(BRIDGE_WIDTH / 2);
    expect(player.grounded).toBe(false);
    advance(engine, 1.2);
    expect(player.mode).toBe("dead");
  });

  test("nothing collapses and no wind blows", () => {
    const engine = match("bridges", "rumble");
    for (const f of engine.state.fighters) Object.assign(f, { hitstop: 1000, invulnerable: 1000 });
    for (let t = 1; t <= matchTimeLimit(3); t++) {
      engine.state.elapsed = t;
      engine.update(DT, emptyInput());
      expect(engine.state.arena.halfSize).toBe(9);
      expect(engine.state.arena.warningRing).toBe(false);
      expect(engine.state.arena.windActive).toBe(false);
    }
    for (const tile of STAGES.bridges.tiles) expect(isTileSupported(tile, 9)).toBe(true);
  });
});

describe("the conveyor works: belts that carry whoever stands on them", () => {
  test("the rotary turns one way round and the two lanes run off the stage", () => {
    const s = CONVEYOR_SPEED;
    expect(s).toBeLessThan(RULES.moveSpeed);
    const at = (x: number, z: number, halfSize = 9) =>
      conveyorVelocityAt("factory", x, z, halfSize);
    // The rotary: +X along the far side, +Z down the +X side, -X along the near side, -Z back.
    expect(at(0, -4)).toEqual({ x: s, z: 0 });
    expect(at(4, 0)).toEqual({ x: 0, z: s });
    expect(at(0, 4)).toEqual({ x: -s, z: 0 });
    expect(at(-4, 0)).toEqual({ x: 0, z: -s });
    // Its corners hand over to the next side, so a rider goes all the way round.
    expect(at(4, -4)).toEqual({ x: 0, z: s });
    expect(at(4, 4)).toEqual({ x: -s, z: 0 });
    expect(at(-4, 4)).toEqual({ x: 0, z: -s });
    expect(at(-4, -4)).toEqual({ x: s, z: 0 });
    // The express lanes along the far and near edges, corner to corner.
    for (const x of [-8.5, -3, 0, 6, 8.9]) {
      expect(at(x, -8)).toEqual({ x: s, z: 0 });
      expect(at(x, 8)).toEqual({ x: -s, z: 0 });
    }
    // Still floor: the calm middle and the deck between the belts.
    for (const [x, z] of [
      [0, 0],
      [2, -2],
      [6, 0],
      [-6, 6],
      [8, 0],
    ])
      expect(at(x!, z!)).toEqual({ x: 0, z: 0 });
    // Off the stage, and on belts the collapse has taken, nothing carries.
    expect(at(0, -9.5)).toEqual({ x: 0, z: 0 });
    expect(at(0, -8, 7)).toEqual({ x: 0, z: 0 });
    expect(at(0, -4, 5)).toEqual({ x: s, z: 0 });
    // No other stage has belts.
    for (const id of ["garden", "ruins", "bridges"] as StageId[])
      for (const p of lattice(1))
        expect(conveyorVelocityAt(id, p.x, p.z, 9)).toEqual({ x: 0, z: 0 });
  });

  test("a grounded player and a grounded CPU are carried exactly alike", () => {
    // Training: the CPU partner presses nothing, so only the belt moves it.
    const engine = match("factory", "training");
    const [player, cpu] = engine.state.fighters;
    expect([player.human, cpu.human]).toEqual([true, false]);
    Object.assign(player, { x: -2, z: -8 });
    Object.assign(cpu, { x: 3, z: -8 });
    advance(engine, 0.5);
    expect(player.x - -2).toBeCloseTo(CONVEYOR_SPEED * 0.5, 9);
    expect(cpu.x - 3).toBeCloseTo(player.x - -2, 9);
    expect([player.z, cpu.z]).toEqual([-8, -8]);
    expect([player.grounded, cpu.grounded]).toEqual([true, true]);
    // The same in a real match, with the CPU thinking: stuck in recovery it cannot walk.
    const duel = match("factory", "duel", "hard");
    const [human, rival] = duel.state.fighters;
    Object.assign(human, { x: 4, z: 8, mode: "recovery", modeDuration: 5, invulnerable: 100 });
    Object.assign(rival, { x: -2, z: 8, mode: "recovery", modeDuration: 5, invulnerable: 100 });
    advance(duel, 0.4);
    expect(human.x - 4).toBeCloseTo(-CONVEYOR_SPEED * 0.4, 9);
    expect(rival.x - -2).toBeCloseTo(human.x - 4, 9);
  });

  test("a belt carries through walking, attacks and steps, and off its end", () => {
    const engine = match("factory", "training");
    const [player] = engine.state.fighters;
    // Walking against the belt still makes headway; with it, the speeds add.
    Object.assign(player, { x: 0, z: -8 });
    advance(engine, 0.5, { ...emptyInput(), move: { x: -1, z: 0 } });
    expect(player.x).toBeCloseTo((CONVEYOR_SPEED - RULES.moveSpeed) * 0.5, 4);
    Object.assign(player, { x: 0, z: -8 });
    advance(engine, 0.5, { ...emptyInput(), move: { x: 1, z: 0 } });
    expect(player.x).toBeCloseTo((CONVEYOR_SPEED + RULES.moveSpeed) * 0.5, 4);
    // Mid-swing a fighter cannot walk, but the belt still moves it.
    Object.assign(player, { x: 0, z: -8, vx: 0, vz: 0 });
    engine.update(DT, { ...emptyInput(), attackPressed: "sweep", attackHeld: "sweep" });
    advance(engine, 0.6);
    expect(["windup", "active", "recovery"]).toContain(player.mode);
    expect(player.x).toBeGreaterThan(CONVEYOR_SPEED * 0.55);
    // Left alone on the lane it rides to the end and off the stage.
    advance(engine, 1);
    Object.assign(player, { x: 6, z: -8, mode: "idle", attack: null });
    advance(engine, 1.5);
    expect(player.x).toBeGreaterThan(9);
    expect(player.grounded).toBe(false);
  });

  test("in the air the belt has no hold", () => {
    const engine = match("factory", "training");
    const [player, cpu] = engine.state.fighters;
    for (const f of [player, cpu]) Object.assign(f, { z: -8, y: 4, vy: 0, grounded: false });
    const start = [player.x, cpu.x];
    advance(engine, 0.3);
    expect([player.grounded, cpu.grounded]).toEqual([false, false]);
    expect([player.x, cpu.x]).toEqual(start);
    // A jump from the belt goes straight up and down: only the grounded frames were carried.
    Object.assign(player, { x: 0, z: -8, y: 0, vy: 0, grounded: true });
    engine.update(DT, { ...emptyInput(), jump: true });
    const lift = player.x;
    advance(engine, 0.5);
    expect(player.grounded).toBe(false);
    expect(player.x).toBe(lift);
  });

  test("a paused match stops the belts for everyone, and resuming starts them", () => {
    const engine = match("factory", "training");
    const [player, cpu] = engine.state.fighters;
    Object.assign(player, { x: -2, z: -8 });
    Object.assign(cpu, { x: 2, z: 8 });
    advance(engine, 0.2);
    engine.pause();
    const frozen = [player.x, player.z, cpu.x, cpu.z];
    advance(engine, 1);
    expect([player.x, player.z, cpu.x, cpu.z]).toEqual(frozen);
    engine.resume();
    advance(engine, 0.2);
    expect(player.x).toBeGreaterThan(frozen[0]!);
    expect(cpu.x).toBeLessThan(frozen[2]!);
    // The countdown before a match carries nobody either.
    const waiting = new BattleEngine(3);
    waiting.start("duel", { stage: "factory" });
    Object.assign(waiting.state.fighters[0], { x: 0, z: -8 });
    advance(waiting, 1);
    expect(waiting.state.phase).toBe("countdown");
    expect(waiting.state.fighters[0].x).toBe(0);
  });

  test("it loses its lanes, then its deck, and ends with the rotary as its rim", () => {
    const engine = match("factory");
    for (const f of engine.state.fighters) Object.assign(f, { hitstop: 1000, invulnerable: 1000 });
    const sizes = new Set<number>();
    for (let t = 1; t <= matchTimeLimit(3); t++) {
      engine.state.elapsed = t;
      engine.update(DT, emptyInput());
      sizes.add(engine.state.arena.halfSize);
      expect(engine.state.arena.windActive).toBe(false);
    }
    expect([...sizes]).toEqual([9, 7, 5]);
    const left = STAGES.factory.tiles.filter((tile) => isTileSupported(tile, 5));
    expect(left).toHaveLength(25);
    expect(left.filter((tile) => tile.kind === "conveyor")).toHaveLength(16);
  });
});

describe("spawns and respawns are always on floor", () => {
  test.each(STAGE_IDS)("%s: duel and rumble spawns are safe and apart", (id) => {
    const stage = STAGES[id];
    for (const count of [2, 4]) {
      const spawns = spawnPoints(id, count);
      expect(spawns).toHaveLength(count);
      for (const [i, spawn] of spawns.entries()) {
        // Solid floor with room around it, and still there after the first collapse.
        for (const halfSize of collapseSteps(id).slice(0, 2))
          expect(hasClearance(id, spawn.x, spawn.z, halfSize, 0.9), `${id} spawn ${i}`).toBe(true);
        // Never on a moving belt.
        expect(tileAt(id, spawn.x, spawn.z, stage.halfSize)?.kind).toBe("floor");
        expect(conveyorVelocityAt(id, spawn.x, spawn.z, stage.halfSize)).toEqual({ x: 0, z: 0 });
        // Facing the middle of the stage.
        expect(Math.sin(spawn.facing) * -spawn.x + Math.cos(spawn.facing) * -spawn.z).toBeCloseTo(
          stage.spawnRadius,
          6,
        );
        for (const other of spawns.slice(i + 1)) {
          expect(Math.hypot(spawn.x - other.x, spawn.z - other.z)).toBeGreaterThan(
            4 * RULES.fighterRadius,
          );
        }
      }
    }
    for (const mode of ["duel", "rumble", "training"] as MatchMode[]) {
      const engine = match(id, mode);
      const spawns = spawnPoints(id, engine.state.fighters.length);
      for (const [i, f] of engine.state.fighters.entries()) {
        expect([f.x, f.z, f.facing]).toEqual([spawns[i]!.x, spawns[i]!.z, spawns[i]!.facing]);
        expect(canStandAt(engine.state, f.x, f.z)).toBe(true);
        expect(f.grounded).toBe(true);
      }
      // Standing still, nobody has moved or fallen a second later.
      if (mode === "training") {
        advance(engine, 1);
        for (const [i, f] of engine.state.fighters.entries()) {
          expect([f.x, f.z, f.y, f.grounded]).toEqual([spawns[i]!.x, spawns[i]!.z, 0, true]);
        }
      }
    }
  });

  test.each(STAGE_IDS)("%s: every respawn candidate is over floor, inside the safe zone", (id) => {
    for (const halfSize of collapseSteps(id)) {
      const calm = respawnCandidates(id, halfSize, null);
      expect(calm.length).toBeGreaterThan(0);
      for (const p of calm) expect(hasClearance(id, p.x, p.z, halfSize, 0.5)).toBe(true);
      for (let elapsed = RULES.safeZoneStart; elapsed <= 340; elapsed += 1.5) {
        const zone = safeZoneAt(id, elapsed, halfSize);
        const candidates = respawnCandidates(id, halfSize, zone);
        expect(candidates.length, `${id} ${halfSize} ${elapsed}`).toBeGreaterThan(0);
        for (const p of candidates) {
          expect(canStandAtStage(id, p.x, p.z, halfSize), `${id} ${halfSize} ${elapsed}`).toBe(
            true,
          );
          expect(Math.hypot(p.x - zone.x, p.z - zone.z)).toBeLessThanOrEqual(zone.radius);
          // With floor around it: a fighter dropping in does not land on a lip.
          if (!STAGES[id].solid) expect(hasClearance(id, p.x, p.z, halfSize, 0.5)).toBe(true);
        }
      }
    }
    // The fixed points of a stage with gaps never collapse and keep well clear of every drop.
    for (const p of STAGES[id].respawns)
      expect(hasClearance(id, p.x, p.z, STAGES[id].minHalfSize, 0.9)).toBe(true);
  });

  // A safe zone that goes wherever it likes (a moving zone, a much smaller one) can sit over the
  // pit or between two bridges, where no spot with the full margin is inside it.
  test.each(GAPPED_STAGES)(
    "%s: a tight safe zone anywhere still has a respawn candidate on floor",
    (id) => {
      for (const halfSize of collapseSteps(id)) {
        for (const radius of [1.6, 1.8, 2]) {
          let beside = 0;
          for (const centre of lattice(0.5)) {
            const zone = { ...centre, radius };
            const at = `${id} ${halfSize}, radius ${radius} at (${centre.x}, ${centre.z})`;
            const away = (p: Vec2): number => Math.hypot(p.x - zone.x, p.z - zone.z);
            const candidates = respawnCandidates(id, halfSize, zone);
            expect(candidates.length, at).toBeGreaterThan(0);
            for (const p of candidates) {
              expect(canStandAtStage(id, p.x, p.z, halfSize), at).toBe(true);
              // Not on a lip either: floor all round, even at the reduced margin.
              expect(hasClearance(id, p.x, p.z, halfSize, 0.3), at).toBe(true);
            }
            const outside = candidates.filter((p) => away(p) > radius);
            // A zone centred over floor always has its candidates inside it.
            if (canStandAtStage(id, zone.x, zone.z, halfSize)) expect(outside, at).toEqual([]);
            if (outside.length === 0) continue;
            // A zone with no room in it: one candidate, on the floor right beside the zone
            // (the nearest floor of all, give or take the margin), not across the stage.
            beside++;
            expect(candidates, at).toHaveLength(1);
            const floor = nearestWalkablePoint(id, zone.x, zone.z, halfSize);
            expect(away(outside[0]), at).toBeLessThanOrEqual(away(floor) + 0.6);
          }
          // The lattice does cover zones like that (over the pit, between the bridges).
          expect(beside, `${id} ${halfSize}, radius ${radius}`).toBeGreaterThan(0);
        }
      }
    },
  );

  test("a zone with no floor in it gets the nearest floor: the pit's rim, an island's corner", () => {
    // Over the ruins' pit: the rim tile straight ahead, 0.4 in from its edge.
    const pit = respawnCandidates("ruins", 9, { x: 0.5, z: -1, radius: 1.6 });
    expect(pit).toHaveLength(1);
    expect([pit[0].x, pit[0].z]).toEqual([expect.closeTo(0.5, 9), expect.closeTo(-3.4, 9)]);
    // Between the east and the south arm of the bridges: the corner of the east island.
    const gap = respawnCandidates("bridges", 9, { x: 4.5, z: 4, radius: 1.6 });
    expect(gap).toHaveLength(1);
    expect([gap[0].x, gap[0].z]).toEqual([expect.closeTo(5.4, 9), expect.closeTo(2.6, 9)]);
    // A zone that small on a bridge keeps to the planks' centre line.
    for (const p of respawnCandidates("bridges", 9, { x: 3.5, z: 0.6, radius: 1.6 })) {
      expect(Math.abs(p.z)).toBeLessThanOrEqual(BRIDGE_WIDTH / 2 - 0.7 + 1e-9);
      expect(tileAt("bridges", p.x, p.z, 9)?.kind).toBe("bridge");
    }
    // Never empty, whatever is asked: not even with every tile gone (nothing to stand on then).
    for (const id of STAGE_IDS) {
      expect(respawnCandidates(id, 1, null).length, id).toBeGreaterThan(0);
      expect(respawnCandidates(id, 1, { x: 6, z: -6, radius: 0.2 }).length, id).toBeGreaterThan(0);
    }
  });

  test.each(GAPPED_STAGES)(
    "%s: the engine always has a floor point to bring a fighter back to",
    (id) => {
      const engine = match(id, "duel");
      const [player] = engine.state.fighters;
      const respawnPoint = (f: Fighter): Vec2 =>
        (engine as unknown as { respawnPoint(f: Fighter): Vec2 }).respawnPoint(f);
      for (const centre of lattice(1)) {
        // Wherever the zone is and however tight, with a bomb about to hit its middle.
        Object.assign(engine.state.arena.safeZone, { ...centre, radius: 1.6, active: true });
        engine.state.bombs = [
          { id: 1, ...centre, radius: 4, timer: 1, duration: 1, exploded: false },
        ];
        const spot = respawnPoint(player);
        expect(spot, `${id} zone at (${centre.x}, ${centre.z})`).toBeDefined();
        expect(canStandAt(engine.state, spot.x, spot.z)).toBe(true);
      }
    },
  );

  test.each(NEW_STAGES)(
    "%s: a fallen fighter comes back on floor, before and during the zone",
    (id) => {
      for (const elapsed of [2, 40, 90, 140]) {
        const engine = match(id, "duel");
        const [player, cpu] = engine.state.fighters;
        // Everyone holds still while time is moved to the moment being tested.
        for (const f of [player, cpu]) Object.assign(f, { hitstop: 1000, invulnerable: 1000 });
        for (let t = 1; t <= elapsed; t++) {
          engine.state.elapsed = t;
          engine.update(DT, emptyInput());
        }
        engine.state.bombs = [];
        expect(player.mode).not.toBe("dead");
        Object.assign(player, { x: 30, z: 0, y: 0, grounded: false, hitstop: 0, outsideTime: 0 });
        engine.update(DT, emptyInput());
        expect(player.mode).toBe("dead");
        advance(engine, RULES.respawnDelay + 0.05);
        expect(player.mode).not.toBe("dead");
        expect(player.y).toBeGreaterThan(RULES.respawnHeight - 1);
        expect(canStandAt(engine.state, player.x, player.z), `${id} at ${elapsed}s`).toBe(true);
        const zone = engine.state.arena.safeZone;
        if (zone.active)
          expect(Math.hypot(player.x - zone.x, player.z - zone.z)).toBeLessThanOrEqual(zone.radius);
        engine.state.bombs = [];
        advance(engine, 0.9);
        expect(player.grounded, `${id} at ${elapsed}s`).toBe(true);
        expect(player.y).toBe(0);
      }
    },
  );
});

describe("the safe zone and the collapse always leave floor to stand on", () => {
  test.each(STAGE_IDS)("%s: the zone's centre is on floor at every moment and size", (id) => {
    const solid = STAGES[id].solid;
    for (const halfSize of collapseSteps(id)) {
      for (let elapsed = RULES.safeZoneStart; elapsed <= 400; elapsed += 0.5) {
        const zone = safeZoneAt(id, elapsed, halfSize);
        expect(zone.radius).toBeGreaterThan(2.5);
        expect(canStandAtStage(id, zone.x, zone.z, halfSize), `${id} ${halfSize} ${elapsed}`).toBe(
          true,
        );
        if (solid) {
          // Wholly on the surviving square, as in the garden.
          expect(Math.abs(zone.x) + zone.radius).toBeLessThanOrEqual(halfSize + 1e-6);
          expect(Math.abs(zone.z) + zone.radius).toBeLessThanOrEqual(halfSize + 1e-6);
        } else {
          // Never just a lip: there is floor all round the centre.
          expect(hasClearance(id, zone.x, zone.z, halfSize, 0.5)).toBe(true);
        }
      }
    }
  });

  test("the ruins' zone circles the pit and the bridges' zone travels the bridges", () => {
    const quadrants = new Set<string>();
    for (let elapsed = RULES.safeZoneStart; elapsed <= 200; elapsed += 0.5) {
      const zone = safeZoneAt("ruins", elapsed, 7);
      // Over the ring, never over the hole.
      expect(Math.max(Math.abs(zone.x), Math.abs(zone.z))).toBeGreaterThanOrEqual(3.5);
      expect(Math.hypot(zone.x, zone.z)).toBeCloseTo(5, 6);
      quadrants.add(`${Math.sign(Math.round(zone.x))},${Math.sign(Math.round(zone.z))}`);
    }
    expect(quadrants.size).toBe(8);
    const visited = new Set<string>();
    for (let elapsed = RULES.safeZoneStart; elapsed <= 320; elapsed += 0.5) {
      const zone = safeZoneAt("bridges", elapsed, 9);
      // Always on the cross of bridges, plaza and islands' middles.
      expect(Math.min(Math.abs(zone.x), Math.abs(zone.z))).toBe(0);
      if (Math.hypot(zone.x, zone.z) > 5.2)
        visited.add(`${Math.sign(zone.x)},${Math.sign(zone.z)}`);
    }
    expect(visited.size).toBe(4);
  });

  test.each(STAGE_IDS)("%s: through a whole match there is always floor inside the zone", (id) => {
    for (const mode of ["duel", "rumble"] as MatchMode[]) {
      const engine = match(id, mode);
      for (const f of engine.state.fighters)
        Object.assign(f, { hitstop: 1000, invulnerable: 1000 });
      const steps = collapseSteps(id);
      const sizes = new Set<number>();
      for (let t = 0.5; t <= matchTimeLimit(3); t += 0.5) {
        engine.state.elapsed = t;
        engine.update(DT, emptyInput());
        const { arena } = engine.state;
        sizes.add(arena.halfSize);
        expect(steps).toContain(arena.halfSize);
        expect(arena.halfSize).toBeGreaterThanOrEqual(STAGES[id].minHalfSize);
        // Bombs only ever land on floor.
        for (const bomb of engine.state.bombs)
          if (bomb.timer > bomb.duration - 2 * DT)
            expect(canStandAt(engine.state, bomb.x, bomb.z), `${id} bomb at ${t}`).toBe(true);
        if (!arena.safeZone.active) continue;
        const zone = arena.safeZone;
        expect(canStandAt(engine.state, zone.x, zone.z), `${id} ${mode} at ${t}`).toBe(true);
        // At least 8 square units of floor inside the circle (points are 0.5 apart).
        const floor = walkablePoints(id, arena.halfSize, 0.5).filter(
          (p) => Math.hypot(p.x - zone.x, p.z - zone.z) <= zone.radius,
        );
        expect(floor.length, `${id} ${mode} at ${t}`).toBeGreaterThanOrEqual(32);
        // And somewhere to come back to inside it.
        const back = respawnCandidates(id, arena.halfSize, zone);
        expect(back.length).toBeGreaterThan(0);
        for (const p of back) expect(canStandAt(engine.state, p.x, p.z)).toBe(true);
      }
      // Every announced step of the collapse happened, and none beyond.
      expect([...sizes]).toEqual(steps);
    }
  });
});

describe("CPUs find their way round pits, over bridges and across belts", () => {
  /** Walks a point along routeDirection; fails the test the moment it leaves the floor. */
  function follow(stage: StageId, halfSize: number, from: Vec2, goal: Vec2): number {
    const p = { ...from };
    let walked = 0;
    for (let step = 0; step < 900 && Math.hypot(goal.x - p.x, goal.z - p.z) > 0.5; step++) {
      const d = routeDirection(stage, halfSize, p, goal);
      expect(Math.hypot(d.x, d.z), `${stage} stuck at (${p.x}, ${p.z})`).toBeCloseTo(1, 6);
      p.x += d.x * 0.08;
      p.z += d.z * 0.08;
      walked += 0.08;
      expect(
        canStandAtStage(stage, p.x, p.z, halfSize),
        `${stage} off floor at (${p.x}, ${p.z})`,
      ).toBe(true);
    }
    expect(Math.hypot(goal.x - p.x, goal.z - p.z)).toBeLessThanOrEqual(0.5);
    return walked;
  }

  test("the way across the ruins goes round the pit, never through it", () => {
    for (const halfSize of [9, 7]) {
      // Straight ahead is the hole.
      expect(clearWalk("ruins", halfSize, { x: -6, z: 0 }, { x: 6, z: 0 })).toBe(false);
      const first = routeDirection("ruins", halfSize, { x: -6, z: 0 }, { x: 6, z: 0 });
      expect(Math.abs(first.z)).toBeGreaterThan(0.3);
      const walked = follow("ruins", halfSize, { x: -6, z: 0 }, { x: 6, z: 0 });
      expect(walked).toBeGreaterThan(14);
      expect(walked).toBeLessThan(22);
      follow("ruins", halfSize, { x: 5, z: 5 }, { x: -5, z: -5 });
      follow("ruins", halfSize, { x: 0, z: -4 }, { x: 0, z: 4 });
    }
    // With nothing in the way it is the straight line.
    expect(routeDirection("ruins", 9, { x: -6, z: -6 }, { x: 6, z: -6 })).toEqual({ x: 1, z: 0 });
    // A goal over the pit: walk to the rim nearest to it and stop there.
    follow("ruins", 9, { x: -6, z: 6 }, { x: 3.5, z: 0 });
    const waiting = routeDirection("ruins", 9, { x: 4, z: 0 }, { x: 0.5, z: 0 });
    expect(waiting).toEqual({ x: 0, z: 0 });
  });

  test("the way between islands goes over the bridges and through the plaza", () => {
    expect(clearWalk("bridges", 9, { x: 7, z: 0 }, { x: -7, z: 0 })).toBe(true);
    expect(clearWalk("bridges", 9, { x: 7, z: 1 }, { x: -7, z: 1 })).toBe(false);
    expect(clearWalk("bridges", 9, { x: 7, z: 0 }, { x: 0, z: -7 })).toBe(false);
    follow("bridges", 9, { x: 7, z: 2 }, { x: -2, z: -7 });
    follow("bridges", 9, { x: -8, z: -2.5 }, { x: 8, z: 2.5 });
    follow("bridges", 9, { x: 0, z: 8 }, { x: 0, z: -8 });
    // On a solid stage the way is always the straight line.
    for (const id of ["garden", "factory"] as StageId[])
      expect(routeDirection(id, 9, { x: -3, z: 4 }, { x: 5, z: 4 })).toEqual({ x: 1, z: 0 });
  });

  test.each(LEVELS)("%s walks round the pit to a rival on the far side", (level) => {
    const engine = match("ruins", "duel", level);
    const [human, cpu] = engine.state.fighters;
    Object.assign(human, { invulnerable: 1000 });
    expect([cpu.x, human.x]).toEqual([6, -6]);
    let reached = false;
    for (let tick = 0; tick < 12 / DT && !reached; tick++) {
      engine.update(DT, emptyInput());
      Object.assign(human, { invulnerable: 1000 });
      expect(cpu.mode, `${level} fell at (${cpu.x}, ${cpu.z})`).not.toBe("dead");
      expect(cpu.y).toBeGreaterThanOrEqual(-0.2);
      // Never in the air over the hole on the way.
      if (cpu.y <= 0.01) expect(Math.max(Math.abs(cpu.x), Math.abs(cpu.z))).toBeGreaterThan(2.9);
      reached = Math.hypot(cpu.x - human.x, cpu.z - human.z) < 3;
    }
    expect(reached).toBe(true);
    expect(engine.state.elapsed).toBeLessThan(8);
  });

  test.each(LEVELS)("%s crosses two bridges to a rival on another island", (level) => {
    const engine = match("bridges", "duel", level);
    const [human, cpu] = engine.state.fighters;
    // The rival waits on the north island; the CPU starts on the east one.
    Object.assign(human, { x: 0, z: -7, invulnerable: 1000 });
    expect([cpu.x, cpu.z]).toEqual([7, expect.closeTo(0, 9)]);
    let reached = false;
    let onBridge = false;
    for (let tick = 0; tick < 12 / DT && !reached; tick++) {
      engine.update(DT, emptyInput());
      Object.assign(human, { x: 0, z: -7, invulnerable: 1000 });
      expect(cpu.mode, `${level} fell at (${cpu.x}, ${cpu.z})`).not.toBe("dead");
      expect(cpu.y).toBeGreaterThanOrEqual(-0.2);
      if (cpu.grounded) expect(canStandAt(engine.state, cpu.x, cpu.z)).toBe(true);
      onBridge ||= tileAt("bridges", cpu.x, cpu.z, 9)?.kind === "bridge";
      reached = Math.hypot(cpu.x - human.x, cpu.z - human.z) < 3;
    }
    expect(onBridge).toBe(true);
    expect(reached).toBe(true);
    expect(engine.state.elapsed).toBeLessThan(9);
  });

  test.each(LEVELS)(
    "%s recovers to the nearest floor, not toward the middle of the pit",
    (level) => {
      for (const [stage, from, home] of [
        // Just inside the pit's east edge: the rim is at +X, the centre (a pit) at -X.
        ["ruins", { x: 2.3, z: 0.4 }, { x: 1, z: 0 }],
        // Outside the ring's west edge.
        ["ruins", { x: -9.8, z: 2 }, { x: 1, z: 0 }],
        // In the gap between two islands: the south island is nearer than the plaza.
        ["bridges", { x: 1.5, z: 4.6 }, { x: 0, z: 1 }],
        // Beside a bridge.
        ["bridges", { x: 3.5, z: -1.5 }, { x: 0, z: 1 }],
        // Off the factory's near edge.
        ["factory", { x: 3, z: 9.9 }, { x: 0, z: -1 }],
      ] as [StageId, Vec2, Vec2][]) {
        const engine = match(stage, "duel", level);
        const [human, cpu] = engine.state.fighters;
        Object.assign(human, { hitstop: 1000, invulnerable: 1000 });
        Object.assign(cpu, { ...from, y: 2.4, vy: 0, grounded: false });
        expect(canStandAt(engine.state, cpu.x, cpu.z)).toBe(false);
        const input = think(engine, cpu);
        const label = `${level} on ${stage} from (${from.x}, ${from.z})`;
        expect(input.move.x * home.x + input.move.z * home.z, label).toBeGreaterThan(0.85);
        // The old rule, straight at (0, 0), would have been wrong at least once here.
        advance(engine, 2);
        expect(cpu.mode, label).not.toBe("dead");
        expect(cpu.grounded, label).toBe(true);
        expect(canStandAt(engine.state, cpu.x, cpu.z), label).toBe(true);
      }
    },
  );

  test.each(LEVELS)(
    "%s keeps its line across a belt and steps off one when left alone",
    (level) => {
      const engine = match("factory", "duel", level);
      const [human, cpu] = engine.state.fighters;
      // The CPU on the far lane (running +X), its rival straight ahead across the stage.
      Object.assign(human, { x: 0, z: 0, hitstop: 1000, invulnerable: 1000 });
      Object.assign(cpu, { x: 0, z: -8.4 });
      const input = think(engine, cpu);
      // It leans into the belt: without that it would drift 2.2 a second to +X.
      expect(input.move.x).toBeLessThan(-0.3);
      expect(input.move.z).toBeGreaterThan(0.7);
      advance(engine, 0.25);
      expect(Math.abs(cpu.x)).toBeLessThan(0.12);
      expect(cpu.z).toBeGreaterThan(-8.4 + 0.25 * 3.5);
      // Nobody to fight (the rival is down): it does not ride the near lane off the stage.
      const alone = match("factory", "duel", level);
      const [down, rider] = alone.state.fighters;
      Object.assign(down, { mode: "dead", respawnTimer: 100, x: 40, y: -20 });
      Object.assign(rider, { x: -4, z: 8 });
      for (let tick = 0; tick < 4 / DT; tick++) {
        alone.update(DT, emptyInput());
        expect(rider.mode).not.toBe("dead");
        expect(rider.grounded).toBe(true);
      }
      expect(conveyorVelocityAt("factory", rider.x, rider.z, alone.state.arena.halfSize)).toEqual({
        x: 0,
        z: 0,
      });
    },
  );

  test.each(LEVELS)("%s leaves a ring that is about to collapse", (level) => {
    const engine = match("ruins", "duel", level);
    const [human, cpu] = engine.state.fighters;
    // Both on the outer ring (and inside the safe zone, which is over that side just then) as
    // the warning starts; the rival stays there to the end.
    Object.assign(human, { x: 8.2, z: 3, invulnerable: 1000 });
    Object.assign(cpu, { x: 8, z: -1.5 });
    engine.state.elapsed = RULES.collapseStart - RULES.collapseWarning + 0.1;
    const hold = () =>
      Object.assign(human, { x: 8.2, z: 3, y: 0, grounded: true, invulnerable: 1000 });
    while (engine.state.elapsed < RULES.collapseStart - 0.2) {
      engine.update(DT, emptyInput());
      hold();
    }
    // Off the doomed ring with time to spare, however tempting the rival still on it.
    expect(engine.state.arena.warningRing).toBe(true);
    expect(engine.state.arena.halfSize).toBe(9);
    expect(Math.max(Math.abs(cpu.x), Math.abs(cpu.z)), level).toBeLessThanOrEqual(7);
    for (let tick = 0; tick < 1.5 / DT; tick++) {
      engine.update(DT, emptyInput());
      hold();
      // The floor under it never went: no fall to recover from.
      expect(cpu.y, `${level} dropped at (${cpu.x}, ${cpu.z})`).toBeGreaterThanOrEqual(-0.01);
      expect(cpu.mode).not.toBe("dead");
    }
    expect(engine.state.arena.halfSize).toBe(7);
    expect(Math.max(Math.abs(cpu.x), Math.abs(cpu.z))).toBeLessThanOrEqual(7);
  });

  test.each(NEW_STAGES)("%s: no CPU of any strength walks or lunges off on its own", (id) => {
    // The player stands still and never attacks, so a CPU that falls with no damage on it fell
    // by its own doing: a path into a pit, a lunge off a bridge, a ride off a belt's end.
    for (const level of LEVELS) {
      for (const [mode, seed] of [
        ["duel", 11],
        ["duel", 29],
        ["rumble", 5],
      ] as [MatchMode, number][]) {
        const engine = match(id, mode, level, seed * 7919);
        const down = new Set<number>();
        for (let tick = 0; tick < 24 / DT && engine.state.phase !== "ended"; tick++) {
          engine.update(DT, emptyInput());
          for (const f of engine.state.fighters) {
            if (f.mode !== "dead") down.delete(f.id);
            else if (!down.has(f.id)) {
              down.add(f.id);
              if (!f.human)
                expect(
                  f.lastAttacker !== null || f.damage >= 1,
                  `${id} ${mode} ${level} seed ${seed}: ${f.name} fell unhit at (${f.x.toFixed(1)}, ${f.z.toFixed(1)}) t=${engine.state.elapsed.toFixed(1)}`,
                ).toBe(true);
            }
          }
        }
      }
    }
  });
});
