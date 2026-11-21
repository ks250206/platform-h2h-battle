import { Container3D, Mesh3D } from "@pixi/3d";
import { describe, expect, test } from "vite-plus/test";
import {
  ACCESSORIES,
  ACCESSORY_IDS,
  CHARACTERS,
  DEFAULT_LOADOUTS,
  PALETTE_IDS,
  PALETTES,
  SPECIES_IDS,
  defaultLoadout,
  sanitizeLoadout,
  sanitizeLoadouts,
  shade,
  withLoadout,
  type Loadout,
} from "../src/game/characters";
import { CAMERA_RIGHT } from "../src/game/coordinates";
import { BattleEngine } from "../src/game/engine";
import {
  SLOT_SHAPE_POINTS,
  SLOT_SHAPES,
  fighterTag,
  fighterTitle,
  sharesName,
  slotShape,
} from "../src/game/identity";
import {
  DEFAULT_MATCH_OPTIONS,
  loadoutFor,
  sanitizeMatchOptions,
  type ControlDevice,
  type MatchOptions,
} from "../src/game/match";
import {
  createMatchStore,
  loadMatchOptions,
  MATCH_STORAGE_KEY,
  playableOptions,
  type MatchStorage,
} from "../src/game/matchStore";
import { RULES } from "../src/game/tuning";
import {
  emptyInput,
  type AttackId,
  type Fighter,
  type GameState,
  type MatchMode,
  type PlayerInput,
  type PlayerInputs,
} from "../src/game/types";
import { ACCESSORY_MESH_LIMIT, ACCESSORY_REACH } from "../src/render/accessories";
import { MeshLibrary } from "../src/render/meshes";
import { createFighterRig, rigIdentity, RigAssets } from "../src/render/rig";

const DT = 1 / 60;
const MODES: MatchMode[] = ["duel", "rumble", "training"];
const slotsOf = (mode: MatchMode) => (mode === "rumble" ? 4 : 2);
type Controls = Partial<Record<number, ControlDevice>>;

const look = (
  species: Loadout["species"],
  palette: Loadout["palette"],
  accessory: Loadout["accessory"] = "none",
): Loadout => ({ species, palette, accessory });
const defaults = (): Loadout[] => DEFAULT_LOADOUTS.map((loadout) => ({ ...loadout }));
/** Every slot in the same animal, the same colours and the same accessory. */
const clones = (loadout: Loadout): Loadout[] => Array.from({ length: 4 }, () => ({ ...loadout }));

function memoryStorage(initial?: string): MatchStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(MATCH_STORAGE_KEY, initial);
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

function started(mode: MatchMode, options: Partial<MatchOptions>, seed = 4242) {
  const engine = new BattleEngine(seed);
  engine.start(mode, options);
  engine.state.phase = "playing";
  return engine;
}

/** Knocks `f` far below the floor; the next tick eliminates it. */
function drop(engine: BattleEngine, f: Fighter) {
  Object.assign(f, { y: -20, vy: 0, grounded: false, hitstop: 0 });
  engine.update(DT, {});
}

describe("the catalogue", () => {
  test("offers the four animals of the original cast", () => {
    expect([...SPECIES_IDS]).toEqual(["fox", "rabbit", "bear", "raccoon"]);
    expect(SPECIES_IDS.map((id) => CHARACTERS[id].name)).toEqual([
      "コハク",
      "シロ",
      "モカ",
      "スミ",
    ]);
    for (const id of SPECIES_IDS) {
      expect(CHARACTERS[id].species).toBe(id);
      expect(CHARACTERS[id].animal.length).toBeGreaterThan(0);
    }
  });

  test("has at least five colour palettes, each its own colour with a name", () => {
    expect(PALETTE_IDS.length).toBeGreaterThanOrEqual(5);
    const colors = PALETTE_IDS.map((id) => PALETTES[id].color);
    expect(new Set(colors).size).toBe(PALETTE_IDS.length);
    expect(new Set(PALETTE_IDS.map((id) => PALETTES[id].label)).size).toBe(PALETTE_IDS.length);
    for (const id of PALETTE_IDS) {
      const palette = PALETTES[id];
      expect(palette.id).toBe(id);
      expect(
        Number.isInteger(palette.color) && palette.color >= 0 && palette.color <= 0xffffff,
      ).toBe(true);
      // A fox's coat is its team colour a shade deeper, so the scarf still reads against it.
      expect(palette.foxFur).toBe(shade(palette.color, 0.88));
      expect(palette.foxFur).not.toBe(palette.color);
    }
  });

  test("has 'none' and at least four accessories", () => {
    expect(ACCESSORY_IDS[0]).toBe("none");
    expect(ACCESSORIES.none.label).toBe("なし");
    expect(ACCESSORY_IDS.filter((id) => id !== "none").length).toBeGreaterThanOrEqual(4);
    expect(new Set(ACCESSORY_IDS.map((id) => ACCESSORIES[id].label)).size).toBe(
      ACCESSORY_IDS.length,
    );
  });

  test("defaults to the original cast: コハク, シロ, モカ and スミ in their own colours", () => {
    expect(defaults()).toEqual([
      look("fox", "coral"),
      look("rabbit", "sky"),
      look("bear", "lavender"),
      look("raccoon", "marigold"),
    ]);
    expect(DEFAULT_LOADOUTS.map((loadout) => PALETTES[loadout.palette].color)).toEqual([
      0xff7a45, 0x3fb4ff, 0xb57bff, 0xffc93c,
    ]);
    expect(DEFAULT_MATCH_OPTIONS.loadouts).toEqual(defaults());
    const engine = new BattleEngine();
    engine.start("rumble");
    expect(engine.state.fighters.map((f) => [f.name, f.species, f.color, f.accessory])).toEqual([
      ["コハク", "fox", 0xff7a45, "none"],
      ["シロ", "rabbit", 0x3fb4ff, "none"],
      ["モカ", "bear", 0xb57bff, "none"],
      ["スミ", "raccoon", 0xffc93c, "none"],
    ]);
  });
});

