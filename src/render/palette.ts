/**
 * Every colour in the 3D scene, in one place. The look is a bright "candy sky garden": a blue sky
 * that turns pink toward the horizon, a white and periwinkle checkerboard edged in sunny yellow,
 * lavender rock and blossom-pink trees. Cool, light surfaces so that the warm things that matter
 * in a fight (warnings, bombs, sparks, the coral accents of the HUD) are what pops.
 */
export const PALETTE = {
  sky: { top: "#4fb3ff", middle: "#9fdcff", bottom: "#ffd6e6" },
  /** Canvas clear colour, seen for an instant before the sky sprite is drawn. */
  clear: 0x8fd0ff,
  light: { sun: 0xfff4e0, rim: 0xffb8e0, ambient: 0xdfe6ff },

  floor: {
    light: 0xf4f1ff,
    dark: 0xb9c4ff,
    edgeLight: 0xfff0b3,
    edgeDark: 0xffd97a,
    /** Tiles outside the safe zone lose their colour. */
    unsafe: 0xb9b4dc,
    warnA: 0xff8f6b,
    warnB: 0xffd0a8,
    warnRing: 0xff4d5e,
    inlay: 0xa3aef5,
    shard: 0x8a78e6,
    compass: 0x8f9bff,
  },
  /** Multiplied into the baked shade of a tile's side walls, so their shadows lean violet. */
  floorSideTint: [0.84, 0.76, 1] as const,

  island: {
    rock: 0x8f80e6,
    top: 0xfff2c4,
    trunk: 0xb9805e,
    blossom: 0xff9fc4,
    blossomLight: 0xffc6dc,
  },
  cloud: 0xffffff,
  speck: 0xffffff,
  wind: 0xffffff,

  zone: { ring: 0xffb300, core: 0xffe680, label: 0x5a4ad0 },
  bomb: {
    ring: 0xff3d68,
    fill: 0xff5a7a,
    cross: 0xff6f8a,
    rock: 0x5b4a8a,
    flame: 0xff9f1c,
    flameCore: 0xfff0a0,
    label: 0xd81b4a,
  },
  fx: {
    hit: 0xffc21a,
    hitHeavy: 0xff5a1f,
    clash: 0xffd23f,
    blast: 0xff7a1a,
    /** Jump, landing and cancel puffs: dark enough to read on the pale floor. */
    dust: 0x9aa3f0,
    dustLight: 0xffffff,
    chip: 0x7c6cf0,
    crack: 0x4b3fa8,
    spark: 0xffc21a,
    /** Hit sparks: white-hot cores cooling to gold and ember orange as they fly. */
    sparkCore: 0xfff3b8,
    sparkEmber: 0xff7a1a,
    /** Static: electric blue with a pale core, dark enough to read against the pale floor. */
    bolt: 0x2f7bff,
    boltCore: 0xa8ecff,
    flash: 0xffffff,
  },

  label: {
    ink: 0x2a2550,
    shadow: 0x1c1840,
    text: 0xffffff,
    you: 0xffd23f,
    outside: 0xff9fb0,
    stamina: 0x4fd0ff,
    staminaLow: 0xffb020,
  },

  fighter: {
    cream: 0xfff3dc,
    dark: 0x2f2a5a,
    leather: 0x8a5a44,
    gold: 0xffc93c,
    steel: 0xeef3ff,
    fuller: 0x9aa6d6,
    iron: 0x6b6fa3,
    grip: 0x45315a,
    eye: 0x241f47,
    cheek: 0xff9fae,
    innerEar: 0xff9db5,
    bearEar: 0xa86f52,
    fur: { rabbit: 0xfff6f2, bear: 0xd29a6a, raccoon: 0x8a8ea6 },
    shadow: 0x3d2f8f,
    chargeHalo: 0xffb300,
    pointer: 0xff5a4d,
    /** The dark rim that keeps a slot's shape readable on the pale floor and against the sky. */
    markerInk: 0x2a2550,
    /** Fixed tones of the accessories; their cloth takes the fighter's team colour. */
    accessory: { ruby: 0xff3d68, lens: 0xa8ecff, leaf: 0x3fc47f },
  },
} as const;
