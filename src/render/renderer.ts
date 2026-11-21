// Register 3D before app.init: Pixi loads the matching backend during initialization.
import {
  AmbientLight,
  Box,
  Container3D,
  DirectionalLight,
  Mesh3D,
  Plane,
  Vector3,
  View3D,
} from "@pixi/3d";
import type { Pass3D, ShadowQuality } from "@pixi/3d";
import { FxaaEffect, SsaoEffect } from "@pixi/3d/extras";
import { Application, Container, Graphics, RendererType, Sprite, Text, Texture } from "pixi.js";
import type { WebGLRenderer } from "pixi.js";
import { CAMERA_FORWARD, CAMERA_OFFSET, CAMERA_RIGHT } from "../game/coordinates";
import { effectiveSamples, MSAA_SAMPLES, resolutionScale } from "../game/settings";
import type { GraphicsSettings, MsaaSamples, ShadowLevel } from "../game/settings";
import type { Bomb, Effect, Fighter, GameState, Vec2 } from "../game/types";
import { MeshLibrary } from "./meshes";
import { FighterMotion } from "./motion";
import { PALETTE } from "./palette";
import type { MotionEvent } from "./motion";
import { applyFrame, createFighterRig, destroyFighterRig, RigAssets } from "./rig";
import type { FighterRig } from "./rig";
import { SwordTrail } from "./trail";

const TAU = Math.PI * 2;
/** Oblique look-down perspective camera; its direction is CAMERA_OFFSET (shared with input). */
const CAMERA_FOV = 37;
const CAMERA_NEAR = 0.3;
const CAMERA_FAR = 180;
/**
 * Camera distance multiplier = max(height fit, width fit). The height fit puts the arena's four
 * corners just inside the band the HUD leaves free (match heading on top; fighter cards, key
 * legend or touch controls at the bottom); the width fit keeps it across a portrait screen.
 * Both are tight on purpose: the fighters need to be large enough for their motion to read, and
 * anyone knocked far past the edge is on the way out anyway.
 */