describe("any animal on any slot", () => {
  test.each(MODES)("%s: every slot, human or CPU, can be each of the four animals", (mode) => {
    const count = slotsOf(mode);
    // Slot 0 is always a human; the last slot is a CPU and the middle ones are mixed.
    const controls: Controls = count === 4 ? { 0: "keyboard", 2: "pad1" } : { 0: "keyboard" };
    for (let slot = 0; slot < count; slot++)
      for (const species of SPECIES_IDS)
        for (const palette of PALETTE_IDS) {
          const loadouts = withLoadout(defaults(), slot, { species, palette, accessory: "crown" });
          const engine = started(mode, { controls, loadouts });
          const fighter = engine.state.fighters[slot]!;
          expect(engine.state.fighters).toHaveLength(count);
          expect(fighter.species).toBe(species);
          expect(fighter.name).toBe(CHARACTERS[species].name);
          expect(fighter.palette).toBe(palette);
          expect(fighter.color).toBe(PALETTES[palette].color);
          expect(fighter.accessory).toBe("crown");
          // Who plays the slot does not depend on what it looks like.
          expect(fighter.human).toBe(controls[slot] !== undefined);
          // The other slots keep their own looks.
          for (const other of engine.state.fighters)
            if (other.id !== slot) expect(other.species).toBe(DEFAULT_LOADOUTS[other.id]!.species);
        }
  });

  test("P1 can be シロ or モカ while a CPU takes コハク", () => {
    const engine = started("duel", {
      controls: { 0: "keyboard" },
      loadouts: [look("bear", "berry", "beret"), look("fox", "mint"), ...defaults().slice(2)],
    });
    const [player, cpu] = engine.state.fighters;
    expect([player!.name, player!.human, player!.player]).toEqual(["モカ", true, 1]);
    expect([cpu!.name, cpu!.human, cpu!.player]).toEqual(["コハク", false, null]);
  });

  test.each(MODES)("%s: everyone may pick the very same animal, colours and accessory", (mode) => {
    const same = look("bear", "mint", "goggles");
    const options = sanitizeMatchOptions({
      controls: { 0: "keyboard", 1: "pad1" },
      loadouts: clones(same),
    });
    // Nothing is changed to make the slots differ.
    expect(options.loadouts).toEqual(clones(same));
    const engine = new BattleEngine(7);
    engine.start(mode, options);
    expect(engine.state.phase).toBe("countdown");
    for (let frame = 0; frame < 600 && engine.state.phase === "countdown"; frame++)
      engine.update(DT, {});
    // The match starts and runs.
    expect(engine.state.phase).toBe("playing");
    for (let frame = 0; frame < 120; frame++) engine.update(DT, {});
    expect(engine.state.phase).toBe("playing");
    expect(engine.state.fighters).toHaveLength(slotsOf(mode));
    for (const f of engine.state.fighters)
      expect([f.species, f.palette, f.accessory, f.name]).toEqual([
        "bear",
        "mint",
        "goggles",
        "モカ",
      ]);
    expect(engine.state.options.loadouts).toEqual(clones(same));
  });

  test("the store never touches another slot when one picks what it already has", () => {
    const store = createMatchStore(memoryStorage());
    const same = look("raccoon", "berry", "flower");
    for (let slot = 0; slot < 4; slot++) {
      store.setLoadout(slot, same);
      expect(store.get().loadouts.slice(0, slot + 1)).toEqual(clones(same).slice(0, slot + 1));
      expect(store.get().loadouts.slice(slot + 1)).toEqual(defaults().slice(slot + 1));
    }
    expect(store.get().loadouts).toEqual(clones(same));
  });
});

