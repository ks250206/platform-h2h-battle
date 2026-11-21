import { Container3D } from "@pixi/3d";
import { describe, expect, test } from "vite-plus/test";
import { BattleEngine } from "../src/game/engine";
import { ATTACKS, RULES } from "../src/game/tuning";
import { emptyInput } from "../src/game/types";
import type { AttackId, Fighter, FighterMode, PlayerInput } from "../src/game/types";
import { combatCue, HALO_CHARGED, HALO_FIRED } from "../src/render/combatCues";
import type { CombatCue } from "../src/render/combatCues";
import { MeshLibrary } from "../src/render/meshes";
import { FighterMotion } from "../src/render/motion";
import type { MotionFrame } from "../src/render/motion";
import { PALETTE } from "../src/render/palette";
import { applyFrame, createFighterRig, destroyFighterRig, RigAssets } from "../src/render/rig";
import { spentLife, SwordTrail } from "../src/render/trail";

const ATTACK_IDS: AttackId[] = ["overhead", "rising", "sweep", "thrust"];

interface Sample {
  fighter: Fighter;
  cue: CombatCue;
  frame: MotionFrame;
}

/**
 * The real simulation drawn at `fps`, as the game loop does it: the engine advances by the frame
 * time in fixed ticks and the animator and cues read whatever state that left. `time` is 0 so the
 * breathing of the cancellable glow sits at a fixed point.
 */
function play(
  seconds: number,
  control: (t: number, fighter: Fighter) => Partial<PlayerInput>,
  { fps = 60, prepare }: { fps?: number; prepare?: (engine: BattleEngine) => void } = {},
): { samples: Sample[]; engine: BattleEngine } {
  const engine = new BattleEngine(11);
  engine.start("training");
  engine.state.phase = "playing";
  const [fighter, dummy] = engine.state.fighters as [Fighter, Fighter];
  Object.assign(fighter, { x: 0, z: 0, facing: 0 });
  Object.assign(dummy, { x: -8, z: -8 });
  prepare?.(engine);
  const motion = new FighterMotion();
  const samples: Sample[] = [];
  const dt = 1 / fps;
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    const f = engine.state.fighters[0]!;
    engine.update(dt, { ...emptyInput(), aim: { x: 0, z: 1 }, ...control(i * dt, f) });
    const frame = motion.update(f, dt, { floor: true, atEase: false });
    samples.push({ fighter: structuredClone(f), cue: combatCue(f, 0), frame });
  }
  return { samples, engine };
}

/** A tap on the first frame. */
const tap = (attack: AttackId) => (t: number) =>
  t === 0 ? { attackPressed: attack, attackHeld: attack } : {};

const inMode = (samples: Sample[], mode: FighterMode) =>
  samples.filter((s) => s.fighter.mode === mode);