const CAMERA_FIT_HEIGHT = 0.645;
const CAMERA_FIT_WIDTH = 1.16;
/** Pixel rows the HUD covers above and below the arena, following styles.css / touch.css. */
function hudBand(height: number, touch: boolean): { top: number; bottom: number } {
  // Short touch screens move the fighter cards to the top; the touch controls hug the corners.
  if (touch && height <= 570) return { top: 150, bottom: 70 };
  // Otherwise cards sit at the bottom, above the touch controls on touch screens.
  const bottom = touch ? Math.min(330, height * 0.4) : Math.min(250, height * 0.3);
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
/** The title screen stands a little further back so the arena clears the caption beside it. */
const MENU_PULL_BACK = 0.13;
/** Fighter facing (0 is +Z) that looks straight back at the camera. */
const FACING_CAMERA = Math.atan2(-CAMERA_FORWARD.x, -CAMERA_FORWARD.z);
const ease = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
type Vec3Like = { x: number; y: number; z: number };

const SHADOW_QUALITY: Record<Exclude<ShadowLevel, "off">, ShadowQuality> = {
  low: "low",
  medium: "medium",
  high: "high",
};
/** Scene pixels a software rasteriser can afford while dynamic resolution is on (today's budget). */
const SOFTWARE_PIXEL_BUDGET = 360_000;

/** Only affects rendering quality. Simulation, input, UI and test timing stay unchanged. */
export function hasSoftwareRenderer(): boolean {
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
  rig: FighterRig;
  motion: FighterMotion;
  trail: SwordTrail;
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
/** Render-only debris raised by the animation: dust, sparks and cracked flagstones. */
interface Impact {
  root: Container3D;
  parts: { mesh: Mesh3D; vx: number; vy: number; vz: number; spin: number; size: number }[];
  cracks: Mesh3D[];
  age: number;
  life: number;
  gravity: number;
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
  private readonly rigAssets = new RigAssets();
  private readonly impacts: Impact[] = [];
  /** Camera shake energy; decays every frame. */
  private shake = 0;
  /** Development aid: a fixed close-up camera for inspecting animation. */
  debugCamera: { position: Vec3Like; target: Vec3Like; fov?: number } | null = null;
  private width = 1280;
  private height = 720;
  private time = 0;
  private cameraScale = 1;
  /** Eased view pan along the camera's screen-right / screen-up axes, in fractions of the view. */
  private panRight = 0;
  private panUp = 0;
  private pullBack = 0;
  /** In play: the pan that centres the arena in the band between the top and bottom HUD. */
  private hudPanUp = 0;
  private lastElapsed = 0;
  private destroyed = false;
  private readonly software: boolean;
  private readonly sun: DirectionalLight;
  private settings: GraphicsSettings;
  private msaaSupport: { standard: MsaaSamples[]; hdr: MsaaSamples[] } = {
    standard: [],
    hdr: [],
  };
  private ssao: SsaoEffect | null = null;
  private fxaa: FxaaEffect | null = null;
  private shadowsActive = false;
  private maxRenderSizeCache = 0;
  private qualityScale = 1;
  private sceneScale = 1;
  private previousRenderAt = 0;
  private sampleFrameTime = 0;
  private sampleFrameCount = 0;

  private constructor(
    app: Application,
    host: HTMLElement,
    software: boolean,
    settings: GraphicsSettings,
  ) {
    this.app = app;
    this.host = host;
    this.software = software;
    this.settings = settings;
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
    gradient.addColorStop(0, PALETTE.sky.top);
    gradient.addColorStop(0.55, PALETTE.sky.middle);
    gradient.addColorStop(1, PALETTE.sky.bottom);
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
      shadowQuality: settings.shadows === "off" ? "medium" : SHADOW_QUALITY[settings.shadows],
      shadowFilter: "pcf",
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
    // Fixed shadow box around the arena (tiles span ±9, fighters jump a few units) so the
    // shadow map's texels are not spent on the far-off floating islands.
    const sun = new DirectionalLight({
      color: PALETTE.light.sun,
      intensity: 1.9,
      castShadow: false,
      shadow: {
        bounds: Box.fromCenterSize({ x: 0, y: 1.5, z: 0 }, { x: 20, y: 8, z: 20 }),
        normalBias: 0.03,
      },
    });
    this.sun = sun;
    sun.position.set(-10, 22, 14);
    this.view.root.addChild(sun);
    sun.lookAt({ x: 0, y: 0, z: 0 });
    const rim = new DirectionalLight({
      color: PALETTE.light.rim,
      intensity: 0.5,
      castShadow: false,
    });
    rim.position.set(12, 7, -12);
    this.view.root.addChild(rim);
    rim.lookAt({ x: 0, y: 1, z: 0 });
    // A strong, slightly blue fill keeps the shaded side of everything colourful.
    this.view.root.addChild(new AmbientLight({ color: PALETTE.light.ambient, intensity: 1.35 }));
    this.buildArena();
    this.buildScenery();
    this.scene.addChild(this.zone);
    this.zoneRing = this.assets.mesh(
      this.zone,
      this.assets.ring,
      this.assets.material(PALETTE.zone.ring, 0.95, 0.3),
    );
    this.zoneCore = this.assets.mesh(
      this.zone,
      this.assets.disc,
      this.assets.material(PALETTE.zone.core, 0.14),
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
        fill: PALETTE.zone.label,
        letterSpacing: 2,
      },
    });
    this.zoneMarker.anchor.set(0.5, 0.5);
    this.labels.addChild(this.zoneMarker);
    for (let i = 0; i < 8; i++) {
      const line = this.assets.box(this.scene, PALETTE.wind, 0, 0.2, 0, 0.035, 0.025, 0.9);
      line.material = this.assets.material(PALETTE.wind, 0.7, 0.2);
      line.visible = false;
      this.windLines.push(line);
    }
    this.readMsaaSupport();
    this.applySettings(settings, true);
    this.canvas.addEventListener("webglcontextrestored", this.handleContextRestored);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  static async create(
    host: HTMLElement,
    settings: GraphicsSettings,
    software = hasSoftwareRenderer(),
  ): Promise<ArenaRenderer> {
    const app = new Application();
    try {
      await app.init({
        preference: "webgl",
        width: host.clientWidth || 1280,
        height: host.clientHeight || 720,
        background: PALETTE.clear,
        // Context MSAA keeps the 2D labels smooth; the 3D scene's MSAA follows the settings.
        antialias: !software,
        autoDensity: true,
        // The canvas (2D labels) stays sharp; only the 3D view's resolution follows the settings.
        resolution: Math.min(window.devicePixelRatio || 1, software ? 1 : 2),
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
      return new ArenaRenderer(app, host, software, settings);
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
            ? PALETTE.floor.edgeDark
            : PALETTE.floor.edgeLight
          : (row + col) % 2
            ? PALETTE.floor.dark
            : PALETTE.floor.light;
        const top = a.mesh(root, a.tile, a.flatMaterial(tint));
        // Only takes effect while the shadow-receiving tile material is in use.
        top.receiveShadow = true;
        const outline = a.mesh(
          root,
          a.ring,
          a.material(PALETTE.floor.warnRing, 0.9, 0.2),
          0,
          0.025,
          0,
          0.75,
        );
        outline.visible = false;
        this.tiles.push({ root, top, outline, x, z, tint, fallenAt: null });
        if (border && (col + row) % 3 === 0) {
          const shard = a.mesh(
            root,
            a.cone,
            a.material(PALETTE.floor.shard),
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
          a.box(root, PALETTE.floor.inlay, -0.57, 0.006, -0.5, 0.34, 0.012, 0.045).rotation.y = 0.5;
          a.box(root, PALETTE.floor.inlay, -0.45, 0.007, -0.43, 0.18, 0.012, 0.045).rotation.y =
            -0.45;
        }
      }
    }
    // A pale compass is a useful reference for depth and directional inputs.
    a.mesh(this.scene, a.ring, a.material(PALETTE.floor.compass, 0.5), 0, 0.012, 0, 2.6);
    for (let i = 0; i < 4; i++) {
      const mark = a.box(
        this.scene,
        PALETTE.floor.compass,
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
      const rock = a.mesh(root, a.cone, a.material(PALETTE.island.rock), 0, -0.8, 0, 1.5, 2, 1.3);
      rock.rotation.z = Math.PI;
      a.mesh(root, a.cylinder, a.material(PALETTE.island.top), 0, 0.1, 0, 1.4, 0.21, 1.2);
      if (i % 2 === 0) {
        a.box(root, PALETTE.island.trunk, 0.1, 0.5, 0, 0.13, 0.8, 0.13);
        a.mesh(root, a.cone, a.material(PALETTE.island.blossom), 0.1, 1.05, 0, 0.66, 1.2, 0.62);
        a.mesh(
          root,
          a.cone,
          a.material(PALETTE.island.blossomLight),
          0.1,
          1.46,
          0,
          0.47,
          0.91,
          0.47,
        );
      }
      this.floaters.push({ root, x, y: y!, z, phase: i * 1.45 });
    });
    // Fat little clouds: [screen right, screen up (away from camera), height, size].
    const clouds = [
      [-15, 17, -4, 1.2],
      [14, 22, -5.5, 1.5],
      [-30, 11, -10, 2.1],
      [31, 9, -11, 1.9],
      [3, 38, -7, 1.6],
      [-21, -9, -13, 2.3],
      [22, -11, -15, 2.5],
    ];
    clouds.forEach(([right, up, y, size], i) => {
      const x = CAMERA_RIGHT.x * right! + CAMERA_FORWARD.x * up!;
      const z = CAMERA_RIGHT.z * right! + CAMERA_FORWARD.z * up!;
      const root = new Container3D();
      root.position.set(x, y!, z);
      root.scale.set(size!);
      root.rotation.y = FACING_CAMERA + (i % 2 ? 0.3 : -0.2);
      this.scenery.addChild(root);
      a.ball(root, PALETTE.cloud, 0, 0, 0, 1.5, 0.82, 1.1);
      a.ball(root, PALETTE.cloud, -1.15, -0.12, 0.15, 1, 0.6, 0.8);
      a.ball(root, PALETTE.cloud, 1.2, -0.08, -0.1, 1.1, 0.66, 0.86);
      a.ball(root, PALETTE.cloud, 0.3, 0.46, 0, 0.82, 0.6, 0.72);
      this.floaters.push({ root, x, y: y!, z, phase: 2.1 + i * 0.9 });
    });
    for (let i = 0; i < 24; i++) {
      const angle = (i / 24) * TAU;
      const distance = 14 + (i % 5) * 3;
      // The ring of specks is pushed away from the camera to fill the visible backdrop.
      const spark = a.mesh(
        this.scenery,
        a.pebble,
        a.material(PALETTE.speck, 0.8, 0.2),
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
      tile.top.material = a.tileMaterial(
        warning
          ? Math.sin(this.time * 7) > 0
            ? PALETTE.floor.warnA
            : PALETTE.floor.warnB
          : unsafe
            ? PALETTE.floor.unsafe
            : tile.tint,
        this.shadowsActive,
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
    const rig = createFighterRig(this.assets, this.rigAssets, this.scene, f);
    const motion = new FighterMotion();
    // On the pale floor a white smear would vanish: each blade trails its owner's colour.
    const trail = new SwordTrail(this.scene, f.color);
    const label = new Text({
      text: f.human ? "YOU" : f.name,
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 11,
        fontWeight: "800",
        fill: f.human ? PALETTE.label.you : PALETTE.label.text,
        letterSpacing: 1,
        dropShadow: { color: PALETTE.label.shadow, alpha: 0.65, blur: 3, distance: 1 },
      },
    });
    label.anchor.set(0.5, 1);
    const stamina = new Graphics();
    this.labels.addChild(stamina, label);
    view = { rig, motion, trail, label, stamina, identity };
    this.fighters.set(f.id, view);
    return view;
  }

  private updateFighter(f: Fighter, dt: number, state: GameState): void {
    const view = this.fighterView(f);
    const onPlatform =
      Math.abs(f.x) <= state.arena.halfSize && Math.abs(f.z) <= state.arena.halfSize;
    // Off duty on the title screen, until just before "FIGHT", and for whoever is left standing.
    const atEase =
      state.phase === "menu" ||
      (state.phase === "countdown" && state.countdown > 0.9) ||
      state.phase === "ended";
    // The simulation stops mid-action when the match ends; let the survivors stand down.
    const shown: Fighter =
      state.phase === "ended" && f.mode !== "dead"
        ? { ...f, mode: "idle", attack: null, hitstop: 0 }
        : f;
    const frame = view.motion.update(shown, dt, { floor: onPlatform, atEase });
    applyFrame(view.rig, frame, shown, this.time);
    view.trail.update(frame.bladeBase, frame.bladeTip, f.mode === "dead" ? 0 : frame.trail, dt);
    for (const event of frame.events) this.spawnImpact(event);
    // Showcase pose: face the camera, each turned a little toward the other (human is on the left).
    if (state.phase === "menu") view.rig.root.rotation.y = FACING_CAMERA + (f.human ? 0.42 : -0.36);
    // The blob is a stand-in for a shadow; with real shadow maps it would double up.
    view.rig.shadow.visible &&= onPlatform && !this.shadowsActive;
    view.rig.footRing.visible &&= onPlatform;
    view.rig.heading.visible &&= onPlatform && state.phase !== "menu";
    const point = this.view.worldToScreen({ x: f.x, y: Math.max(f.y, -1) + 2.65, z: f.z });
    const labelVisible = f.mode !== "dead" && point !== null;
    view.label.visible = labelVisible;
    view.stamina.visible = labelVisible;
    if (point) {
      view.label.position.set(point.x, point.y);
      view.label.text = f.human ? "YOU" : `${f.name}  ${Math.round(f.damage)}%`;
      view.label.style.fill =
        f.outsideTime > 0.5
          ? PALETTE.label.outside
          : f.human
            ? PALETTE.label.you
            : PALETTE.label.text;
      view.stamina
        .clear()
        .roundRect(
          point.x - view.label.width / 2 - 6,
          point.y - view.label.height - 4,
          view.label.width + 12,
          view.label.height + 8,
          4,
        )
        .fill({ color: PALETTE.label.ink, alpha: 0.9 });
      if (state.phase !== "menu")
        view.stamina
          .roundRect(point.x - 19, point.y + 5, 38, 3, 1.5)
          .fill({ color: PALETTE.label.ink, alpha: 0.75 });
      if (state.phase !== "menu")
        view.stamina
          .roundRect(point.x - 19, point.y + 5, Math.max(0.1, (38 * f.stamina) / 100), 3, 1.5)
          .fill({ color: f.stamina < 25 ? PALETTE.label.staminaLow : PALETTE.label.stamina });
    }
  }

  private bombView(bomb: Bomb): BombView {
    let entry = this.bombs.get(bomb.id);
    if (entry) return entry;
    const a = this.assets;
    const root = new Container3D();
    this.scene.addChild(root);
    const ring = a.mesh(
      root,
      a.ring,
      a.material(PALETTE.bomb.ring, 0.95, 0.6),
      0,
      0.065,
      0,
      bomb.radius,
    );
    const fill = a.mesh(
      root,
      a.disc,
      a.material(PALETTE.bomb.fill, 0.28, 0.2),
      0,
      0.055,
      0,
      bomb.radius,
      1,
      bomb.radius,
    );
    for (const turn of [0, Math.PI / 2]) {
      const cross = a.box(root, PALETTE.bomb.cross, 0, 0.07, 0, 0.045, 0.025, 0.48);
      cross.rotation.y = turn;
    }
    const comet = new Container3D();
    root.addChild(comet);
    a.mesh(comet, a.pebble, a.material(PALETTE.bomb.rock), 0, 0, 0, 0.35);
    a.mesh(comet, a.cone, a.material(PALETTE.bomb.flame, 0.8, 1), 0, 0.7, 0, 0.36, 1.7, 0.36);
    a.mesh(comet, a.cone, a.material(PALETTE.bomb.flameCore, 0.9, 1), 0, 0.47, 0, 0.18, 1.1, 0.18);
    const label = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 11,
        fontWeight: "800",
        fill: PALETTE.bomb.label,
        dropShadow: { color: 0xffffff, blur: 3, alpha: 0.95, distance: 0 },
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
    // The simulation tags effects with pale tints from the old night scene; on the bright floor
    // each kind gets a colour that reads. Steps, throws and knock-outs keep the fighter's own.
    const color =
      effect.kind === "clash"
        ? PALETTE.fx.clash
        : effect.kind === "bomb"
          ? PALETTE.fx.blast
          : effect.kind === "hit"
            ? effect.size > 1.15
              ? PALETTE.fx.hitHeavy
              : PALETTE.fx.hit
            : effect.kind === "jump" || effect.kind === "land" || effect.kind === "cancel"
              ? PALETTE.fx.dust
              : effect.color;
    const material = a.material(color, 1, 0.55);
    const count =
      effect.kind === "ko" || effect.kind === "bomb" ? 12 : effect.kind === "clash" ? 10 : 6;
    const particles = Array.from({ length: count }, (_, i) =>
      a.mesh(root, i % 2 ? a.cube : a.pebble, material, 0, 0, 0, 0.08, 0.08, 0.08),
    );
    const ring = a.mesh(root, a.ring, a.material(color, 0.65, 0.4));
    view = { root, particles, ring };
    this.effects.set(effect.id, view);
    // The first frame an impact exists is the frame the screen feels it.
    if (effect.kind === "hit") this.addShake(0.3 + effect.size * 0.32);
    else if (effect.kind === "clash") this.addShake(0.6);
    else if (effect.kind === "bomb") this.addShake(0.85);
    else if (effect.kind === "ko") this.addShake(0.7);
    else if (effect.kind === "throw") this.addShake(0.28);
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
    this.pullBack += ((menu ? MENU_PULL_BACK : 0) - this.pullBack) * Math.min(1, dt * 4);
    this.shake *= Math.exp(-visualDelta * 9);
    if (this.shake < 0.004 || state.phase === "menu") this.shake = 0;
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
    this.updateImpacts(visualDelta);
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
    const s = this.cameraScale * (1 + this.pullBack);
    const up = this.panUp * VIEW_HEIGHT * s;
    const right = ((this.panRight * VIEW_HEIGHT * s) / this.height) * this.width;
    const target = {
      x: CAMERA_RIGHT.x * right + CAMERA_UP.x * up,
      y: CAMERA_UP.y * up,
      z: CAMERA_RIGHT.z * right + CAMERA_UP.z * up,
    };
    if (this.debugCamera) {
      const { position, target: aim, fov } = this.debugCamera;
      this.view.camera.fov = fov ?? CAMERA_FOV;
      this.view.camera.position.set(position.x, position.y, position.z);
      this.view.camera.lookAt(aim);
      return;
    }
    this.view.camera.fov = CAMERA_FOV;
    // Impact shake: a decaying jolt along the screen axes, so the horizon never rolls.
    if (this.shake > 0 && this.settings.cameraShake) {
      const amount = Math.min(0.5, this.shake) * 0.55 * s;
      const jx = Math.sin(this.time * 83.1) * amount;
      const jy = Math.cos(this.time * 97.3) * amount;
      target.x += CAMERA_RIGHT.x * jx + CAMERA_UP.x * jy;
      target.y += CAMERA_UP.y * jy;
      target.z += CAMERA_RIGHT.z * jx + CAMERA_UP.z * jy;
    }
    this.view.camera.position.set(
      target.x + CAMERA_OFFSET.x * s,
      target.y + CAMERA_OFFSET.y * s,
      target.z + CAMERA_OFFSET.z * s,
    );
    this.view.camera.lookAt(target);
  }

  private addShake(amount: number): void {
    this.shake = Math.min(1, Math.max(this.shake, amount));
  }

  /** Dust, sparks and cracks the animation raises. Never read by the simulation. */
  private spawnImpact(event: MotionEvent): void {
    if (this.impacts.length > 40) return;
    const a = this.assets;
    const root = new Container3D();
    root.position.set(event.x, Math.max(0, event.y), event.z);
    this.scene.addChild(root);
    const impact: Impact = { root, parts: [], cracks: [], age: 0, life: 0.5, gravity: 9 };
    const seed = (event.x * 12.9898 + event.z * 78.233 + this.time * 37.7) % 1;
    const random = (i: number) => {
      const v = Math.sin((seed + i * 0.6180339) * 43758.5453) * 0.5 + 0.5;
      return v - Math.floor(v);
    };
    const burst = (
      count: number,
      color: number,
      speed: number,
      rise: number,
      size: number,
      glow = 0,
    ) => {
      const material = a.material(color, glow > 0 ? 1 : 0.85, glow);
      for (let i = 0; i < count; i++) {
        const angle = ((i + random(i)) / count) * TAU;
        const push = speed * (0.6 + random(i + 9) * 0.6);
        const mesh = a.mesh(root, i % 2 ? a.pebble : a.cube, material, 0, 0.05, 0, size);
        impact.parts.push({
          mesh,
          vx: Math.cos(angle) * push,
          vy: rise * (0.5 + random(i + 3) * 0.8),
          vz: Math.sin(angle) * push,
          spin: (random(i + 5) - 0.5) * 14,
          size: size * (0.7 + random(i + 7) * 0.7),
        });
      }
    };
    switch (event.kind) {
      case "slam": {
        impact.life = 1.5;
        burst(6, PALETTE.fx.dustLight, 2.6 + event.power * 2.2, 3.2, 0.09);
        burst(6, PALETTE.fx.dust, 2.2 + event.power * 2, 2.8, 0.085);
        burst(5, PALETTE.fx.chip, 1.6, 4.4, 0.06);
        for (let i = 0; i < 6; i++) {
          const angle = (i / 6) * TAU + random(i + 20) * 0.8;
          const length = (0.45 + random(i + 30) * 0.7) * (0.7 + event.power * 0.6);
          const crack = a.box(
            root,
            PALETTE.fx.crack,
            Math.sin(angle) * length * 0.5,
            0.012,
            Math.cos(angle) * length * 0.5,
            0.055,
            0.012,
            length,
          );
          crack.rotation.y = angle;
          impact.cracks.push(crack);
        }
        this.addShake(0.4 + event.power * 0.45);
        break;
      }
      case "land":
        impact.life = 0.45;
        burst(
          Math.round(2 + event.power * 3),
          PALETTE.fx.dustLight,
          1.3 + event.power * 2,
          0.9,
          0.065,
        );
        burst(Math.round(2 + event.power * 3), PALETTE.fx.dust, 1.1 + event.power * 2, 0.8, 0.06);
        if (event.power > 0.5) this.addShake(event.power * 0.3);
        break;
      case "stomp":
        impact.life = 0.35;
        burst(3, PALETTE.fx.dustLight, 1.5, 0.8, 0.055);
        burst(3, PALETTE.fx.dust, 1.3, 0.7, 0.05);
        this.addShake(0.1 + event.power * 0.12);
        break;
      case "scrape":
        impact.life = 0.3;
        impact.gravity = 14;
        burst(2, PALETTE.fx.spark, 1.8, 3.4, 0.04, 0.8);
        break;
      case "skid":
        impact.life = 0.3;
        burst(2, PALETTE.fx.dust, 0.7, 0.7, 0.045);
        break;
    }
    this.impacts.push(impact);
  }

  private updateImpacts(dt: number): void {
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const impact = this.impacts[i]!;
      impact.age += dt;
      const t = impact.age / impact.life;
      if (t >= 1) {
        impact.root.destroy({ children: true });
        this.impacts.splice(i, 1);
        continue;
      }
      // Debris is gone in the first third; the cracks linger and close.
      const flight = Math.min(1, impact.age / Math.min(impact.life, 0.5));
      for (const part of impact.parts) {
        part.vy -= impact.gravity * dt;
        const drag = Math.exp(-dt * 3.5);
        part.vx *= drag;
        part.vz *= drag;
        const p = part.mesh.position;
        const y = Math.max(0.03, p.y + part.vy * dt);
        part.mesh.position.set(p.x + part.vx * dt, y, p.z + part.vz * dt);
        part.mesh.rotation.y += part.spin * dt;
        part.mesh.rotation.x += part.spin * 0.6 * dt;
        part.mesh.scale.set(Math.max(0.001, part.size * (1 - flight)));
      }
      for (const crack of impact.cracks) {
        const open = t < 0.06 ? t / 0.06 : 1 - Math.pow(t, 3);
        crack.scale.x = Math.max(0.001, 0.055 * open);
      }
    }
  }

  private adjustResolution(state: GameState): void {
    const now = performance.now();
    const elapsed = this.previousRenderAt ? now - this.previousRenderAt : 0;
    this.previousRenderAt = now;
    if (!this.settings.dynamicResolution) return;
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

  /**
   * 3D scene texels per CSS pixel: the resolution preset (by the view's short side), lowered by
   * the dynamic scale, doubled for SSAA, and kept inside the GPU's texture and renderbuffer limit.
   * The canvas, and with it every 2D label, keeps its own resolution.
   */
  private setSceneResolution(): void {
    const { width, height, settings } = this;
    const limit = this.maxRenderSize() / Math.max(width, height);
    let scale = resolutionScale(
      settings.resolution,
      Math.min(width, height),
      window.devicePixelRatio || 1,
    );
    if (settings.dynamicResolution) {
      // A software rasteriser starts within the pixel budget it has always had.
      if (this.software)
        scale = Math.min(
          scale,
          this.app.renderer.resolution,
          Math.sqrt(SOFTWARE_PIXEL_BUDGET / (width * height)),
        );
      scale *= this.qualityScale;
    }
    this.sceneScale = Math.min(scale, limit);
    const resolution =
      settings.antialiasing === "ssaa" ? Math.min(this.sceneScale * 2, limit) : this.sceneScale;
    this.view.resolution = resolution;
    this.canvas.dataset.sceneResolution = resolution.toFixed(3);
  }

  private maxRenderSize(): number {
    if (this.maxRenderSizeCache) return this.maxRenderSizeCache;
    let size = 8192;
    if (this.app.renderer.type === RendererType.WEBGL) {
      const { gl } = this.app.renderer as WebGLRenderer;
      size = Math.min(
        size,
        gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
        gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      );
    }
    // A lost context reports 0; fall back without caching so a restore reads the real limit.
    if (!size) return 4096;
    this.maxRenderSizeCache = size;
    return size;
  }

  /**
   * Applies graphics settings; only what changed since the last call is touched unless `force`.
   * Safe to call at any time, including every frame.
   */
  applySettings(settings: GraphicsSettings, force = false): void {
    const previous = this.settings;
    this.settings = settings;
    if (this.destroyed) return;
    const view = this.view;

    if (
      force ||
      previous.resolution !== settings.resolution ||
      previous.antialiasing !== settings.antialiasing ||
      previous.dynamicResolution !== settings.dynamicResolution
    ) {
      // A new choice starts from full quality; the dynamic scale measures it afresh.
      this.qualityScale = 1;
      this.sampleFrameCount = 0;
      this.sampleFrameTime = 0;
      this.setSceneResolution();
    }

    if (force || previous.shadows !== settings.shadows) {
      const enabled = settings.shadows !== "off";
      if (enabled)
        view.shadowQuality = SHADOW_QUALITY[settings.shadows as Exclude<ShadowLevel, "off">];
      this.sun.castShadow = enabled;
      this.shadowsActive = enabled;
    }

    if (
      force ||
      previous.ambientOcclusion !== settings.ambientOcclusion ||
      previous.antialiasing !== settings.antialiasing ||
      previous.msaaSamples !== settings.msaaSamples
    ) {
      const samples =
        settings.antialiasing === "msaa"
          ? effectiveSamples(settings.msaaSamples, this.supportedMsaa(settings.ambientOcclusion))
          : undefined;
      if (this.app.renderer.type === RendererType.WEBGL) {
        // The view composites, so its scene buffer follows this flag when the graph is rebuilt
        // (assigning `passes` below always rebuilds it). The patched pixi.js reads the count.
        this.app.renderer.view.antialias = samples !== undefined;
        if (samples) (this.app.renderer as WebGLRenderer).texture.msaaSamples = samples;
      }
      const passes: Pass3D[] = [];
      if (settings.ambientOcclusion && this.canRenderFloat()) {
        this.ssao ??= new SsaoEffect({ radius: 0.45, intensity: 1.15 });
        passes.push(this.ssao);
      }
      if (settings.antialiasing === "fxaa") {
        this.fxaa ??= new FxaaEffect();
        passes.push(this.fxaa);
      }
      view.passes = passes;
    }
  }

  /** MSAA sample counts this GPU can use for the scene buffer (float buffers while SSAO is on). */
  supportedMsaa(ambientOcclusion = this.settings.ambientOcclusion): readonly MsaaSamples[] {
    return ambientOcclusion && this.canRenderFloat()
      ? this.msaaSupport.hdr
      : this.msaaSupport.standard;
  }

  /** Whether SSAO can run (it needs float render targets). */
  get supportsAmbientOcclusion(): boolean {
    return this.canRenderFloat();
  }

  /** The 3D scene's drawn size in pixels, before SSAA's 2× supersampling. */
  get renderSize(): { width: number; height: number } {
    return {
      width: Math.max(1, Math.round(this.width * this.sceneScale)),
      height: Math.max(1, Math.round(this.height * this.sceneScale)),
    };
  }

  /** Whether the sun currently casts real shadow maps (the fake blob shadows are hidden then). */
  get realShadows(): boolean {
    return this.shadowsActive;
  }

  /** The player's screen-shake preference, for impact effects. */
  get cameraShake(): boolean {
    return this.settings.cameraShake;
  }

  private readMsaaSupport(): void {
    if (this.app.renderer.type !== RendererType.WEBGL) {
      // WebGPU supports 4x only.
      this.msaaSupport = { standard: [4], hdr: [4] };
      return;
    }
    const { gl } = this.app.renderer as WebGLRenderer;
    const counts = (format: number): Int32Array =>
      (gl.getInternalformatParameter(gl.RENDERBUFFER, format, gl.SAMPLES) as Int32Array | null) ??
      new Int32Array();
    const depth = counts(gl.DEPTH24_STENCIL8);
    const color = counts(gl.RGBA8);
    const standard = MSAA_SAMPLES.filter((n) => depth.includes(n) && color.includes(n));
    const hdrColor = this.canRenderFloat() ? counts(gl.RGBA16F) : new Int32Array();
    this.msaaSupport = { standard, hdr: standard.filter((n) => hdrColor.includes(n)) };
  }

  private canRenderFloat(): boolean {
    const renderer = this.app.renderer;
    if (renderer.type !== RendererType.WEBGL) return true;
    return Boolean((renderer as WebGLRenderer).context.extensions.colorBufferFloat);
  }

  private readonly handleContextRestored = (): void => {
    this.maxRenderSizeCache = 0;
    this.readMsaaSupport();
    this.applySettings(this.settings, true);
  };

  private destroyFighter(view: FighterView): void {
    destroyFighterRig(view.rig);
    view.trail.destroy();
    view.label.destroy();
    view.stamina.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);

    this.view.destroy({ children: true });
    this.ssao?.destroy();
    this.fxaa?.destroy();
    for (const impact of this.impacts) impact.root.destroy({ children: true });
    this.impacts.length = 0;
    this.rigAssets.destroy();
    this.assets.destroy();
    this.skyTexture.destroy(true);
    this.app.destroy({ removeView: true }, { children: true });
  }
}