describe("saved looks", () => {
  test("options saved before looks existed get the original cast", () => {
    const legacy = JSON.stringify({
      controls: { 0: "pad1", 1: "keyboard" },
      stocks: 5,
      difficulty: "hard",
      overrides: { 1: "easy" },
    });
    expect(loadMatchOptions(memoryStorage(legacy))).toEqual({
      ...DEFAULT_MATCH_OPTIONS,
      controls: { 0: "pad1", 1: "keyboard" },
      stocks: 5,
      difficulty: "hard",
      overrides: { 1: "easy" },
      loadouts: defaults(),
    });
  });

  test.each([
    ["missing", undefined],
    ["null", null],
    ["a string", "fox"],
    ["a number", 3],
    ["an empty array", []],
    ["an empty object", {}],
    ["junk entries", [null, 7, "bear", []]],
  ])("%s falls back to the defaults", (_label, raw) => {
    expect(sanitizeLoadouts(raw)).toEqual(defaults());
    expect(sanitizeMatchOptions({ loadouts: raw }).loadouts).toEqual(defaults());
  });

  test("each bad field is replaced by its slot's default and the good ones are kept", () => {
    expect(
      sanitizeLoadouts([
        { species: "dragon", palette: "mint", accessory: "crown" },
        { species: "fox", palette: "neon", accessory: "beret" },
        { species: "rabbit", palette: "berry", accessory: "jetpack" },
        { species: 4, palette: null },
      ]),
    ).toEqual([
      look("fox", "mint", "crown"),
      look("fox", "sky", "beret"),
      look("rabbit", "berry", "none"),
      look("raccoon", "marigold", "none"),
    ]);
  });

  test("always four slots: short lists are filled, long ones cut, objects keyed by slot read", () => {
    expect(sanitizeLoadouts([look("bear", "mint")])).toEqual([
      look("bear", "mint"),
      ...defaults().slice(1),
    ]);
    const long = [...clones(look("bear", "mint")), look("fox", "berry"), look("fox", "berry")];
    expect(sanitizeLoadouts(long)).toEqual(clones(look("bear", "mint")));
    expect(sanitizeLoadouts({ 2: look("fox", "berry", "flower"), 9: look("fox", "sky") })).toEqual([
      look("fox", "coral"),
      look("rabbit", "sky"),
      look("fox", "berry", "flower"),
      look("raccoon", "marigold"),
    ]);
    expect(sanitizeLoadout({ species: "bear" }, 1)).toEqual(look("bear", "sky"));
    expect(defaultLoadout(5)).toEqual(look("rabbit", "sky"));
    expect(loadoutFor({ loadouts: [] }, 2)).toEqual(look("bear", "lavender"));
  });

  test("corrupt stored JSON starts from the defaults", () => {
    for (const stored of ["{not json", "null", '"hard"', '{"loadouts":"x"}', '{"loadouts":[1,2]}'])
      expect(loadMatchOptions(memoryStorage(stored)).loadouts).toEqual(defaults());
  });

  test("looks survive a reload, a rematch and a trip back to the title", () => {
    const storage = memoryStorage();
    const store = createMatchStore(storage);
    store.setLoadout(0, { species: "bear", palette: "mint" });
    store.setLoadout(3, { accessory: "goggles" });
    const chosen = [
      look("bear", "mint"),
      look("rabbit", "sky"),
      look("bear", "lavender"),
      look("raccoon", "marigold", "goggles"),
    ];
    expect(JSON.parse(storage.data.get(MATCH_STORAGE_KEY)!).loadouts).toEqual(chosen);
    // A new page load reads the same looks back.
    expect(createMatchStore(storage).get().loadouts).toEqual(chosen);
    // The engine keeps them for a rematch (a start without options) and for the title screen.
    const engine = new BattleEngine(1);
    engine.start("rumble", store.get());
    const looks = () => engine.state.fighters.map((f) => look(f.species, f.palette, f.accessory));
    expect(looks()).toEqual(chosen);
    engine.start("rumble");
    expect(looks()).toEqual(chosen);
    engine.menu("rumble");
    expect(engine.state.phase).toBe("menu");
    expect(looks()).toEqual(chosen);
    engine.start("duel");
    expect(looks()).toEqual(chosen.slice(0, 2));
  });

  test("get returns copies of the looks", () => {
    const store = createMatchStore(memoryStorage());
    const options = store.get();
    options.loadouts[0]!.species = "bear";
    options.loadouts.pop();
    expect(store.get().loadouts).toEqual(defaults());
    expect(DEFAULT_MATCH_OPTIONS.loadouts).toEqual(defaults());
  });

  test("a cancelled choice is put back by restoring the looks from before", () => {
    const store = createMatchStore(memoryStorage());
    store.setLoadout(1, { species: "fox", accessory: "crown" });
    const before = store.get().loadouts;
    store.setLoadout(1, { palette: "berry" });
    store.setLoadout(2, { species: "rabbit", accessory: "beret" });
    expect(store.get().loadouts).not.toEqual(before);
    store.set({ loadouts: before });
    expect(store.get().loadouts).toEqual(before);
  });
});

