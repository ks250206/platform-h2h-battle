// Register 3D before app.init: Pixi loads the matching backend during initialization.
import {
  AmbientLight,
  Container3D,
  DirectionalLight,
  Mesh3D,
  Plane,
  Vector3,
  View3D,
} from "@pixi/3d";
import { Application, Container, Graphics, RendererType, Sprite, Text, Texture } from "pixi.js";
import type { WebGLRenderer } from "pixi.js";
import { CAMERA_FORWARD, CAMERA_OFFSET, CAMERA_RIGHT } from "../game/coordinates";
import type { Bomb, Effect, Fighter, GameState, Vec2 } from "../game/types";
import { createFighterMesh, MeshLibrary, poseFighter } from "./meshes";
import type { FighterMesh } from "./meshes";

const TAU = Math.PI * 2;
/** Oblique look-down perspective camera; its direction is CAMERA_OFFSET (shared with input). */
const CAMERA_FOV = 37;
const CAMERA_NEAR = 0.3;
const CAMERA_FAR = 180;
/**
 * Camera distance multiplier = max(height fit, width fit). The height fit keeps the arena plus
 * knock-out margin inside the band the HUD leaves free (match heading on top; fighter cards,
 * key legend or touch controls at the bottom); the width fit keeps it across a portrait screen.
 */
const CAMERA_FIT_HEIGHT = 0.76;
const CAMERA_FIT_WIDTH = 1.25;
/** Pixel rows the HUD covers above and below the arena, following styles.css / touch.css. */
function hudBand(height: number, touch: boolean): { top: number; bottom: number } {
  // Short touch screens move the fighter cards to the top; the touch controls hug the corners.
  if (touch && height <= 570) return { top: 150, bottom: 70 };
  // Otherwise cards sit at the bottom, above the touch controls on touch screens.
  const bottom = touch ? Math.min(330, height * 0.4) : Math.min(220, height * 0.3);
  return { top: Math.min(120, height * 0.2), bottom };
}
const CAMERA_DISTANCE = Math.hypot(CAMERA_OFFSET.x, CAMERA_OFFSET.y, CAMERA_OFFSET.z);
/** World height the view spans at the look-at target, per unit of camera scale. */
const VIEW_HEIGHT = 2 * Math.tan((CAMERA_FOV * Math.PI) / 360) * CAMERA_DISTANCE;
/**
 * The camera's screen-up axis: the ground's screen-up tilted by the elevation. Panning along it
 * (rather than along the ground) slides the picture without changing the distance to the arena.
 */
const CAMERA_UP = {
  x: (CAMERA_FORWARD.x * CAMERA_OFFSET.y) / CAMERA_DISTANCE,
  y: Math.hypot(CAMERA_OFFSET.x, CAMERA_OFFSET.z) / CAMERA_DISTANCE,
  z: (CAMERA_FORWARD.z * CAMERA_OFFSET.y) / CAMERA_DISTANCE,
};
/** Menu pans as fractions of the view; negative moves the arena right / up on screen. */
const MENU_PAN_RIGHT = -0.17;
const MENU_PAN_UP = -0.2;
/** Fighter facing (0 is +Z) that looks straight back at the camera. */
const FACING_CAMERA = Math.atan2(-CAMERA_FORWARD.x, -CAMERA_FORWARD.z);
const ease = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);

/** Only affects rendering quality. Simulation, input, UI and test timing stay unchanged. */
function hasSoftwareRenderer(): boolean {
  const probe = document.createElement("canvas");
  const gl = probe.getContext("webgl2");
  if (!gl) return false;
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = info
    ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
    : String(gl.getParameter(gl.RENDERER));
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return /swiftshader|llvmpipe|softpipe|software/i.test(name);
}

