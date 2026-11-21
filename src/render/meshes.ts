import {
  Container3D,
  CubeGeometry,
  CylinderGeometry,
  FlatMaterial,
  Geometry3D,
  PhongMaterial,
  Mesh3D,
  SphereGeometry,
  TorusGeometry,
} from "@pixi/3d";
import type { BaseMaterial3D } from "@pixi/3d";
import { PALETTE } from "./palette";
import { ShadowedTileMaterial } from "./tileMaterial";

const TAU = Math.PI * 2;
const SIDE_TINT: readonly number[] = PALETTE.floorSideTint;

/** Shared low-poly geometry and cached materials for everything in the arena. */
export class MeshLibrary {
  readonly cube = new CubeGeometry();
  readonly sphere = new SphereGeometry({ radius: 1, widthSegments: 10, heightSegments: 7 });
  readonly pebble = new SphereGeometry({ radius: 1, widthSegments: 6, heightSegments: 4 });
  readonly cylinder = new CylinderGeometry({
    radiusTop: 1,
    radiusBottom: 1,
    height: 1,
    radialSegments: 12,
  });
  readonly cone = new CylinderGeometry({
    radiusTop: 0,
    radiusBottom: 1,
    height: 1,
    radialSegments: 4,
  });
  readonly ring = new TorusGeometry({
    radius: 1,
    tube: 0.025,
    radialSegments: 4,
    tubularSegments: 64,
  });
  readonly disc = makeDisc();
  readonly tile = makeTile();
  private readonly materials = new Map<string, BaseMaterial3D>();

  material(color: number, alpha = 1, glow = 0): BaseMaterial3D {
    const key = `phong/${color}/${alpha}/${glow}`;
    let result = this.materials.get(key);
    if (!result) {
      // Rings, shadows and sparks are authored colors, so lighting them adds no useful detail.
      result =
        alpha < 1 || glow > 0
          ? new FlatMaterial({
              baseColor: color,
              doubleSided: true,
              ...(alpha < 1 ? { alpha, alphaMode: "blend" as const } : {}),
            })
          : new PhongMaterial({
              baseColor: color,
              specularStrength: 0,
              flatShading: true,
              doubleSided: false,
            });
      this.materials.set(key, result);
    }
    return result;
  }

  /** Baked face shades keep large matte surfaces cheap and their depth legible. */
  flatMaterial(color: number, alpha = 1, vertexColors = true): BaseMaterial3D {
    const key = `flat/${color}/${alpha}/${vertexColors}`;
    let result = this.materials.get(key);
    if (!result) {
      result = new FlatMaterial({
        baseColor: color,
        vertexColors,
        doubleSided: false,
        ...(alpha < 1 ? { alpha, alphaMode: "blend" as const } : {}),
      });
      this.materials.set(key, result);
    }
    return result;
  }

  /**
   * Tile tops: the unlit baked-shade material, or with real shadows on, the same look plus the
   * sun's shadow. Both are cached per colour, so swapping them every frame is free.
   */
  tileMaterial(color: number, shadowed: boolean): BaseMaterial3D {
    if (!shadowed) return this.flatMaterial(color);
    const key = `tile/${color}`;
    let result = this.materials.get(key);
    if (!result) {
      result = new ShadowedTileMaterial({
        baseColor: color,
        vertexColors: true,
        doubleSided: false,
      });
      this.materials.set(key, result);
    }
    return result;
  }

  /**
   * Lit opaque surfaces (bodies, swords, scenery) cast and receive shadows. Unlit or see-through
   * ones (rings, discs, sparks, the baked floor) stay out of the shadow pass.
   */
  static castsShadow(material: BaseMaterial3D): boolean {
    return material.lit && material.alphaMode === "opaque";
  }

  mesh(
    parent: Container3D,
    geometry: Geometry3D,
    material: BaseMaterial3D,
    x = 0,
    y = 0,
    z = 0,
    sx = 1,
    sy = sx,
    sz = sx,
  ): Mesh3D {
    const shadows = MeshLibrary.castsShadow(material);
    const mesh = new Mesh3D({ geometry, material, castShadow: shadows, receiveShadow: shadows });
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    parent.addChild(mesh);
    return mesh;
  }

  box(
    parent: Container3D,
    color: number,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
  ): Mesh3D {
    return this.mesh(parent, this.cube, this.material(color), x, y, z, sx, sy, sz);
  }

  ball(
    parent: Container3D,
    color: number,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy = sx,
    sz = sx,
  ): Mesh3D {
    return this.mesh(parent, this.sphere, this.material(color), x, y, z, sx, sy, sz);
  }

  destroy(): void {
    for (const material of this.materials.values()) material.destroy();
    for (const geometry of [
      this.cube,
      this.sphere,
      this.pebble,
      this.cylinder,
      this.cone,
      this.ring,
      this.disc,
      this.tile,
    ])
      geometry.destroy(true);
    this.materials.clear();
  }
}

/** One beveled slab replaces three overlapping boxes per tile (81 versus 243 meshes). */
function makeTile(): Geometry3D {
  const positions: number[] = [],
    normals: number[] = [],
    colors: number[] = [],
    indices: number[] = [];
  const quad = (
    points: number[][],
    normal: number[],
    shade: number,
    tint: readonly number[] = [1, 1, 1],
  ) => {
    const first = positions.length / 3;
    for (const p of points) {
      positions.push(...p);
      normals.push(...normal);
      colors.push(shade * tint[0]!, shade * tint[1]!, shade * tint[2]!, 1);
    }
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  };
  const widths = [0.91, 0.97, 0.94, 0.84, 0.8];
  const heights = [0, -0.08, -0.36, -0.48, -0.78];
  const corners = (r: number, y: number) => [
    [-r, y, -r],
    [-r, y, r],
    [r, y, r],
    [r, y, -r],
  ];
  quad(corners(widths[0]!, heights[0]!), [0, 1, 0], 1);
  for (let layer = 0; layer < widths.length - 1; layer++) {
    const upper = corners(widths[layer]!, heights[layer]!);
    const lower = corners(widths[layer + 1]!, heights[layer + 1]!);
    for (let side = 0; side < 4; side++) {
      const next = (side + 1) % 4;
      const normal = [
        [-1, 0, 0],
        [0, 0, 1],
        [1, 0, 0],
        [0, 0, -1],
      ][side]!;
      const shade = [0.9, 0.74, 0.64, 0.55][layer]! * [0.92, 1, 0.86, 0.8][side]!;
      quad([upper[side]!, lower[side]!, lower[next]!, upper[next]!], normal, shade, SIDE_TINT);
    }
  }
  quad(corners(widths.at(-1)!, heights.at(-1)!).reverse(), [0, -1, 0], 0.35, SIDE_TINT);
  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint16Array(indices),
  });
}

function makeDisc(): Geometry3D {
  const positions = [0, 0, 0];
  const normals = [0, 1, 0];
  const indices: number[] = [];
  for (let i = 0; i <= 40; i++) {
    positions.push(Math.sin((i / 40) * TAU), 0, Math.cos((i / 40) * TAU));
    normals.push(0, 1, 0);
    if (i < 40) indices.push(0, i + 1, i + 2);
  }
  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
  });
}