describe("combat cues follow the simulation's own phases", () => {
  test("every phase of every attack has its own cue, frame for frame", () => {
    for (const attack of ATTACK_IDS) {
      // Held for a moment so the charge shows, then released.
      const { samples } = play(2.4, (t) =>
        t < 0.25 ? { attackPressed: t === 0 ? attack : null, attackHeld: attack } : {},
      );
      for (const mode of ["charge", "windup", "active", "recovery"] as const)
        expect(inMode(samples, mode).length, `${attack} ${mode}`).toBeGreaterThan(0);
      for (const { fighter, cue } of samples) {
        const label = `${attack} ${fighter.mode} ${fighter.modeTime.toFixed(3)}`;
        const mode = fighter.mode;
        expect(cue.phase, label).toBe(mode === "idle" ? "ready" : mode);
        // Cancellable exactly while a cancel input is honoured (engine.handleInput).
        expect(cue.cancellable, label).toBe(mode === "charge" || mode === "windup");
        // Live exactly while `attackContains` can return true.
        expect(cue.live, label).toBe(mode === "active");
        expect(cue.trail, label).toBe(mode === "active" ? 1 : 0);
        expect(cue.exposed > 0, label).toBe(mode === "recovery");
        // The halo is up for the cancellable phases only.
        expect(cue.halo > 0, label).toBe(mode === "charge" || mode === "windup");
      }
    }
  });

  test("brightness alone orders the phases: spent < steel < charge < wind-up < live", () => {
    for (const attack of ATTACK_IDS) {
      const { samples } = play(2.4, (t) =>
        t < 0.25 ? { attackPressed: t === 0 ? attack : null, attackHeld: attack } : {},
      );
      const blade = (mode: FighterMode) => inMode(samples, mode).map((s) => s.cue.blade);
      const glow = (mode: FighterMode) => inMode(samples, mode).map((s) => s.cue.glow);
      expect(Math.max(...blade("idle"))).toBe(0);
      expect(Math.max(...blade("recovery"))).toBeLessThan(-0.5);
      expect(Math.min(...blade("charge"))).toBeGreaterThan(0);
      expect(Math.max(...blade("charge"))).toBeLessThan(Math.min(...blade("windup")) + 1e-9);
      expect(Math.max(...blade("windup"))).toBeLessThan(Math.min(...blade("active")));
      expect(Math.min(...blade("active"))).toBe(1);
      // The glow brightens through the wind-up, is steadiest while live and is off once spent.
      const windup = glow("windup");
      for (let i = 1; i < windup.length; i++)
        expect(windup[i]!).toBeGreaterThanOrEqual(windup[i - 1]!);
      expect(Math.max(...windup)).toBeLessThan(Math.min(...glow("active")));
      expect(Math.max(...glow("recovery"))).toBe(0);
      expect(Math.max(...glow("idle"))).toBe(0);
    }
  });

  test("the halo holds through the charge and closes in over the wind-up", () => {
    const { samples } = play(1.6, (t) =>
      t < 0.95 ? { attackPressed: t === 0 ? "overhead" : null, attackHeld: "overhead" } : {},
    );
    const charge = inMode(samples, "charge");
    expect(charge.at(-1)!.cue.halo).toBeCloseTo(HALO_CHARGED, 5);
    const windup = inMode(samples, "windup").map((s) => s.cue.halo);
    for (let i = 1; i < windup.length; i++) expect(windup[i]!).toBeLessThan(windup[i - 1]!);
    expect(windup.at(-1)!).toBeLessThan(HALO_FIRED + 0.05);
    expect(inMode(samples, "active").every((s) => s.cue.halo === 0)).toBe(true);
  });

  test("the cancellable glow breathes; the live glow holds still", () => {
    const base = { modeTime: 0.1, modeDuration: 0.4, charge: 0.5, hitTargets: [] };
    const over = (mode: FighterMode) =>
      Array.from({ length: 40 }, (_, i) =>
        combatCue({ ...base, mode, attack: "sweep" }, i / 40),
      ).map((c) => c.glow);
    for (const mode of ["charge", "windup"] as const) {
      const glow = over(mode);
      expect(Math.max(...glow) - Math.min(...glow), mode).toBeGreaterThan(0.1);
    }
    const live = over("active");
    expect(Math.max(...live) - Math.min(...live)).toBe(0);
  });

  test("turning follows the aim through the wind-up and locks the moment the cut is live", () => {
    // Aim swings round to +X just as the wind-up starts.
    const { samples } = play(1.4, (t) => ({
      ...(t === 0 ? { attackPressed: "overhead" as const, attackHeld: "overhead" as const } : {}),
      aim: t < 0.05 ? { x: 0, z: 1 } : { x: 1, z: 0 },
    }));
    const facing = (mode: FighterMode) => inMode(samples, mode).map((s) => s.fighter.facing);
    const windup = facing("windup");
    expect(windup.at(-1)! - windup[0]!).toBeGreaterThan(0.2);
    for (const mode of ["active", "recovery"] as const) {
      const locked = facing(mode);
      expect(Math.max(...locked) - Math.min(...locked), mode).toBe(0);
    }
    for (const { fighter, cue } of samples)
      expect(cue.canTurn, fighter.mode).toBe(
        fighter.mode === "idle" || fighter.mode === "charge" || fighter.mode === "windup",
      );
  });
});

describe("rendering never lags a phase change", () => {
  for (const fps of [30, 60, 144]) {
    test(`at ${fps} fps the trail and cues switch on the very frame the state does`, () => {
      for (const attack of ATTACK_IDS) {
        const { samples } = play(2.2, tap(attack), { fps });
        for (const { fighter, cue, frame } of samples) {
          const label = `${attack}@${fps} ${fighter.mode}`;
          expect(frame.trail, label).toBe(fighter.mode === "active" ? 1 : 0);
          expect(cue.live, label).toBe(fighter.mode === "active");
        }
        const firstRecovery = inMode(samples, "recovery")[0]!;
        expect(firstRecovery.cue.blade).toBeLessThan(0);
        expect(firstRecovery.frame.trail).toBe(0);
        // Free again on the first idle frame: no exposure left over.
        const index = samples.indexOf(firstRecovery);
        const idle = samples.slice(index).find((s) => s.fighter.mode === "idle")!;
        expect(idle.cue.exposed).toBe(0);
        expect(idle.cue.phase).toBe("ready");
      }
    });
  }

  test("the ribbon left by a cut is gone within two frames of the recovery, at any frame rate", () => {
    for (const fps of [30, 60, 144]) {
      const trail = new SwordTrail(new Container3D(), 0xff7700);
      const dt = 1 / fps;
      // A blade sweeping round through a live cut.
      for (let i = 0; i < Math.round(0.18 * fps); i++) {
        const a = i * dt * 12;
        trail.update({ x: 0, y: 1, z: 0 }, { x: Math.sin(a) * 2, y: 1, z: Math.cos(a) * 2 }, 1, dt);
      }
      expect(trail.visible, `${fps}`).toBe(true);
      let frames = 0;
      while (trail.visible && frames < 60) {
        trail.update({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 2 }, 0, dt);
        frames++;
      }
      expect(frames * dt, `${fps}`).toBeLessThanOrEqual(spentLife() + dt + 1e-9);
      trail.destroy();
    }
  });
});

