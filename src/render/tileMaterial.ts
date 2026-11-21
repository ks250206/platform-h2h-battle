import { createLightingBit, FlatMaterial } from "@pixi/3d";
import type { ColorSpace, FlatMaterialOptions } from "@pixi/3d";

/** What a tile's colour is multiplied by where the sun is blocked: a soft violet, not grey. */
const SHADOW_TINT = "0.68, 0.64, 0.9";

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
    gpu: `finalColor = albedo * mix(vec3<f32>(${SHADOW_TINT}), vec3<f32>(1.0), sunShadow);`,
    gl: `finalColor = albedo * mix(vec3(${SHADOW_TINT}), vec3(1.0), sunShadow);`,
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
