// Who a fighter slot looks like: the animal, its colours and what it wears. Everything here is
// cosmetic. The simulation reads none of it for its rules: every animal moves, swings, tires and
// gets hit exactly alike. Importable in node (tests): no DOM access.

export type Species = "fox" | "rabbit" | "bear" | "raccoon";
export const SPECIES_IDS: readonly Species[] = ["fox", "rabbit", "bear", "raccoon"];

export interface CharacterDefinition {
  species: Species;
  /** The fighter's name, as the HUD, the announcements and the results say it. */
  name: string;
  /** The animal, for the picker. */
  animal: string;
}

export const CHARACTERS: Readonly<Record<Species, CharacterDefinition>> = {
  fox: { species: "fox", name: "コハク", animal: "キツネ" },
  rabbit: { species: "rabbit", name: "シロ", animal: "ウサギ" },
  bear: { species: "bear", name: "モカ", animal: "クマ" },
  raccoon: { species: "raccoon", name: "スミ", animal: "アライグマ" },
};

export const PALETTE_IDS = ["coral", "sky", "lavender", "marigold", "mint", "berry"] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];

export interface PaletteDefinition {
  id: PaletteId;
  label: string;
  /**
   * The team colour: scarf, tunic, sword gem, floor ring, blade trail and HUD card. Saturated
   * enough to read on the pale floor, light enough for ink text on a chip of it.
   */
  color: number;
  /** The fox's coat: the team colour a shade deeper, so its scarf still reads against it. */
  foxFur: number;
}

/** Multiplies each channel of `color`; the fox's coat and the deeper cloth tones come from it. */
export function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 255) * factor));
  const g = Math.min(255, Math.round(((color >> 8) & 255) * factor));
  const b = Math.min(255, Math.round((color & 255) * factor));
  return (r << 16) | (g << 8) | b;
}

const palette = (id: PaletteId, label: string, color: number): PaletteDefinition => ({
  id,
  label,
  color,
  foxFur: shade(color, 0.88),
});

/** The first four are the colours the original cast wore, in slot order. */
export const PALETTES: Readonly<Record<PaletteId, PaletteDefinition>> = {
  coral: palette("coral", "コーラル", 0xff7a45),
  sky: palette("sky", "スカイ", 0x3fb4ff),
  lavender: palette("lavender", "ラベンダー", 0xb57bff),
  marigold: palette("marigold", "マリーゴールド", 0xffc93c),
  mint: palette("mint", "ミント", 0x2fd6a3),
  berry: palette("berry", "ベリー", 0xff5c9d),
};

export const ACCESSORY_IDS = ["none", "headband", "crown", "goggles", "beret", "flower"] as const;
export type AccessoryId = (typeof ACCESSORY_IDS)[number];

export interface AccessoryDefinition {
  id: AccessoryId;
  label: string;
}

export const ACCESSORIES: Readonly<Record<AccessoryId, AccessoryDefinition>> = {
  none: { id: "none", label: "なし" },
  headband: { id: "headband", label: "ハチマキ" },
  crown: { id: "crown", label: "ミニ王冠" },
  goggles: { id: "goggles", label: "ゴーグル" },
  beret: { id: "beret", label: "ベレー帽" },
  flower: { id: "flower", label: "花かざり" },
};

/** What one fighter slot looks like. */
export interface Loadout {
  species: Species;
  palette: PaletteId;
  accessory: AccessoryId;
}

/** Fighter slots a match can have; `match.ts` re-exports it as MAX_FIGHTERS. */
export const LOADOUT_SLOTS = 4;

/** The original cast: コハク, シロ, モカ and スミ in their own colours, nothing extra on. */
export const DEFAULT_LOADOUTS: readonly Readonly<Loadout>[] = [
  { species: "fox", palette: "coral", accessory: "none" },
  { species: "rabbit", palette: "sky", accessory: "none" },
  { species: "bear", palette: "lavender", accessory: "none" },
  { species: "raccoon", palette: "marigold", accessory: "none" },
];

const isSpecies = (value: unknown): value is Species => SPECIES_IDS.includes(value as Species);
const isPalette = (value: unknown): value is PaletteId => PALETTE_IDS.includes(value as PaletteId);
const isAccessory = (value: unknown): value is AccessoryId =>
  ACCESSORY_IDS.includes(value as AccessoryId);

/** The slot's default look (slots beyond the four wrap around). */
export function defaultLoadout(slot: number): Loadout {
  const index = Number.isInteger(slot)
    ? ((slot % LOADOUT_SLOTS) + LOADOUT_SLOTS) % LOADOUT_SLOTS
    : 0;
  return { ...DEFAULT_LOADOUTS[index]! };
}

/** Keeps every valid field of one saved loadout and replaces the others by the slot's default. */
export function sanitizeLoadout(raw: unknown, slot: number): Loadout {
  const fallback = defaultLoadout(slot);
  if (!raw || typeof raw !== "object") return fallback;
  const source = raw as Record<string, unknown>;
  return {
    species: isSpecies(source.species) ? source.species : fallback.species,
    palette: isPalette(source.palette) ? source.palette : fallback.palette,
    accessory: isAccessory(source.accessory) ? source.accessory : fallback.accessory,
  };
}

/**
 * Always four loadouts, one per slot, from whatever was saved: an array, an object keyed by slot,
 * or nothing at all (options saved before looks could be chosen). Slots are independent: two may
 * hold the very same look, and nothing is ever changed to make them differ.
 */
export function sanitizeLoadouts(raw: unknown): Loadout[] {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return Array.from({ length: LOADOUT_SLOTS }, (_, slot) => sanitizeLoadout(source[slot], slot));
}

/** A copy of `loadouts` with `patch` applied to one slot; the other slots are untouched. */
export function withLoadout(
  loadouts: readonly Loadout[],
  slot: number,
  patch: Partial<Loadout>,
): Loadout[] {
  const next = sanitizeLoadouts(loadouts);
  if (!Number.isInteger(slot) || slot < 0 || slot >= LOADOUT_SLOTS) return next;
  next[slot] = sanitizeLoadout({ ...next[slot], ...patch }, slot);
  return next;
}

export const sameLoadout = (a: Loadout, b: Loadout): boolean =>
  a.species === b.species && a.palette === b.palette && a.accessory === b.accessory;

/** `#rrggbb` for CSS. */
export const cssColor = (color: number): string => `#${color.toString(16).padStart(6, "0")}`;