interface TileView {
  root: Container3D;
  top: Mesh3D;
  outline: Mesh3D;
  x: number;
  z: number;
  tint: number;
  fallenAt: number | null;
}
interface FighterView {
  mesh: FighterMesh;
  label: Text;
  stamina: Graphics;
  identity: string;
}
interface BombView {
  root: Container3D;
  ring: Mesh3D;
  fill: Mesh3D;
  comet: Container3D;
  label: Text;
}
interface EffectView {
  root: Container3D;
  particles: Mesh3D[];
  ring: Mesh3D;
}

/** One renderer, one external game loop. No simulation or input is owned here. */
export class ArenaRenderer {
  readonly app: Application;
  readonly canvas: HTMLCanvasElement;
  private readonly host: HTMLElement;
  private readonly view: View3D;
  private readonly scene = new Container3D();
  private readonly scenery = new Container3D();
  private readonly labels = new Container();
  private readonly assets = new MeshLibrary();
  private readonly tiles: TileView[] = [];
  private readonly fighters = new Map<number, FighterView>();
  private readonly bombs = new Map<number, BombView>();
  private readonly effects = new Map<number, EffectView>();
  private readonly floaters: {
    root: Container3D;
    x: number;
    y: number;
    z: number;
    phase: number;
  }[] = [];
  private readonly zone = new Container3D();
  private readonly zoneRing: Mesh3D;
  private readonly zoneCore: Mesh3D;
  private readonly zoneMarker: Text;
  private readonly background: Sprite;
  private readonly skyTexture: Texture;
  private readonly resizeObserver: ResizeObserver;
  private readonly ground = new Plane(new Vector3(0, 1, 0), 0);
  private readonly windLines: Mesh3D[] = [];
  private width = 1280;
  private height = 720;
  private time = 0;
  private cameraScale = 1;
  /** Eased view pan along the camera's screen-right / screen-up axes, in fractions of the view. */
  private panRight = 0;
  private panUp = 0;
  /** In play: the pan that centres the arena in the band between the top and bottom HUD. */
  private hudPanUp = 0;
  private lastElapsed = 0;
  private destroyed = false;
  private readonly software: boolean;
  private qualityScale = 1;
  private baseResolution = 1;
  private previousRenderAt = 0;
  private sampleFrameTime = 0;
  private sampleFrameCount = 0;

