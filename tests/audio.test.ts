import { describe, expect, test } from "vite-plus/test";
import { swordCues, type SwordCue, type SwordFighter, type SwordMemory } from "../src/game/audio";
import type { AttackId, FighterMode } from "../src/game/types";

const ATTACK_IDS: AttackId[] = ["overhead", "rising", "sweep", "thrust"];

function memory(mode: FighterMode, attack: AttackId | null = null, swingId = 1): SwordMemory {
  return { mode, attack, swingId, lastHumAt: 0 };
}

function fighter(overrides: Partial<SwordFighter> = {}): SwordFighter {
  return {
    mode: "idle",
    attack: null,
    charge: 0,
    grounded: true,
    swingId: 1,
    human: true,
    ...overrides,
  };
}

const kinds = (cues: SwordCue[]) => cues.map((cue) => cue.kind);

describe("swordCues", () => {
  test.each(ATTACK_IDS)("whooshes when a %s enters active", (attack) => {
    const cues = swordCues(memory("windup", attack), fighter({ mode: "active", attack }), 1);
    expect(cues).toEqual([expect.objectContaining({ kind: "whoosh", attack })]);
  });

  test("slams only for a grounded overhead leaving active into recovery", () => {
    const leaving = (attack: AttackId, grounded: boolean, mode: FighterMode = "recovery") =>
      kinds(swordCues(memory("active", attack), fighter({ mode, attack, grounded }), 1));
    expect(leaving("overhead", true)).toEqual(["slam"]);
    expect(leaving("overhead", false)).toEqual([]);
    expect(leaving("overhead", true, "clash")).toEqual([]);
    for (const attack of ["rising", "sweep", "thrust"] as const)
      expect(leaving(attack, true)).toEqual([]);
  });

  test("still whooshes and slams when the active window fell between frames", () => {
    const cues = swordCues(
      memory("windup", "overhead"),
      fighter({ mode: "recovery", attack: "overhead" }),
      1,
    );
    expect(kinds(cues)).toEqual(["whoosh", "slam"]);
  });

  test("heaves when an attack is committed", () => {
    const cues = swordCues(
      memory("charge", "overhead", 1),
      fighter({ mode: "windup", attack: "overhead", swingId: 2 }),
      1,
    );
    expect(kinds(cues)).toEqual(["heave"]);
  });

  test("no cue while the mode is unchanged", () => {
    for (const mode of ["idle", "windup", "active", "recovery", "step", "hitstun"] as const)
      expect(swordCues(memory(mode, "overhead"), fighter({ mode, attack: "overhead" }), 1)).toEqual(
        [],
      );
  });

  test("no cue for a fighter seen for the first time or dead", () => {
    expect(swordCues(undefined, fighter({ mode: "active", attack: "sweep" }), 1)).toEqual([]);
    expect(swordCues(memory("active", "sweep"), fighter({ mode: "dead" }), 1)).toEqual([]);
  });

  test("charge hum ticks on entry and then every 0.22 s", () => {
    const charging = fighter({ mode: "charge", attack: "overhead", charge: 0.5 });
    expect(kinds(swordCues(memory("idle"), charging, 5))).toEqual(["hum"]);
    const held = { ...memory("charge", "overhead"), lastHumAt: 5 };
    expect(swordCues(held, charging, 5.1)).toEqual([]);
    expect(kinds(swordCues(held, charging, 5.23))).toEqual(["hum"]);
  });

  test("higher charge makes whooshes louder and deeper, and the hum higher", () => {
    let previousPower = -Infinity;
    let previousDepth = Infinity;
    let previousHum = -Infinity;
    for (let charge = 0; charge <= 1.0001; charge += 0.1) {
      const [whoosh] = swordCues(
        memory("windup", "overhead"),
        fighter({ mode: "active", attack: "overhead", charge }),
        1,
      );
      const [hum] = swordCues(memory("idle"), fighter({ mode: "charge", charge }), 1);
      if (whoosh?.kind !== "whoosh" || hum?.kind !== "hum") throw new Error("missing cue");
      expect(whoosh.power).toBeGreaterThan(previousPower);
      expect(whoosh.depth).toBeLessThan(previousDepth);
      expect(hum.charge).toBeGreaterThan(previousHum);
      previousPower = whoosh.power;
      previousDepth = whoosh.depth;
      previousHum = hum.charge;
    }
  });

  test("CPU fighters are quieter than the human", () => {
    const cue = (human: boolean) =>
      swordCues(
        memory("windup", "sweep"),
        fighter({ mode: "active", attack: "sweep", human }),
        1,
      )[0];
    expect(cue(false)!.voice).toBeLessThan(cue(true)!.voice);
  });
});