describe("looks are independent of who plays and how strong the CPUs are", () => {
  const settled = {
    controls: { 0: "pad2", 1: "keyboard", 3: "pad1" } as Controls,
    stocks: 4,
    difficulty: "hard" as const,
    overrides: { 2: "easy" as const },
    time: DEFAULT_MATCH_OPTIONS.time,
    gimmicks: DEFAULT_MATCH_OPTIONS.gimmicks,
    stage: DEFAULT_MATCH_OPTIONS.stage,
    setFormat: "single" as const,
  };

  test("changing a look changes nothing else", () => {
    const storage = memoryStorage();
    const store = createMatchStore(storage);
    store.set(settled);
    for (let slot = 0; slot < 4; slot++)
      for (const species of SPECIES_IDS)
        for (const accessory of ACCESSORY_IDS) {
          store.setLoadout(slot, { species, palette: "berry", accessory });
          const { loadouts, ...rest } = store.get();
          expect(rest).toEqual(settled);
          expect(loadouts[slot]).toEqual(look(species, "berry", accessory));
        }
    const { loadouts: _saved, ...saved } = JSON.parse(storage.data.get(MATCH_STORAGE_KEY)!);
    expect(saved).toEqual(settled);
  });

  test("a look that is already chosen, or a slot that does not exist, changes nothing at all", () => {
    const store = createMatchStore(memoryStorage());
    let changes = 0;
    store.subscribe(() => changes++);
    store.setLoadout(0, { species: "fox" });
    store.setLoadout(7, { species: "bear" });
    store.setLoadout(-1, { species: "bear" });
    expect(changes).toBe(0);
    expect(store.get()).toEqual(DEFAULT_MATCH_OPTIONS);
  });

  test("joining, leaving and reassigning devices never move or reset a look", () => {
    const store = createMatchStore(memoryStorage());
    const chosen = [
      look("bear", "mint", "crown"),
      look("bear", "mint", "crown"),
      look("fox", "berry", "flower"),
      look("rabbit", "coral", "goggles"),
    ];
    store.set({ loadouts: chosen });
    const steps: (() => unknown)[] = [
      () => store.join(0, 2),
      () => store.join(1, 4),
      () => store.join(2, 4),
      () => store.assign(0, "pad2", 4),
      () => store.assign(1, "keyboard", 4),
      () => store.assign(3, null, 4),
      () => store.leave(1, 4),
      () => store.leave(0, 4),
      () => store.assign(1, "pad3", 2),
      () => store.set({ difficulty: "easy", overrides: { 1: "hard", 3: "easy" }, stocks: 1 }),
    ];
    for (const step of steps) {
      step();
      expect(store.get().loadouts).toEqual(chosen);
    }
  });

  test("a pad that is away leaves its slot's look to the CPU that fills in", () => {
    const options = sanitizeMatchOptions({
      controls: { 0: "pad1", 1: "keyboard", 2: "pad2", 3: "pad3" },
      loadouts: [
        look("bear", "mint", "crown"),
        look("fox", "berry"),
        look("bear", "mint", "crown"),
        look("rabbit", "coral", "beret"),
      ],
    });
    const none = playableOptions(options, 4, () => false);
    expect(none.options.controls).toEqual({ 0: "keyboard" });
    expect(none.options.loadouts).toEqual(options.loadouts);
    // A copy: starting a match never edits the stored looks.
    none.options.loadouts[0]!.species = "raccoon";
    expect(options.loadouts[0]!.species).toBe("bear");
    // Back again: the pad plays the same fighter it left.
    const back = playableOptions(options, 4, () => true);
    expect(back.options.controls).toEqual(options.controls);
    expect(back.options.loadouts).toEqual(options.loadouts);
    const engine = started("rumble", none.options);
    expect(engine.state.fighters.map((f) => [f.species, f.human])).toEqual([
      ["raccoon", true],
      ["fox", false],
      ["bear", false],
      ["rabbit", false],
    ]);
  });

  test("player numbers and CPU strengths are the same whatever the fighters look like", () => {
    const who = (loadouts: Loadout[]) =>
      started("rumble", {
        controls: { 0: "keyboard", 2: "pad1" },
        difficulty: "easy",
        overrides: { 1: "hard" },
        loadouts,
      }).state.fighters.map((f) => [f.id, f.human, f.player, f.aiLevel, f.stocks]);
    const expected = who(defaults());
    expect(expected).toEqual([
      [0, true, 1, "easy", 3],
      [1, false, null, "hard", 3],
      [2, true, 2, "easy", 3],
      [3, false, null, "easy", 3],
    ]);
    expect(who(clones(look("rabbit", "berry", "flower")))).toEqual(expected);
    expect(who(defaults().reverse())).toEqual(expected);
  });
});

/**
 * A scripted fight for the humans: close in on the nearest opponent, circle it, and swing every
 * attack with short and long holds, jumping, dodging, grabbing and feinting on a fixed beat.
 */