  private constructor(app: Application, host: HTMLElement, software: boolean) {
    this.app = app;
    this.host = host;
    this.software = software;
    this.canvas = app.canvas;
    this.canvas.setAttribute("aria-label", "浮島で大剣を振るう動物たちの3Dバトル");
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.touchAction = "none";
    this.canvas.dataset.renderBackend = software ? "software" : "hardware";
    host.appendChild(this.canvas);
    const sky = document.createElement("canvas");
    sky.width = 2;
    sky.height = 512;
    const context = sky.getContext("2d")!;
    const gradient = context.createLinearGradient(0, 0, 0, 512);
    gradient.addColorStop(0, "#122831");
    gradient.addColorStop(0.55, "#25444a");
    gradient.addColorStop(1, "#3b5658");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 2, 512);
    this.skyTexture = Texture.from(sky);
    this.background = new Sprite(this.skyTexture);
    app.stage.addChild(this.background);
    this.view = new View3D({
      width: host.clientWidth || 1280,
      height: host.clientHeight || 720,
      composite: true,
      resolution: 1,
      toneMapping: "none",
      exposure: 1,
      // Matte low-poly art needs no HDR cubemap generation or per-pixel IBL reflection.
      environment: null,
      cull: "cpu",
    });
    this.view.eventMode = "none";
    this.labels.eventMode = "none";
    app.stage.addChild(this.view, this.labels);
    this.view.root.addChild(this.scenery, this.scene);
    this.view.camera.mode = "perspective";
    this.view.camera.fov = CAMERA_FOV;
    this.view.camera.near = CAMERA_NEAR;
    this.view.camera.far = CAMERA_FAR;
    const sun = new DirectionalLight({ color: 0xffe9c0, intensity: 2.2, castShadow: false });
    sun.position.set(-10, 22, 14);
    this.view.root.addChild(sun);
    sun.lookAt({ x: 0, y: 0, z: 0 });
    const rim = new DirectionalLight({ color: 0x8bd6dc, intensity: 0.65, castShadow: false });
    rim.position.set(12, 7, -12);
    this.view.root.addChild(rim);
    rim.lookAt({ x: 0, y: 1, z: 0 });
    this.view.root.addChild(new AmbientLight({ color: 0xb4cdd1, intensity: 0.7 }));
    this.buildArena();
    this.buildScenery();
    this.scene.addChild(this.zone);
    this.zoneRing = this.assets.mesh(
      this.zone,
      this.assets.ring,
      this.assets.material(0xa8efd0, 0.92, 0.3),
    );
    this.zoneCore = this.assets.mesh(
      this.zone,
      this.assets.disc,
      this.assets.material(0xabedd2, 0.08),
      0,
      -0.005,
      0,
    );
    this.zoneMarker = new Text({
      text: "SAFE ZONE",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 10,
        fontWeight: "700",
        fill: 0xc5f5de,
        letterSpacing: 2,
      },
    });
    this.zoneMarker.anchor.set(0.5, 0.5);
    this.labels.addChild(this.zoneMarker);
    for (let i = 0; i < 8; i++) {
      const line = this.assets.box(this.scene, 0xa9d7ca, 0, 0.2, 0, 0.035, 0.025, 0.9);
      line.material = this.assets.material(0xb4e6d8, 0.45, 0.2);
      line.visible = false;
      this.windLines.push(line);
    }
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  static async create(host: HTMLElement): Promise<ArenaRenderer> {
    const app = new Application();
    const software = hasSoftwareRenderer();
    try {
      await app.init({
        preference: "webgl",
        width: host.clientWidth || 1280,
        height: host.clientHeight || 720,
        background: 0x132b34,
        antialias: !software,
        autoDensity: true,
        resolution: Math.min(window.devicePixelRatio || 1, software ? 1 : 1.75),
        autoStart: false,
        powerPreference: "high-performance",
      });
      if (
        app.renderer.type === RendererType.WEBGL &&
        (app.renderer as WebGLRenderer).context.webGLVersion !== 2
      ) {
        throw new Error("このゲームの描画には WebGL 2 が必要です。");
      }
      if (app.renderer.type !== RendererType.WEBGL && app.renderer.type !== RendererType.WEBGPU) {
        throw new Error("3D描画に対応したブラウザーで開いてください。");
      }
      app.ticker.stop();
      return new ArenaRenderer(app, host, software);
    } catch (error) {
      if (app.renderer) app.destroy({ removeView: true }, { children: true });
      throw error;
    }
  }

  private buildArena(): void {
    const a = this.assets;
    for (let row = -4; row <= 4; row++) {
      for (let col = -4; col <= 4; col++) {
        const root = new Container3D();
        const x = col * 2,
          z = row * 2;
        root.position.set(x, 0, z);
        this.scene.addChild(root);
        const border = Math.abs(row) === 4 || Math.abs(col) === 4;
        const tint = border
          ? (row + col) % 2
            ? 0xc9c8a4
            : 0xbbc5a6
          : (row + col) % 2
            ? 0x86ad9a
            : 0xa4c1a8;
        const top = a.mesh(root, a.tile, a.flatMaterial(tint));
        const outline = a.mesh(root, a.ring, a.material(0xf7b36e, 0.8, 0.2), 0, 0.025, 0, 0.75);
        outline.visible = false;
        this.tiles.push({ root, top, outline, x, z, tint, fallenAt: null });
        if (border && (col + row) % 3 === 0) {
          const shard = a.mesh(
            root,
            a.cone,
            a.material(0x385b5d),
            0,
            -1.09,
            0,
            1.03,
            1.1 + ((col * row + 17) % 3) * 0.4,
            0.94,
          );
          shard.rotation.z = Math.PI;
          shard.rotation.y = 0.4;
        }
        // Quiet decorative inlay: it never denotes a collider or hazard.
        if (!border && (row + col + 12) % 5 === 0) {
          a.box(root, 0x91b3a3, -0.57, 0.006, -0.5, 0.34, 0.012, 0.045).rotation.y = 0.5;
          a.box(root, 0x91b3a3, -0.45, 0.007, -0.43, 0.18, 0.012, 0.045).rotation.y = -0.45;
        }
      }
    }
    // A pale compass is a useful reference for depth and directional inputs.
    const compass = a.mesh(this.scene, a.ring, a.material(0xf5e7bf, 0.3), 0, 0.012, 0, 2.6);
    for (let i = 0; i < 4; i++) {
      const mark = a.box(
        this.scene,
        0xe3dab7,
        Math.sin((i * Math.PI) / 2) * 2.6,
        0.016,
        Math.cos((i * Math.PI) / 2) * 2.6,
        0.09,
        0.013,
        0.44,
      );
      mark.rotation.y = (i * Math.PI) / 2;
    }
  }

  private buildScenery(): void {
    const a = this.assets;
    // Sites are [screen right, screen up (away from camera), height, size] on the ground, so the
    // islands frame the arena from behind and the sides and never sit in the foreground.
    const sites = [
      [-20, 9, -6, 1.4],
      [21, 12, -8, 2.1],
      [-25, 21, -8, 1.7],
      [24, 25, -9, 2.2],
      [-5, 30, -9, 1.6],
      [10, 27, -10, 1.1],
    ];
    sites.forEach(([right, up, y, size], i) => {
      const x = CAMERA_RIGHT.x * right! + CAMERA_FORWARD.x * up!;
      const z = CAMERA_RIGHT.z * right! + CAMERA_FORWARD.z * up!;
      const root = new Container3D();
      root.position.set(x, y!, z);
      root.scale.set(size!);
      this.scenery.addChild(root);
      const rock = a.mesh(root, a.cone, a.material(0x27494f), 0, -0.8, 0, 1.5, 2, 1.3);
      rock.rotation.z = Math.PI;
      a.mesh(root, a.cylinder, a.material(0x668c80), 0, 0.1, 0, 1.4, 0.21, 1.2);
      if (i % 2 === 0) {
        a.box(root, 0x445b58, 0.1, 0.5, 0, 0.13, 0.8, 0.13);
        a.mesh(root, a.cone, a.material(0x87a58e), 0.1, 1.05, 0, 0.66, 1.2, 0.62);
        a.mesh(root, a.cone, a.material(0x9eb496), 0.1, 1.46, 0, 0.47, 0.91, 0.47);
      }
      this.floaters.push({ root, x, y: y!, z, phase: i * 1.45 });
    });
    for (let i = 0; i < 24; i++) {
      const angle = (i / 24) * TAU;
      const distance = 14 + (i % 5) * 3;
      // The ring of specks is pushed away from the camera to fill the visible backdrop.
      const spark = a.mesh(
        this.scenery,
        a.pebble,
        a.material(0xa0b7a1, 0.45, 0.2),
        CAMERA_FORWARD.x * 6 + Math.sin(angle) * distance,
        -3 - (i % 4),
        CAMERA_FORWARD.z * 6 + Math.cos(angle) * distance,
        0.035 + (i % 3) * 0.014,
      );
      this.floaters.push({
        root: spark,
        x: spark.position.x,
        y: spark.position.y,
        z: spark.position.z,
        phase: i * 1.31,
      });
    }
  }

  private updateArena(state: GameState): void {
    const a = this.assets;
    const reset = state.elapsed < this.lastElapsed;
    const safe = state.arena.safeZone;
    for (const tile of this.tiles) {
      const supported =
        Math.abs(tile.x) < state.arena.halfSize && Math.abs(tile.z) < state.arena.halfSize;
      if (reset || supported) tile.fallenAt = null;
      if (!supported && tile.fallenAt === null) tile.fallenAt = this.time;
      const falling = tile.fallenAt === null ? 0 : this.time - tile.fallenAt;
      tile.root.visible = supported || falling < 1.1;
      tile.root.position.y = supported ? 0 : -falling * falling * 16;
      tile.root.rotation.set(
        supported ? 0 : falling * 0.35,
        0,
        supported ? 0 : falling * 0.2 * Math.sign(tile.x || 1),
      );
      const warning =
        supported &&
        state.arena.warningRing &&
        Math.max(Math.abs(tile.x), Math.abs(tile.z)) >= state.arena.halfSize - 2;
      const unsafe = safe.active && Math.hypot(tile.x - safe.x, tile.z - safe.z) > safe.radius;
      tile.top.material = a.flatMaterial(
        warning
          ? Math.sin(this.time * 7) > 0
            ? 0xdca36f
            : 0xdec2a1
          : unsafe
            ? 0x91a4a5
            : tile.tint,
      );
      tile.outline.visible = warning;
      if (warning) tile.outline.scale.set(0.5 + (Math.sin(this.time * 5) + 1) * 0.12);
    }
    this.zone.visible = safe.active;
    this.zoneMarker.visible = safe.active;
    this.zone.position.set(safe.x, 0.045, safe.z);
    this.zoneRing.scale.set(safe.radius);
    this.zoneCore.scale.set(safe.radius, 1, safe.radius);
    // Label the far edge of the ring, the one leaning away from the camera.
    const far = safe.radius - 0.4;
    const marker = this.view.worldToScreen({
      x: safe.x + CAMERA_FORWARD.x * far,
      y: 0.1,
      z: safe.z + CAMERA_FORWARD.z * far,
    });
    if (marker) this.zoneMarker.position.set(marker.x, marker.y);
    for (const [i, line] of this.windLines.entries()) {
      line.visible = state.arena.windActive;
      const progress = (this.time * 0.6 + i * 0.19) % 1;
      line.position.set(-8 + progress * 16, 0.2 + (i % 3) * 0.3, -6 + (i % 7) * 2);
      line.rotation.y = Math.atan2(state.arena.wind.x, state.arena.wind.z);
    }
    this.lastElapsed = state.elapsed;
  }

  private fighterView(f: Fighter): FighterView {
    const identity = `${f.species}/${f.color}/${f.human}`;
    let view = this.fighters.get(f.id);
    if (view && view.identity !== identity) {
      this.destroyFighter(view);
      this.fighters.delete(f.id);
      view = undefined;
    }
    if (view) return view;
    const mesh = createFighterMesh(this.assets, this.scene, f);
    const label = new Text({
      text: f.human ? "YOU" : f.name,
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 11,
        fontWeight: "800",
        fill: f.human ? 0xffe2ac : 0xe8f0ed,
        letterSpacing: 1,
        dropShadow: { color: 0x10282f, alpha: 0.65, blur: 3, distance: 1 },
      },
    });
    label.anchor.set(0.5, 1);
    const stamina = new Graphics();
    this.labels.addChild(stamina, label);
    view = { mesh, label, stamina, identity };
    this.fighters.set(f.id, view);
    return view;
  }

  private updateFighter(f: Fighter, dt: number, state: GameState): void {
    const view = this.fighterView(f);
    poseFighter(view.mesh, f, dt);
    // Showcase pose: face the camera, each turned a little toward the other (human is on the left).
    if (state.phase === "menu")
      view.mesh.root.rotation.y = FACING_CAMERA + (f.human ? 0.42 : -0.36);
    const onPlatform =
      Math.abs(f.x) <= state.arena.halfSize && Math.abs(f.z) <= state.arena.halfSize;
    view.mesh.shadow.visible &&= onPlatform;
    view.mesh.footRing.visible &&= onPlatform;
    const point = this.view.worldToScreen({ x: f.x, y: Math.max(f.y, -1) + 2.65, z: f.z });
    const labelVisible = f.mode !== "dead" && point !== null;
    view.label.visible = labelVisible;
    view.stamina.visible = labelVisible;
    if (point) {
      view.label.position.set(point.x, point.y);
      view.label.text = f.human ? "YOU" : `${f.name}  ${Math.round(f.damage)}%`;
      view.label.style.fill = f.outsideTime > 0.5 ? 0xffad93 : f.human ? 0xffe2ac : 0xe8f0ed;
      view.stamina
        .clear()
        .roundRect(
          point.x - view.label.width / 2 - 6,
          point.y - view.label.height - 4,
          view.label.width + 12,
          view.label.height + 8,
          4,
        )
        .fill({ color: 0x173039, alpha: 0.88 });
      if (state.phase !== "menu")
        view.stamina
          .roundRect(point.x - 19, point.y + 5, 38, 3, 1.5)
          .fill({ color: 0x183239, alpha: 0.7 });
      if (state.phase !== "menu")
        view.stamina
          .roundRect(point.x - 19, point.y + 5, Math.max(0.1, (38 * f.stamina) / 100), 3, 1.5)
          .fill({ color: f.stamina < 25 ? 0xf3b167 : 0xbfe3a1 });
    }
  }

  private bombView(bomb: Bomb): BombView {
    let entry = this.bombs.get(bomb.id);
    if (entry) return entry;
    const a = this.assets;
    const root = new Container3D();
    this.scene.addChild(root);
    const ring = a.mesh(root, a.ring, a.material(0xff987a, 0.95, 0.6), 0, 0.065, 0, bomb.radius);
    const fill = a.mesh(
      root,
      a.disc,
      a.material(0xff8d6b, 0.2, 0.2),
      0,
      0.055,
      0,
      bomb.radius,
      1,
      bomb.radius,
    );
    for (const turn of [0, Math.PI / 2]) {
      const cross = a.box(root, 0xffae84, 0, 0.07, 0, 0.045, 0.025, 0.48);
      cross.rotation.y = turn;
    }
    const comet = new Container3D();
    root.addChild(comet);
    a.mesh(comet, a.pebble, a.material(0x645c59), 0, 0, 0, 0.35);
    a.mesh(comet, a.cone, a.material(0xf9ac6e, 0.7, 1), 0, 0.7, 0, 0.36, 1.7, 0.36);
    a.mesh(comet, a.cone, a.material(0xffe1a3, 0.85, 1), 0, 0.47, 0, 0.18, 1.1, 0.18);
    const label = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 11,
        fontWeight: "800",
        fill: 0xffcfac,
        dropShadow: { color: 0x271f22, blur: 3, alpha: 0.8, distance: 1 },
      },
    });
    label.anchor.set(0.5);
    this.labels.addChild(label);
    entry = { root, ring, fill, comet, label };
    this.bombs.set(bomb.id, entry);
    return entry;
  }

  private updateBomb(bomb: Bomb): void {
    const view = this.bombView(bomb);
    view.root.position.set(bomb.x, 0, bomb.z);
    view.root.visible = !bomb.exploded;
    view.label.visible = !bomb.exploded;
    view.ring.scale.set(bomb.radius);
    const progress = 1 - bomb.timer / bomb.duration;
    view.fill.scale.set(
      bomb.radius * Math.max(0.1, progress),
      1,
      bomb.radius * Math.max(0.1, progress),
    );
    view.comet.visible = bomb.timer < 0.55;
    view.comet.position.set(0, Math.max(0.05, bomb.timer * 17), 0);
    view.comet.rotation.y = this.time * 3;
    const p = this.view.worldToScreen({ x: bomb.x, y: 0.15, z: bomb.z });
    if (p) view.label.position.set(p.x, p.y + 13);
    view.label.text = `${Math.max(0, bomb.timer).toFixed(1)}`;
  }

  private effectView(effect: Effect): EffectView {
    let view = this.effects.get(effect.id);
    if (view) return view;
    const a = this.assets;
    const root = new Container3D();
    this.scene.addChild(root);
    const color =
      effect.kind === "clash" ? 0xffe8a3 : effect.kind === "bomb" ? 0xf6b77d : effect.color;
    const material = a.material(color, 1, 0.55);
    const count =
      effect.kind === "ko" || effect.kind === "bomb" ? 12 : effect.kind === "clash" ? 10 : 6;
    const particles = Array.from({ length: count }, (_, i) =>
      a.mesh(root, i % 2 ? a.cube : a.pebble, material, 0, 0, 0, 0.08, 0.08, 0.08),
    );
    const ring = a.mesh(root, a.ring, a.material(color, 0.65, 0.4));
    view = { root, particles, ring };
    this.effects.set(effect.id, view);
    return view;
  }

  private updateEffect(effect: Effect): void {
    const view = this.effectView(effect);
    const progress = Math.max(0, Math.min(1, 1 - effect.life / effect.duration));
    const large = effect.kind === "bomb" || effect.kind === "ko";
    const radius = effect.size * (large ? 2.2 : 1.1) * ease(progress);
    const remaining = Math.max(0.01, 1 - progress);
    view.root.position.set(effect.x, effect.y + 0.04, effect.z);
    view.ring.scale.set(Math.max(0.01, radius));
    view.ring.visible = progress < 0.7;
    for (const [i, particle] of view.particles.entries()) {
      const angle = (i / view.particles.length) * TAU + effect.id * 0.4;
      const vertical =
        effect.kind === "step" || effect.kind === "land"
          ? 0.12
          : Math.sin(progress * Math.PI) * (large ? 2.2 : 0.8);
      particle.position.set(
        Math.cos(angle) * radius,
        vertical * (0.5 + (i % 3) * 0.25),
        Math.sin(angle) * radius,
      );
      particle.scale.set(
        remaining * (large ? 0.18 : 0.08),
        remaining * (effect.kind === "clash" ? 0.36 : large ? 0.21 : 0.1),
        remaining * 0.07,
      );
      particle.rotation.set(angle + progress * 4, progress * 2, angle);
    }
  }

  render(state: GameState, dt: number): void {
    if (this.destroyed) return;
    this.adjustResolution(state);
    const visualDelta = state.phase === "paused" ? 0 : Math.min(dt, 0.05);
    this.time += visualDelta;
    // On the menu the arena slides right of the title panel (desktop) or above the menu copy (phone).
    const menu = state.phase === "menu";
    const sidePanel = this.width >= 900 || (this.height <= 570 && this.width > this.height);
    const panRight = menu && sidePanel ? MENU_PAN_RIGHT : 0;
    const panUp = !menu ? this.hudPanUp : this.width < 650 ? MENU_PAN_UP : 0;
    this.panRight += (panRight - this.panRight) * Math.min(1, dt * 4);
    this.panUp += (panUp - this.panUp) * Math.min(1, dt * 4);
    this.placeCamera();
    for (const floater of this.floaters) {
      floater.root.position.set(
        floater.x,
        floater.y + Math.sin(this.time * 0.35 + floater.phase) * 0.35,
        floater.z,
      );
      floater.root.rotation.y = Math.sin(this.time * 0.07 + floater.phase) * 0.05;
    }
    this.updateArena(state);
    const fighterIds = new Set(state.fighters.map((f) => f.id));
    for (const [id, view] of this.fighters) {
      if (!fighterIds.has(id)) {
        this.destroyFighter(view);
        this.fighters.delete(id);
      }
    }
    for (const fighter of state.fighters) this.updateFighter(fighter, visualDelta, state);
    const bombIds = new Set(state.bombs.map((b) => b.id));
    for (const [id, view] of this.bombs) {
      if (!bombIds.has(id)) {
        view.root.destroy({ children: true });
        view.label.destroy();
        this.bombs.delete(id);
      }
    }
    for (const bomb of state.bombs) this.updateBomb(bomb);
    const effectIds = new Set(state.effects.map((e) => e.id));
    for (const [id, view] of this.effects) {
      if (!effectIds.has(id)) {
        view.root.destroy({ children: true });
        this.effects.delete(id);
      }
    }
    for (const effect of state.effects) this.updateEffect(effect);
    this.app.render();
  }

  screenToWorld(clientX: number, clientY: number): Vec2 | null {
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.view.screenToWorld(
      {
        x: ((clientX - rect.left) * this.width) / rect.width,
        y: ((clientY - rect.top) * this.height) / rect.height,
      },
      this.ground,
    );
    return hit ? { x: hit.x, z: hit.z } : null;
  }

  projectWorld(x: number, y: number, z: number): { x: number; y: number } | null {
    const point = this.view.worldToScreen({ x, y, z });
    return point ? { x: point.x, y: point.y } : null;
  }

  private resize(): void {
    if (this.destroyed) return;
    this.width = Math.max(1, this.host.clientWidth || 1280);
    this.height = Math.max(1, this.host.clientHeight || 720);
    this.app.renderer.resize(this.width, this.height);
    this.background.width = this.width;
    this.background.height = this.height;
    this.view.width = this.width;
    this.view.height = this.height;
    const aspect = this.width / this.height;
    const pixelBudget = this.software ? 360_000 : 2_000_000;
    this.baseResolution = Math.min(
      window.devicePixelRatio || 1,
      1.5,
      Math.sqrt(pixelBudget / (this.width * this.height)),
    );
    this.setSceneResolution();
    const touch = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    const { top, bottom } = hudBand(this.height, touch);
    this.cameraScale = Math.max(
      (CAMERA_FIT_HEIGHT * this.height) / (this.height - top - bottom),
      CAMERA_FIT_WIDTH / aspect,
    );
    this.hudPanUp = (top - bottom) / 2 / this.height;
    this.placeCamera();
  }

  /** The only place the camera is positioned: pan the look-at target, then the fixed offset. */
  private placeCamera(): void {
    const s = this.cameraScale;
    const up = this.panUp * VIEW_HEIGHT * s;
    const right = ((this.panRight * VIEW_HEIGHT * s) / this.height) * this.width;
    const target = {
      x: CAMERA_RIGHT.x * right + CAMERA_UP.x * up,
      y: CAMERA_UP.y * up,
      z: CAMERA_RIGHT.z * right + CAMERA_UP.z * up,
    };
    this.view.camera.position.set(
      target.x + CAMERA_OFFSET.x * s,
      target.y + CAMERA_OFFSET.y * s,
      target.z + CAMERA_OFFSET.z * s,
    );
    this.view.camera.lookAt(target);
  }

  private adjustResolution(state: GameState): void {
    const now = performance.now();
    const elapsed = this.previousRenderAt ? now - this.previousRenderAt : 0;
    this.previousRenderAt = now;
    if (state.phase === "paused" || document.hidden || elapsed <= 0 || elapsed > 2000) return;
    this.sampleFrameTime += elapsed;
    this.sampleFrameCount++;
    if (this.sampleFrameCount < 24) return;
    const average = this.sampleFrameTime / this.sampleFrameCount;
    const minimum = this.software ? 0.65 : 0.6;
    if (average > 45 && this.qualityScale > minimum) {
      this.qualityScale = Math.max(minimum, this.qualityScale * 0.85);
      this.setSceneResolution();
    }
    this.sampleFrameCount = 0;
    this.sampleFrameTime = 0;
  }

  private setSceneResolution(): void {
    this.view.resolution = this.baseResolution * this.qualityScale;
    this.canvas.dataset.sceneResolution = this.view.resolution.toFixed(3);
  }

  private destroyFighter(view: FighterView): void {
    view.mesh.root.destroy({ children: true });
    view.mesh.shadow.destroy();
    view.mesh.footRing.destroy();
    view.label.destroy();
    view.stamina.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObserver.disconnect();
    this.view.destroy({ children: true });
    this.assets.destroy();
    this.skyTexture.destroy(true);
    this.app.destroy({ removeView: true }, { children: true });
  }
}
