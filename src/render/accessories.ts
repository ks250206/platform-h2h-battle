import { Container3D } from "@pixi/3d";
import { shade } from "../game/characters";
import type { AccessoryId, Species } from "../game/characters";
import { qLook } from "./math3";
import type { MeshLibrary } from "./meshes";
import { PALETTE } from "./palette";

/**
 * The skull every animal shares, in the head's own units: an ellipsoid about the head centre
 * (x to the fighter's left, y up, z the way it looks). Ears, muzzles and masks differ per animal,
 * and that is what the accessories below are fitted around.
 */
export const SKULL = { x: 0.48, y: 0.44, z: 0.42 } as const;

/**
 * Nothing an accessory is made of reaches further than this from the centre of the head along any
 * axis (head units: the skull is 0.48 wide, a fox's nose is 0.59 out and its ear tips 0.78 up).
 * Everything is worn on the head and close to it: it adds less to the silhouette than the ears and
 * the muzzle already do, hangs nothing near the arms or the blade, and so cannot hide a wind-up,
 * a swing or a recovery, however small the fighter is drawn.
 */
export const ACCESSORY_REACH = 0.62;
/** Meshes per accessory at most: four fighters in a rumble stay cheap on a low graphics setting. */
export const ACCESSORY_MESH_LIMIT = 8;

const { cream: CREAM, gold: GOLD, leather: LEATHER } = PALETTE.fighter;
const { ruby: RUBY, lens: LENS, leaf: LEAF } = PALETTE.fighter.accessory;

/** How far the skull's surface is from its axis at height `y`, as a fraction of its radii. */
const section = (y: number): number => Math.sqrt(Math.max(0, 1 - (y / SKULL.y) ** 2));

interface HeadFit {
  /**
   * Crown: where it rests and how far it leans forward. A rabbit's ears leave no room between
   * them, so it wears the crown just in front of them, following the slope of its forehead.
   */
  crown: { y: number; z: number; radius: number; lean: number };
  /** Beret: its centre, worn over the fighter's right ear, and how far it droops that way. */
  beret: { x: number; y: number; z: number; droop: number };
  /** Flower: a point on the skull just in front of the left ear's root. */
  flower: { x: number; y: number; z: number };
}

const FIT: Readonly<Record<Species, HeadFit>> = {
  // Tall ears leaning outward: the crown stands between them.
  fox: {
    crown: { y: 0.435, z: 0.02, radius: 0.145, lean: 0.06 },
    beret: { x: -0.07, y: 0.378, z: 0.05, droop: 0.3 },
    flower: { x: 0.26, y: 0.33, z: 0.19 },
  },
  // Long ears close together: crown and beret sit on the forehead in front of them.
  rabbit: {
    crown: { y: 0.395, z: 0.24, radius: 0.125, lean: 0.52 },
    beret: { x: -0.08, y: 0.368, z: 0.13, droop: 0.26 },
    flower: { x: 0.31, y: 0.29, z: 0.17 },
  },
  // Round ears set wide apart: a slightly smaller crown fits between them.
  bear: {
    crown: { y: 0.435, z: 0.02, radius: 0.132, lean: 0.06 },
    beret: { x: -0.06, y: 0.378, z: 0.06, droop: 0.26 },
    flower: { x: 0.28, y: 0.3, z: 0.22 },
  },
  raccoon: {
    crown: { y: 0.435, z: 0.02, radius: 0.132, lean: 0.06 },
    beret: { x: -0.06, y: 0.378, z: 0.06, droop: 0.26 },
    flower: { x: 0.28, y: 0.3, z: 0.22 },
  },
};

interface Tones {
  /** The team colour itself. */
  team: number;
  /** Cloth worn on the head, and a deeper tone of it. */
  cloth: number;
  trim: number;
  /** Small details on the cloth. */
  accent: number;
}

/**
 * Cloth is the team colour, so a hat says whose fighter it is from above. A fox's coat already is
 * its team colour: on it the cloth is cream, with the team colour in the details.
 */
function tones(species: Species, team: number): Tones {
  return species === "fox"
    ? { team, cloth: CREAM, trim: shade(CREAM, 0.8), accent: team }
    : { team, cloth: team, trim: shade(team, 0.76), accent: CREAM };
}

function node(into: Container3D, x = 0, y = 0, z = 0): Container3D {
  const child = new Container3D();
  child.position.set(x, y, z);
  into.addChild(child);
  return child;
}

/** Turns `target` so that its +Y axis points along (x, y, z). */
function aim(target: Container3D, x: number, y: number, z: number): void {
  const length = Math.hypot(x, y, z) || 1;
  const q = qLook({ x: x / length, y: y / length, z: z / length }, { x: 0, y: 0, z: 1 });
  target.quaternion.set(q.x, q.y, q.z, q.w);
}

/** The outward normal of the skull at a point on (or near) its surface. */
const normalAt = (x: number, y: number, z: number) => ({
  x: x / SKULL.x ** 2,
  y: y / SKULL.y ** 2,
  z: z / SKULL.z ** 2,
});