function script(frame: number, state: GameState): PlayerInputs {
  const attacks: AttackId[] = ["overhead", "sweep", "thrust", "rising"];
  const inputs: PlayerInputs = {};
  state.fighters
    .filter((f) => f.human)
    .forEach((f, index) => {
      const t = frame + index * 37;
      const beat = t % 90;
      const attack = attacks[Math.floor(t / 90) % attacks.length]!;
      const hold = Math.floor(t / 90) % 3 === 0 ? 40 : 6;
      const target = state.fighters
        .filter((o) => o.id !== f.id && o.mode !== "dead")
        .sort((a, b) => Math.hypot(a.x - f.x, a.z - f.z) - Math.hypot(b.x - f.x, b.z - f.z))[0];
      const dx = (target?.x ?? 0) - f.x;
      const dz = (target?.z ?? 0) - f.z;
      const distance = Math.hypot(dx, dz) || 1;
      const toward = { x: dx / distance, z: dz / distance };
      inputs[f.id] = {
        ...emptyInput(),
        move: distance > 1.9 ? toward : { x: toward.z * 0.6, z: -toward.x * 0.6 },
        aim: toward,
        attackPressed: beat === 10 ? attack : null,
        attackHeld: beat >= 10 && beat < 10 + hold ? attack : null,
        jump: t % 140 === 60,
        step: t % 110 === 75,
        cancel: t % 270 === 30,
        grab: t % 200 === 95,
      } satisfies PlayerInput;
    });
  return inputs;
}

/** Everything the simulation computes, without what a fighter looks like or is called. */
function physical(state: GameState) {
  const names = new RegExp(SPECIES_IDS.map((id) => CHARACTERS[id].name).join("|"), "g");
  return {
    phase: state.phase,
    elapsed: state.elapsed,
    countdown: state.countdown,
    winnerId: state.winnerId,
    messageTime: state.messageTime,
    // The announcement, with the names and the tags that tell same-named fighters apart taken out.
    message: state.message.replace(/(?:YOU|P\d|CPU \d\d) /g, "").replace(names, "*"),
    arena: state.arena,
    bombs: state.bombs,
    stats: state.stats,
    fighters: state.fighters.map(
      ({ name: _n, species: _s, color: _c, palette: _p, accessory: _a, ...rest }) => rest,
    ),
    effects: state.effects.map(({ color: _c, ...rest }) => rest),
  };
}

/**
 * Plays `seconds` of a match and returns every frame's physical state, serialized, with the inputs
 * that were fed in. Given `replay`, it feeds exactly those inputs instead of running the script.
 */
function simulate(
  mode: MatchMode,
  controls: Controls,
  loadouts: Loadout[],
  seconds: number,
  replay?: PlayerInputs[],
) {
  const engine = new BattleEngine(20261121);
  engine.start(mode, { controls, loadouts, stocks: 2, difficulty: "hard" });
  const frames: string[] = [];
  const inputs: PlayerInputs[] = [];
  const total = Math.round(seconds / DT);
  for (let frame = 0; frame < total; frame++) {
    // The same nudge in every run: someone is knocked off, so respawns are part of what is compared.
    if (frame === 700 || frame === 1300) {
      const victim = engine.state.fighters[frame === 700 ? 1 : 0]!;
      if (victim.mode !== "dead") Object.assign(victim, { y: -20, vy: 0, grounded: false });
    }
    const input = replay ? replay[frame]! : script(frame, engine.state);
    inputs.push(input);
    engine.update(DT, input);
    frames.push(JSON.stringify(physical(engine.state)));
  }
  return { frames, inputs, state: engine.state };
}

