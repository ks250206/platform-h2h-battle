// Telling fighters apart without relying on colour: two players may pick the very same animal in
// the very same colours. Every slot has its own shape, and every fighter a tag (YOU, P1-P4,
// CPU 01-03); the 3D scene, the HUD cards, the lock-on chips, the announcements and the results
// all use the same ones. Importable in node (tests): no DOM access.

import type { Fighter } from "./types";

export type SlotShape = "triangle" | "circle" | "square" | "star";

/** The shape of each fighter slot (0-3). It belongs to the slot, whoever plays it. */
export const SLOT_SHAPES: readonly SlotShape[] = ["triangle", "circle", "square", "star"];

export const SLOT_SHAPE_LABELS: Readonly<Record<SlotShape, string>> = {
  triangle: "三角",
  circle: "丸",
  square: "四角",
  star: "星",
};

export function slotShape(slot: number): SlotShape {
  const count = SLOT_SHAPES.length;
  return SLOT_SHAPES[(((Math.trunc(slot) || 0) % count) + count) % count]!;
}

/**
 * The outline of each shape as points on a unit circle (x right, y up), in drawing order. The 3D
 * markers, the labels over the fighters and the HUD glyphs are all built from these, so a shape
 * looks the same wherever it appears.
 */
export const SLOT_SHAPE_POINTS: Readonly<
  Record<SlotShape, readonly (readonly [number, number])[]>
> = {
  // Points down, like the marker a lone player has always had over the head.
  triangle: [
    [0, -1],
    [0.95, 0.72],
    [-0.95, 0.72],
  ],
  circle: Array.from({ length: 16 }, (_, i) => {
    const angle = (i / 16) * Math.PI * 2;
    return [Math.sin(angle) * 0.9, Math.cos(angle) * 0.9] as const;
  }),
  square: [
    [-0.8, 0.8],
    [0.8, 0.8],
    [0.8, -0.8],
    [-0.8, -0.8],
  ],
  star: Array.from({ length: 10 }, (_, i) => {
    const angle = (i / 10) * Math.PI * 2;
    const radius = i % 2 === 0 ? 1.08 : 0.46;
    return [Math.sin(angle) * radius, Math.cos(angle) * radius] as const;
  }),
};

type Tagged = Pick<Fighter, "id" | "human" | "player">;
type Named = Tagged & Pick<Fighter, "name">;

export const countHumans = (fighters: readonly Pick<Fighter, "human">[]): number =>
  fighters.reduce((count, fighter) => count + (fighter.human ? 1 : 0), 0);

/**
 * Who a fighter is, whatever it looks like: YOU for a lone player, P1-P4 when several share the
 * screen, CPU 0n (its slot) for the others.
 */
export function fighterTag(fighter: Tagged, humanCount: number): string {
  if (!fighter.human) return "CPU " + String(fighter.id).padStart(2, "0");
  return humanCount > 1 ? `P${fighter.player ?? 1}` : "YOU";
}

/** Does another fighter of the match carry the same name (the same animal was picked twice)? */
export function sharesName(fighter: Named, fighters: readonly Named[]): boolean {
  return fighters.some((other) => other.id !== fighter.id && other.name === fighter.name);
}

/**
 * The name to announce: just the name while it is the only one in the match, and led by the tag
 * ("P2 モカ", "CPU 03 モカ") as soon as two fighters share it.
 */
export function fighterTitle(fighter: Named, fighters: readonly Named[]): string {
  if (!sharesName(fighter, fighters)) return fighter.name;
  return `${fighterTag(fighter, countHumans(fighters))} ${fighter.name}`;
}
