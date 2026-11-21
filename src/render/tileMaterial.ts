import { createLightingBit, FlatMaterial } from "@pixi/3d";
import type { ColorSpace, FlatMaterialOptions } from "@pixi/3d";

/** How much of a tile's colour remains where the sun's shadow falls on it. */
const SHADOW_FLOOR = "0.56";

/**
 * Keeps `FlatMaterial`'s colour (base colour times the baked vertex shade) and only darkens it where
 * a shadow-casting light is blocked. Lights the surface faces away from never reach `perLight`, so
 * the baked side shading is left exactly as authored.
 */
const tileShadowBit = createLightingBit({
  name: "brambleTileShadow",
  preLighting: { gpu: "var sunShadow = 1.0;", gl: "float sunShadow = 1.0;" },
  perLight: {
    gpu: "sunShadow = min(sunShadow, shadow);",
    gl: "sunShadow = min(sunShadow, shadow);",
  },
  postLighting: {
    gpu: `finalColor = albedo * mix(${SHADOW_FLOOR}, 1.0, sunShadow);`,
    gl: `finalColor = albedo * mix(${SHADOW_FLOOR}, 1.0, sunShadow);`,
  },
});

/**
 * The arena floor while real shadows are on: unlit like the default tile material, so the palette
 * and the baked shading stay the same, but it samples the shadow maps (`lit` makes the renderer
 * bind them) and darkens where a fighter, sword or prop blocks the sun.
 */
export class ShadowedTileMaterial extends FlatMaterial {
  override colorSpace: ColorSpace = "linear";
  override lit = true;

  constructor(options: FlatMaterialOptions = {}) {
    super({ ...options, extraBits: [...(options.extraBits ?? []), tileShadowBit] });
  }
}