describe("looks give no advantage", () => {
  const variants: [string, Loadout[]][] = [
    ["everyone the same bear", clones(look("bear", "mint", "crown"))],
    ["everyone the same rabbit", clones(look("rabbit", "berry", "goggles"))],
    [
      "the cast reversed, all dressed up",
      defaults()
        .reverse()
        .map((l) => ({ ...l, accessory: "beret" })),
    ],
    [
      "a mix",
      [
        look("raccoon", "sky", "flower"),
        look("fox", "lavender", "headband"),
        look("fox", "lavender", "headband"),
        look("bear", "coral"),
      ],
    ],
  ];
  const matches: [MatchMode, Controls, number][] = [
    ["duel", { 0: "keyboard" }, 30],
    ["rumble", { 0: "keyboard", 2: "pad1" }, 30],
    ["training", { 0: "keyboard", 1: "pad1" }, 26],
  ];

  test.each(matches)(
    "%s: the same inputs give the same fight, frame for frame, whatever anyone wears",
    (mode, controls, seconds) => {
      const baseline = simulate(mode, controls, defaults(), seconds);
      // The fight is a real one: blows land, and someone goes down and comes back.
      expect(baseline.state.stats.hits).toBeGreaterThan(0);
      expect(baseline.frames.some((frame) => frame.includes('"mode":"dead"'))).toBe(true);
      expect(baseline.frames.at(-1)).not.toBe(baseline.frames[0]);
      for (const [label, loadouts] of variants) {
        // Exactly the inputs of the first run, replayed.
        const run = simulate(mode, controls, loadouts, seconds, baseline.inputs);
        expect(run.frames.length, label).toBe(baseline.frames.length);
        const firstDifference = run.frames.findIndex((frame, i) => frame !== baseline.frames[i]);
        expect(firstDifference, `${label}: first differing frame`).toBe(-1);
        // The looks really were different.
        expect(run.state.fighters.map((f) => f.species)).not.toEqual(
          baseline.state.fighters.map((f) => f.species),
        );
      }
    },
  );

  test("every animal, colour and accessory starts a match in exactly the same state", () => {
    const body = (loadout: Loadout) => {
      const engine = new BattleEngine(5);
      engine.start("rumble", { loadouts: clones(loadout) });
      return JSON.stringify(physical(engine.state));
    };
    const reference = body(look("fox", "coral"));
    for (const species of SPECIES_IDS)
      for (const palette of PALETTE_IDS)
        for (const accessory of ACCESSORY_IDS)
          expect(
            body(look(species, palette, accessory)),
            `${species}/${palette}/${accessory}`,
          ).toBe(reference);
  });
});

describe("telling fighters apart without colour", () => {
  test("every slot has its own shape, whoever plays it and whatever it looks like", () => {
    expect(new Set(SLOT_SHAPES).size).toBe(4);
    expect([0, 1, 2, 3].map(slotShape)).toEqual([...SLOT_SHAPES]);
    for (const shape of SLOT_SHAPES) {
      const outline = SLOT_SHAPE_POINTS[shape];
      expect(outline.length).toBeGreaterThanOrEqual(3);
      for (const [x, y] of outline) expect(Math.hypot(x, y)).toBeLessThanOrEqual(1.2);
    }
    // Outlines differ in their number of corners: triangle, circle, square, star.
    expect(new Set(SLOT_SHAPES.map((shape) => SLOT_SHAPE_POINTS[shape].length)).size).toBe(4);
  });

  test("tags: YOU alone, P1-P4 for several players, CPU and its slot for the others", () => {
    const tags = (controls: Controls) => {
      const { fighters } = started("rumble", {
        controls,
        loadouts: clones(look("bear", "mint")),
      }).state;
      const humans = fighters.filter((f) => f.human).length;
      return fighters.map((f) => fighterTag(f, humans));
    };
    expect(tags({ 0: "keyboard" })).toEqual(["YOU", "CPU 01", "CPU 02", "CPU 03"]);
    expect(tags({ 0: "keyboard", 2: "pad1" })).toEqual(["P1", "CPU 01", "P2", "CPU 03"]);
    expect(tags({ 0: "pad2", 1: "keyboard", 2: "pad1", 3: "pad3" })).toEqual([
      "P1",
      "P2",
      "P3",
      "P4",
    ]);
    // Every tag of a match is unique, even though every fighter looks the same.
    for (const controls of [{ 0: "keyboard" }, { 0: "keyboard", 1: "pad1" }] as Controls[])
      expect(new Set(tags(controls)).size).toBe(4);
  });

  test("a name is announced alone while unique and with its tag once it is shared", () => {
    const { fighters } = started("rumble", {
      controls: { 0: "keyboard", 1: "pad1" },
      loadouts: [
        look("bear", "mint"),
        look("bear", "mint"),
        look("bear", "sky"),
        look("fox", "sky"),
      ],
    }).state;
    expect(fighters.map((f) => sharesName(f, fighters))).toEqual([true, true, true, false]);
    expect(fighters.map((f) => fighterTitle(f, fighters))).toEqual([
      "P1 モカ",
      "P2 モカ",
      "CPU 02 モカ",
      "コハク",
    ]);
    const cast = started("rumble", { controls: { 0: "keyboard" } }).state.fighters;
    expect(cast.map((f) => fighterTitle(f, cast))).toEqual(["コハク", "シロ", "モカ", "スミ"]);
  });

  test("knock-outs and the win say which of two モカ it was", () => {
    const engine = started("duel", {
      controls: { 0: "keyboard" },
      stocks: 2,
      loadouts: [
        look("bear", "mint", "crown"),
        look("bear", "mint", "crown"),
        ...defaults().slice(2),
      ],
    });
    const [player, cpu] = engine.state.fighters;
    cpu!.hitstop = 1e6;
    drop(engine, cpu!);
    expect(engine.state.message).toBe("CPU 01 モカ DOWN — 残り1");
    drop(engine, player!);
    expect(engine.state.message).toBe("YOU モカ DOWN — 残り1");
    for (let frame = 0; frame < Math.ceil(RULES.respawnDelay / DT) + 2; frame++)
      engine.update(DT, {});
    expect(cpu!.mode).not.toBe("dead");
    cpu!.hitstop = 1e6;
    drop(engine, cpu!);
    expect(engine.state.phase).toBe("ended");
    expect(engine.state.winnerId).toBe(0);
    expect(engine.state.message).toBe("YOU モカ WINS");
  });

  test("a fighter comes back from a knock-out as the same slot, tag and look", () => {
    const engine = started("rumble", {
      controls: { 0: "keyboard", 2: "pad1" },
      stocks: 3,
      loadouts: clones(look("bear", "mint", "crown")),
    });
    for (const f of engine.state.fighters) f.hitstop = 1e6;
    const second = engine.state.fighters[2]!;
    const before = {
      tag: fighterTag(second, 2),
      rig: rigIdentity(second),
      shape: slotShape(second.id),
    };
    drop(engine, second);
    expect(second.mode).toBe("dead");
    for (let frame = 0; frame < Math.ceil(RULES.respawnDelay / DT) + 2; frame++)
      engine.update(DT, {});
    const back = engine.state.fighters[2]!;
    expect(back.mode).not.toBe("dead");
    expect([back.species, back.palette, back.accessory, back.name]).toEqual([
      "bear",
      "mint",
      "crown",
      "モカ",
    ]);
    expect({ tag: fighterTag(back, 2), rig: rigIdentity(back), shape: slotShape(back.id) }).toEqual(
      before,
    );
    // Training rebuilds a fallen fighter from scratch: the look comes back with it.
    const dojo = started("training", {
      controls: { 0: "keyboard" },
      loadouts: [
        look("rabbit", "berry", "beret"),
        look("fox", "mint", "goggles"),
        ...defaults().slice(2),
      ],
    });
    drop(dojo, dojo.state.fighters[1]!);
    for (let frame = 0; frame < 100; frame++) dojo.update(DT, {});
    const partner = dojo.state.fighters[1]!;
    expect(partner.mode).not.toBe("dead");
    expect([partner.species, partner.palette, partner.accessory]).toEqual([
      "fox",
      "mint",
      "goggles",
    ]);
  });
});