/** ハチマキ: a band round the forehead, knotted at the back with two short tails. */
function headband(a: MeshLibrary, root: Container3D, t: Tones): void {
  const y = 0.235;
  const k = section(y) * 1.035;
  a.mesh(root, a.cylinder, a.material(t.cloth), 0, y, 0, SKULL.x * k, 0.085, SKULL.z * k);
  a.mesh(
    root,
    a.pebble,
    a.material(t.accent),
    0,
    y + 0.014,
    SKULL.z * k - 0.008,
    0.05,
    0.034,
    0.03,
  );
  const knot = node(root, 0, y + 0.01, -SKULL.z * k - 0.012);
  a.mesh(knot, a.pebble, a.material(t.trim), 0, 0, 0, 0.066, 0.056, 0.05);
  for (const [side, droop, length] of [
    [1, 0.5, 0.19],
    [-1, 1, 0.23],
  ] as const) {
    const tail = node(knot);
    tail.rotation.set(-droop, side * 0.34, 0);
    a.box(tail, side > 0 ? t.cloth : t.trim, 0, 0, -length / 2 - 0.02, 0.075, 0.026, length);
  }
}

/** ミニ王冠: a little gold crown with a velvet cap in the team colour. */
function crown(a: MeshLibrary, root: Container3D, t: Tones, fit: HeadFit["crown"]): void {
  const r = fit.radius;
  const base = node(root, 0, fit.y, fit.z);
  // Worn a touch askew.
  base.rotation.set(fit.lean, 0, 0.14);
  a.mesh(base, a.cylinder, a.material(GOLD), 0, 0, 0, r, 0.08, r);
  a.mesh(base, a.sphere, a.material(t.team), 0, 0.045, 0, r * 0.76, 0.08, r * 0.76);
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2;
    const spike = a.mesh(
      base,
      a.cone,
      a.material(GOLD),
      Math.sin(angle) * r * 0.8,
      0.09,
      Math.cos(angle) * r * 0.8,
      0.05,
      0.11,
      0.05,
    );
    spike.rotation.y = angle + Math.PI / 4;
  }
  a.mesh(base, a.pebble, a.material(RUBY), 0, 0.002, r, 0.036, 0.036, 0.022);
}

/** ゴーグル: pushed up on the forehead, so the eyes and brows stay in view. */
function goggles(a: MeshLibrary, root: Container3D): void {
  const y = 0.295;
  const k = section(y) * 1.03;
  a.mesh(root, a.cylinder, a.material(LEATHER), 0, y, 0, SKULL.x * k, 0.052, SKULL.z * k);
  for (const side of [-1, 1]) {
    const x = side * 0.155;
    const z = SKULL.z * Math.sqrt(Math.max(0, 1.05 - (x / SKULL.x) ** 2 - (y / SKULL.y) ** 2));
    const n = normalAt(x, y, z);
    const lens = node(root, x, y, z);
    aim(lens, n.x, n.y, n.z);
    a.mesh(lens, a.cylinder, a.material(GOLD), 0, 0.012, 0, 0.108, 0.06, 0.108);
    a.mesh(lens, a.cylinder, a.material(LENS), 0, 0.024, 0, 0.078, 0.06, 0.078);
  }
  a.box(root, GOLD, 0, y + 0.012, SKULL.z * k + 0.012, 0.11, 0.034, 0.03);
}

/** ベレー帽: a soft cap worn over one ear, with a little stalk on top. */
function beret(a: MeshLibrary, root: Container3D, t: Tones, fit: HeadFit["beret"]): void {
  const base = node(root, fit.x, fit.y, fit.z);
  base.rotation.set(0.1, 0, fit.droop);
  a.mesh(base, a.cylinder, a.material(t.trim), 0.02, -0.035, 0, 0.215, 0.05, 0.2);
  a.mesh(base, a.sphere, a.material(t.cloth), 0, 0.012, 0, 0.3, 0.105, 0.28);
  a.mesh(base, a.cylinder, a.material(t.trim), 0, 0.125, 0, 0.022, 0.06, 0.022);
}

/** 花かざり: a five-petal flower and a leaf tucked in front of one ear. */
function flower(a: MeshLibrary, root: Container3D, t: Tones, fit: HeadFit["flower"]): void {
  const n = normalAt(fit.x, fit.y, fit.z);
  const base = node(root, fit.x, fit.y, fit.z);
  aim(base, n.x, n.y, n.z);
  const leaf = a.mesh(base, a.pebble, a.material(LEAF), -0.1, 0.012, -0.06, 0.085, 0.018, 0.045);
  leaf.rotation.y = -0.55;
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 + 0.3;
    a.mesh(
      base,
      a.pebble,
      a.material(t.cloth),
      Math.sin(angle) * 0.07,
      0.03,
      Math.cos(angle) * 0.07,
      0.06,
      0.024,
      0.06,
    );
  }
  a.mesh(
    base,
    a.pebble,
    a.material(t.cloth === CREAM ? GOLD : CREAM),
    0,
    0.048,
    0,
    0.042,
    0.03,
    0.042,
  );
}

/**
 * Builds what `accessory` looks like on `species` under `skull` (the scaled head node), in the
 * fighter's team colour. Returns the node holding it, or null for "none". Purely decorative: it
 * moves with the head and nothing reads it back.
 */
export function addAccessory(
  a: MeshLibrary,
  skull: Container3D,
  species: Species,
  accessory: AccessoryId,
  team: number,
): Container3D | null {
  if (accessory === "none") return null;
  const root = node(skull);
  const t = tones(species, team);
  const fit = FIT[species];
  switch (accessory) {
    case "headband":
      headband(a, root, t);
      break;
    case "crown":
      crown(a, root, t, fit.crown);
      break;
    case "goggles":
      goggles(a, root);
      break;
    case "beret":
      beret(a, root, t, fit.beret);
      break;
    case "flower":
      flower(a, root, t, fit.flower);
      break;
  }
  return root;
}