describe("a punish window never looks like a ready guard", () => {
  test("a whiff is the most exposed recovery; a connected swing less; neither looks idle", () => {
    const whiff = play(2, tap("sweep")).samples;
    const hit = play(2, tap("sweep"), {
      prepare: (engine) => Object.assign(engine.state.fighters[1]!, { x: 0, z: 1.6 }),
    });
    expect(hit.engine.state.stats.hits).toBe(1);
    for (const { cue } of inMode(whiff, "recovery")) {
      expect(cue.whiffed).toBe(true);
      expect(cue.exposed).toBe(1);
    }
    for (const { cue } of inMode(hit.samples, "recovery")) {
      expect(cue.whiffed).toBe(false);
      expect(cue.exposed).toBeGreaterThan(0);
      expect(cue.exposed).toBeLessThan(1);
    }
    for (const { cue } of inMode(whiff, "idle")) expect(cue.exposed).toBe(0);
  });

  test("the body stays slumped to the last frame of a whiffed recovery", () => {
    for (const attack of ["overhead", "thrust"] as const) {
      const { samples } = play(2.4, tap(attack));
      const recovery = inMode(samples, "recovery");
      const late = recovery[recovery.length - 2]!;
      const idle = samples.at(-1)!;
      expect(idle.fighter.mode).toBe("idle");
      // Hips lower and the trunk folded forward, with the guard only coming back once idle.
      expect(late.frame.skeleton.pelvis.p.y, attack).toBeLessThan(
        idle.frame.skeleton.pelvis.p.y - 0.05,
      );
      // Ears laid back while open (positive is flatter).
      expect(late.frame.ears, attack).toBeGreaterThan(idle.frame.ears + 0.2);
    }
  });
});

describe("a cancel reads as a cancel, and its lag shows", () => {
  /** Calls off an overhead from the charge (`at` < 0) or `at` seconds into the wind-up. */
  function cancelAt(at: number): Sample[] {
    let windupSince = -1;
    return play(1.4, (t, f) => {
      if (t === 0) return { attackPressed: "overhead", attackHeld: "overhead" };
      if (at < 0) return t < 0.1 ? { attackHeld: "overhead" } : t < 0.11 ? { cancel: true } : {};
      if (f.mode === "windup" && windupSince < 0) windupSince = t;
      return windupSince >= 0 && t - windupSince >= at && f.mode === "windup"
        ? { cancel: true }
        : {};
    }).samples;
  }

  test("the lag is drawn for exactly as long as the simulation holds the fighter", () => {
    const early = cancelAt(-1);
    const late = cancelAt(ATTACKS.overhead.startup * 0.85);
    const earlyLag = inMode(early, "cancel");
    const lateLag = inMode(late, "cancel");
    expect(earlyLag.length).toBeGreaterThan(0);
    expect(lateLag.length).toBeGreaterThan(earlyLag.length + 5);
    expect(earlyLag[0]!.cue.cancelLag).toBe(0);
    expect(lateLag[0]!.cue.cancelLag).toBeGreaterThan(0.7);
    for (const samples of [early, late]) {
      expect(inMode(samples, "active")).toHaveLength(0);
      for (const { fighter, cue, frame } of samples) {
        expect(cue.exposed > 0, fighter.mode).toBe(fighter.mode === "cancel");
        expect(frame.trail).toBe(0);
        if (fighter.mode === "cancel") {
          expect(cue.blade).toBeLessThan(0);
          expect(cue.glow).toBe(0);
          expect(cue.halo).toBe(0);
        }
      }
    }
    // A late cancel is darker and more exposed than an early one.
    expect(lateLag[0]!.cue.exposed).toBeGreaterThan(earlyLag[0]!.cue.exposed);
  });

  test("the body recoils from a cancel but drives into a finished swing", () => {
    const cancelled = cancelAt(ATTACKS.overhead.startup * 0.6);
    const swung = play(1.4, tap("overhead")).samples;
    const guard = swung[0]!.frame.skeleton.pelvis.p.z;
    // Facing +Z: the hips go back (−Z) while a cut is called off, forward (+Z) through a cut.
    const held = inMode(cancelled, "cancel");
    const middle = held[Math.floor(held.length / 2)]!.frame.skeleton.pelvis.p.z;
    expect(middle).toBeLessThan(guard - 0.08);
    const active = inMode(swung, "active").at(-1)!.frame.skeleton.pelvis.p.z;
    expect(active).toBeGreaterThan(guard + 0.08);
  });

  test("the check is sharp but never a snap, however early or late the cancel", () => {
    for (const at of [-1, 0.02, ATTACKS.overhead.startup * 0.4, ATTACKS.overhead.startup * 0.85]) {
      const samples = cancelAt(at);
      let fastest = 0;
      for (let i = 1; i < samples.length; i++) {
        if (samples[i]!.fighter.mode !== "cancel") continue;
        const a = samples[i - 1]!.frame.bladeTip,
          b = samples[i]!.frame.bladeTip;
        fastest = Math.max(fastest, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
      }
      // The same bound the motion tests hold every cancelled wind-up to.
      expect(fastest, `${at}`).toBeLessThan(0.7);
    }
  });

  test("a late cancel holds the check longer before rising into the guard", () => {
    const stillFrames = (samples: Sample[]) => {
      const lag = inMode(samples, "cancel");
      let still = 0;
      for (let i = 1; i < lag.length; i++) {
        const a = lag[i - 1]!.frame.skeleton.pelvis.p,
          b = lag[i]!.frame.skeleton.pelvis.p;
        if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 0.004) still++;
      }
      return still;
    };
    expect(stillFrames(cancelAt(ATTACKS.overhead.startup * 0.85))).toBeGreaterThan(
      stillFrames(cancelAt(-1)) + 3,
    );
  });
});