describe("the title line-up", () => {
  test.each(MODES)("%s shows the mode's fighters in their looks, left to right", (mode) => {
    const loadouts = [
      look("bear", "mint", "crown"),
      look("bear", "mint", "crown"),
      look("fox", "berry", "flower"),
      look("rabbit", "coral", "goggles"),
    ];
    const engine = new BattleEngine(3);
    engine.menu(mode, { controls: { 0: "keyboard", 1: "pad1" }, loadouts });
    const { fighters, phase } = engine.state;
    expect(phase).toBe("menu");
    expect(fighters.map((f) => look(f.species, f.palette, f.accessory))).toEqual(
      loadouts.slice(0, slotsOf(mode)),
    );
    expect(fighters.map((f) => f.player)).toEqual([1, 2, null, null].slice(0, slotsOf(mode)));
    // Slot order from left to right on screen, with room between neighbours.
    const across = fighters.map((f) => f.x * CAMERA_RIGHT.x + f.z * CAMERA_RIGHT.z);
    for (let i = 1; i < across.length; i++) expect(across[i]! - across[i - 1]!).toBeGreaterThan(2);
    for (const f of fighters) expect(Math.max(Math.abs(f.x), Math.abs(f.z))).toBeLessThan(8);
    // A preview only: nothing is simulated behind the menu.
    const before = JSON.stringify(engine.state);
    for (let frame = 0; frame < 30; frame++) engine.update(DT, script(frame, engine.state));
    expect(JSON.stringify(engine.state)).toBe(before);
  });

  test("a new look shows at once, and choosing it back restores the old one", () => {
    const engine = new BattleEngine(3);
    const store = createMatchStore(memoryStorage());
    const shown = () => {
      engine.menu("duel", store.get());
      return engine.state.fighters.map((f) => rigIdentity(f));
    };
    const original = shown();
    store.setLoadout(0, { accessory: "crown" });
    const dressed = shown();
    expect(dressed[0]).not.toBe(original[0]);
    expect(dressed[1]).toBe(original[1]);
    store.setLoadout(0, { accessory: "none" });
    expect(shown()).toEqual(original);
  });
});

