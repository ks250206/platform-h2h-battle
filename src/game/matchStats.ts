// Simulation-only counters. The result view reads plain snapshots by fighter slot.
import type { Fighter } from "./types";

/** A ring-out can credit a launch made in the preceding three simulation seconds. */
export const KO_CREDIT_SECONDS = 3;

export interface PlayerMatchStats {
  damageDealt: number;
  damageTaken: number;
  kos: number;
  stocksLost: number;
  opponentLosses: number;
  environmentLosses: number;
  swings: number;
  landedSwings: number;
  dodges: number;
}

export const emptyPlayerStats = (): PlayerMatchStats => ({
  damageDealt: 0,
  damageTaken: 0,
  kos: 0,
  stocksLost: 0,
  opponentLosses: 0,
  environmentLosses: 0,
  swings: 0,
  landedSwings: 0,
  dodges: 0,
});

export function addPlayerStats(total: PlayerMatchStats, game: PlayerMatchStats): PlayerMatchStats {
  return {
    damageDealt: total.damageDealt + game.damageDealt,
    damageTaken: total.damageTaken + game.damageTaken,
    kos: total.kos + game.kos,
    stocksLost: total.stocksLost + game.stocksLost,
    opponentLosses: total.opponentLosses + game.opponentLosses,
    environmentLosses: total.environmentLosses + game.environmentLosses,
    swings: total.swings + game.swings,
    landedSwings: total.landedSwings + game.landedSwings,
    dodges: total.dodges + game.dodges,
  };
}

export function formatAccuracy({ swings, landedSwings }: PlayerMatchStats): string {
  return swings === 0 ? "—" : `${Math.round((landedSwings / swings) * 100)}%`;
}

export const formatDamage = (damage: number): string =>
  damage.toLocaleString("ja-JP", {
    maximumFractionDigits: 1,
  });

interface Swing {
  id: number;
  landed: boolean;
  dodgedBy: Set<number>;
}

export class MatchStats {
  private readonly swings: (Swing | undefined)[] = [];

  constructor(readonly players: PlayerMatchStats[]) {}

  /** The active window counts once, including a sword that later clashes. */
  beginSwing(fighter: Fighter): void {
    this.players[fighter.id].swings++;
    this.swings[fighter.id] = { id: fighter.swingId, landed: false, dodgedBy: new Set() };
  }

  swordHit(attacker: Fighter, target: Fighter, damage: number): void {
    const swing = this.swings[attacker.id];
    if (swing?.id === attacker.swingId) {
      if (!swing.landed) {
        swing.landed = true;
        this.players[attacker.id].landedSwings++;
      }
      if (swing.dodgedBy.delete(target.id)) this.players[target.id].dodges--;
    }
    this.damage(target, damage, attacker.id);
  }

  damage(target: Fighter, damage: number, attackerId: number | null = null): void {
    target.damage += damage;
    this.players[target.id].damageTaken += damage;
    if (attackerId !== null) this.players[attackerId].damageDealt += damage;
  }

  /** Geometry and invulnerability were checked by the caller. Timed protection takes priority. */
  dodgeSword(target: Fighter, attacker: Fighter): void {
    const swing = this.swings[attacker.id];
    if (target.invulnerable > 0 || swing?.id !== attacker.swingId || swing.dodgedBy.has(target.id))
      return;
    swing.dodgedBy.add(target.id);
    this.players[target.id].dodges++;
  }

  /** Bombs are resolved once per explosion, with one check per living target. */
  dodgeBomb(target: Fighter): void {
    if (target.invulnerable <= 0) this.players[target.id].dodges++;
  }

  /** Bombs clear prior credit, as does a combined launch from different sources on one tick. */
  recordLaunch(target: Fighter, attackerId: number | null, elapsed: number): void {
    const ambiguous = target.lastHitAt === elapsed && target.lastAttacker !== attackerId;
    target.lastAttacker = ambiguous ? null : attackerId;
    target.lastHitAt = elapsed;
  }

  recordFall(
    target: Fighter,
    fighters: readonly Fighter[],
    elapsed: number,
    spendsStock: boolean,
    environmental: boolean,
  ): void {
    const attacker =
      !environmental && elapsed - target.lastHitAt <= KO_CREDIT_SECONDS
        ? fighters.find((f) => f.id !== target.id && f.id === target.lastAttacker)
        : undefined;
    if (attacker) attacker.kills++;
    if (!spendsStock) return;
    const stats = this.players[target.id];
    stats.stocksLost++;
    if (attacker) {
      stats.opponentLosses++;
      this.players[attacker.id].kos++;
    } else {
      stats.environmentLosses++;
    }
  }
}