describe("the rig shows the cue", () => {
  test("blade, glow, foot ring and heading chevron change with the phase", () => {
    const assets = new MeshLibrary();
    const rigAssets = new RigAssets();
    const parent = new Container3D();
    const { samples } = play(2.2, tap("thrust"));
    const fighter = samples[0]!.fighter;
    const rig = createFighterRig(assets, rigAssets, parent, fighter);
    const show = (mode: FighterMode, pick: (list: Sample[]) => Sample) => {
      const sample = pick(inMode(samples, mode));
      applyFrame(rig, sample.frame, sample.fighter, 0, sample.cue);
      return {
        core: rig.bladeCore.baseColor,
        glow: rig.bladeGlow.visible ? rig.bladeGlowMaterial.alpha : 0,
        ring: rig.footRing.visible,
        broken: rig.brokenRing.visible,
        heading: rig.heading.visible,
        lance: rig.heading.scale.z,
        halo: rig.chargeHalo.visible,
      };
    };
    const idle = show("idle", (list) => list[0]!);
    expect(idle).toMatchObject({ glow: 0, ring: true, broken: false, heading: true, halo: false });
    expect(idle.core).toBe(PALETTE.fighter.steel);
    expect(idle.lance).toBeCloseTo(1, 5);

    const windup = show("windup", (list) => list[Math.floor(list.length / 2)]!);
    expect(windup).toMatchObject({ ring: true, broken: false, heading: true, halo: true });
    expect(windup.glow).toBeGreaterThan(0);

    const active = show("active", (list) => list[2]!);
    expect(active).toMatchObject({ ring: true, broken: false, heading: true, halo: false });
    expect(active.glow).toBeGreaterThan(windup.glow);
    expect(active.core).toBe(0xffffff);
    expect(active.lance).toBeGreaterThan(2);

    const recovery = show("recovery", (list) => list.at(-1)!);
    expect(recovery).toMatchObject({ glow: 0, ring: false, broken: true, heading: false });
    expect(recovery.core).not.toBe(PALETTE.fighter.steel);

    // And straight back to the guard on the first idle frame.
    const after = show("idle", (list) => list.at(-1)!);
    expect(after).toMatchObject({ ring: true, broken: false, heading: true });
    expect(after.core).toBe(PALETTE.fighter.steel);
    destroyFighterRig(rig);
    rigAssets.destroy();
    assets.destroy();
  });
});

test("the cues never write to the fighter", () => {
  const { samples } = play(1.2, tap("sweep"));
  for (const { fighter } of samples) {
    const before = JSON.stringify(fighter);
    combatCue(fighter, 1.234);
    expect(JSON.stringify(fighter)).toBe(before);
  }
  expect(RULES.cancelDuration).toBe(0.12);
});