describe("the rig", () => {
  const meshes = new MeshLibrary();
  const assets = new RigAssets();
  const fighterOf = (loadout: Loadout, slot = 0, controls: Controls = { 0: "keyboard" }) => {
    const engine = new BattleEngine(1);
    engine.start("rumble", { controls, loadouts: withLoadout(defaults(), slot, loadout) });
    return engine.state.fighters[slot]!;
  };
  const build = (loadout: Loadout, slot = 0, controls?: Controls) =>
    createFighterRig(meshes, assets, new Container3D(), fighterOf(loadout, slot, controls));
  const countMeshes = (node: Container3D): number =>
    (node instanceof Mesh3D ? 1 : 0) +
    node.children.reduce((sum, child) => sum + countMeshes(child as Container3D), 0);
  const isUnder = (node: Container3D | null, ancestor: Container3D): boolean => {
    for (let at = node; at; at = at.parent as Container3D | null) if (at === ancestor) return true;
    return false;
  };

  test("its identity follows the animal, the colours, the accessory and the slot", () => {
    const base = look("fox", "coral");
    expect(build(base).identity).toBe(rigIdentity(fighterOf(base)));
    expect(build(base).identity).toBe(build(base).identity);
    const others = [
      build(look("bear", "coral")).identity,
      build(look("fox", "mint")).identity,
      build(look("fox", "coral", "crown")).identity,
      build(base, 1).identity,
    ];
    for (const identity of others) expect(identity).not.toBe(build(base).identity);
    expect(new Set(others).size).toBe(others.length);
    // Every combination a slot can wear is a different rig.
    const all = SPECIES_IDS.flatMap((species) =>
      PALETTE_IDS.flatMap((palette) =>
        ACCESSORY_IDS.map((accessory) => rigIdentity(fighterOf(look(species, palette, accessory)))),
      ),
    );
    expect(new Set(all).size).toBe(SPECIES_IDS.length * PALETTE_IDS.length * ACCESSORY_IDS.length);
    // Who plays the slot is not part of the look.
    expect(rigIdentity(fighterOf(base, 1, { 0: "keyboard", 1: "pad1" }))).toBe(
      rigIdentity(fighterOf(base, 1)),
    );
  });

  test("builds every animal with every accessory, fitted close to the head", () => {
    for (const species of SPECIES_IDS) {
      const bare = build(look(species, "sky"));
      expect(bare.accessory).toBeNull();
      const bodyMeshes = countMeshes(bare.root);
      const shapes = new Set<string>();
      for (const accessory of ACCESSORY_IDS) {
        if (accessory === "none") continue;
        const label = `${species}/${accessory}`;
        const rig = build(look(species, "sky", accessory));
        expect(rig.accessory, label).not.toBeNull();
        // It hangs under the head, and nowhere near the arms or the sword.
        expect(isUnder(rig.accessory, rig.head), label).toBe(true);
        expect(countMeshes(rig.sword), label).toBe(countMeshes(bare.sword));
        for (const side of [0, 1] as const)
          for (const part of ["upper", "lower", "end"] as const)
            expect(countMeshes(rig.arms[side][part]), label).toBe(
              countMeshes(bare.arms[side][part]),
            );
        // A handful of meshes, and nothing else added to the body.
        const added = countMeshes(rig.accessory!);
        expect(added, label).toBeGreaterThanOrEqual(3);
        expect(added, label).toBeLessThanOrEqual(ACCESSORY_MESH_LIMIT);
        expect(countMeshes(rig.root), label).toBe(bodyMeshes + added);
        // Small and on the head: it never reaches past the ears and the muzzle.
        const bounds = rig.accessory!.getLocalBounds();
        for (const axis of ["x", "y", "z"] as const) {
          expect(bounds.min[axis], `${label} min ${axis}`).toBeGreaterThanOrEqual(-ACCESSORY_REACH);
          expect(bounds.max[axis], `${label} max ${axis}`).toBeLessThanOrEqual(ACCESSORY_REACH);
        }
        // Above the eyes and brows, which stay in view.
        expect(bounds.min.y, label).toBeGreaterThanOrEqual(0);
        shapes.add(
          [bounds.min.x, bounds.max.x, bounds.max.y, bounds.min.z, bounds.max.z, added]
            .map((value) => value.toFixed(2))
            .join("/"),
        );
      }
      // The five accessories are five different things.
      expect(shapes.size, species).toBe(ACCESSORY_IDS.length - 1);
    }
  });

  test("marks a human with the slot's shape overhead and everyone with it on the floor ring", () => {
    const controls: Controls = { 0: "keyboard", 2: "pad1" };
    for (let slot = 0; slot < 4; slot++) {
      const rig = build(look("bear", "mint", "crown"), slot, controls);
      expect(rig.pointer.visible, `slot ${slot}`).toBe(slot === 0 || slot === 2);
      // A dark rim and a fill, for the marker over the head and for the one on the ring.
      expect(countMeshes(rig.pointer)).toBe(2);
      expect(countMeshes(rig.badge)).toBe(2);
      const shape = assets.shapes[slotShape(slot)];
      const drawn = (node: Container3D): Mesh3D[] =>
        node instanceof Mesh3D ? [node] : node.children.flatMap((c) => drawn(c as Container3D));
      for (const mesh of [...drawn(rig.pointer), ...drawn(rig.badge)])
        expect(mesh.geometry, `slot ${slot}`).toBe(shape);
    }
    expect(new Set(SLOT_SHAPES.map((shape) => assets.shapes[shape])).size).toBe(4);
  });
});
