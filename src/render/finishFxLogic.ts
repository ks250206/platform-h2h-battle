// Pure rules for the KO and finish highlights: which look each moment gets and where it stands.
// Kept free of @pixi/3d so unit tests (and anything else) can use them without loading the
// renderer.

import type { PresentationEvent } from "../game/presentation";

type FxEvent = Extract<
  PresentationEvent,
  { kind: "stockKo" | "elimination" | "trainingKo" | "finish" }
>;
export type FxKind = FxEvent["kind"];

export interface FxStyle {
  /** Seconds the highlight lasts. */
  life: number;
  /** Beam height and radius (0 = no beam). */
  beamHeight: number;
  beamRadius: number;
  /** Floor rings: how many and how wide they grow. */
  rings: number;
  ringRadius: number;
  /** A pale core inside the beam: the "flash". Dropped with reduced flash. */
  core: boolean;
  /** Camera shake energy added on the first frame (the renderer honours the shake setting). */
  shake: number;
}

/** Each moment's look, from the plainest to the loudest. A finish is unmistakably bigger. */
export function fxStyle(kind: FxKind, reducedFlash: boolean): FxStyle {
  const base: Record<FxKind, FxStyle> = {
    trainingKo: {
      life: 0.45,
      beamHeight: 0,
      beamRadius: 0,
      rings: 1,
      ringRadius: 1.4,
      core: false,
      shake: 0,
    },
    stockKo: {
      life: 0.7,
      beamHeight: 6,
      beamRadius: 0.28,
      rings: 1,
      ringRadius: 2.2,
      core: false,
      shake: 0,
    },
    elimination: {
      life: 0.95,
      beamHeight: 8,
      beamRadius: 0.4,
      rings: 2,
      ringRadius: 2.8,
      core: true,
      shake: 0.8,
    },
    finish: {
      life: 1.5,
      beamHeight: 11,
      beamRadius: 0.55,
      rings: 3,
      ringRadius: 4.2,
      core: true,
      shake: 0.95,
    },
  };
  const style = { ...base[kind] };
  if (reducedFlash) {
    style.core = false;
    style.shake = Math.min(style.shake, 0.5);
  }
  return style;
}

/**
 * Where a highlight stands: a fighter knocked far off the stage still gets its beam at the edge of
 * the view, on (or just above) the floor.
 */
export function fxSpot(
  x: number,
  y: number,
  z: number,
  halfSize: number,
): { x: number; y: number; z: number } {
  const edge = halfSize + 1.5;
  const clamp = (v: number) => (Number.isFinite(v) ? Math.max(-edge, Math.min(edge, v)) : 0);
  return { x: clamp(x), y: Number.isFinite(y) ? Math.max(0, Math.min(4, y)) : 0, z: clamp(z) };
}
