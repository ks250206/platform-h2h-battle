// Register 3D before app.init: Pixi loads the matching backend during initialization.
import {
  AmbientLight,
  Box,
  Container3D,
  DirectionalLight,
  Mesh3D,
  Plane,
  TorusGeometry,
  Vector3,
  View3D,
} from "@pixi/3d";
import type { Pass3D, ShadowQuality } from "@pixi/3d";
import { FxaaEffect, SsaoEffect } from "@pixi/3d/extras";
import { drawTrainingDebug } from "./trainingDebug";
import { Application, Container, Graphics, RendererType, Sprite, Text, Texture } from "pixi.js";
import type { WebGLRenderer } from "pixi.js";
import { canStandAt } from "../game/combat";
import { CAMERA_FORWARD, CAMERA_OFFSET, CAMERA_RIGHT } from "../game/coordinates";
import {
  countHumans,
  fighterTag,
  sharesName,
  SLOT_SHAPE_POINTS,
  slotShape,
} from "../game/identity";
import { effectiveSamples, MSAA_SAMPLES, resolutionScale } from "../game/settings";
import type { GraphicsSettings, MsaaSamples, ShadowLevel } from "../game/settings";
import type { Bomb, Effect, Fighter, GameState, Vec2 } from "../game/types";
import { combatCue } from "./combatCues";
import { MeshLibrary } from "./meshes";
import { norm, qLook } from "./math3";
import { FighterMotion } from "./motion";
import { PALETTE } from "./palette";
import type { MotionEvent } from "./motion";
import { applyFrame, createFighterRig, destroyFighterRig, rigIdentity, RigAssets } from "./rig";
import type { FighterRig } from "./rig";
import type { PresentationEvent } from "../game/presentation";
import { FinishFx } from "./finishFx";
import { StageShapes, StageView } from "./stageMesh";
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
/** Sine and cosine of the camera's elevation: how ground depth and height foreshorten on screen. */
const CAMERA_SIN = CAMERA_OFFSET.y / CAMERA_DISTANCE;
const CAMERA_COS = Math.hypot(CAMERA_OFFSET.x, CAMERA_OFFSET.z) / CAMERA_DISTANCE;
/**
 * Follow camera: it frames every fighter still standing, closing in when they are together and
 * backing off to the whole arena when they spread out.
 */
const FOLLOW_MIN_SCALE = 0.5;
/** World units kept clear around the fighters: room for a swing, and for a knock-back to start. */
const FOLLOW_MARGIN_X = 3.6;
const FOLLOW_MARGIN_Y = 2.2;
/** Part of the screen width the fight may use; the rest is breathing room at the sides. */
const FOLLOW_USABLE_WIDTH = 0.84;
/** Fighter facing (0 is +Z) that looks straight back at the camera. */
const FACING_CAMERA = Math.atan2(-CAMERA_FORWARD.x, -CAMERA_FORWARD.z);
/** Where the camera is, for the slot markers that always face it. */
const MARKER_CAMERA = { yaw: FACING_CAMERA, pitch: Math.asin(CAMERA_SIN) };
/**
 * Title screen close-up of the fighter whose look is being chosen: the share of the view's height
 * its body takes on a wide screen, and the floor width a narrow one must still show around it.
 */
const SPOTLIGHT_HEIGHT_SHARE = 0.3;
const SPOTLIGHT_MIN_WIDTH = 4.2;
/**
 * A standing fighter, ear tips included, and the height the close-up centres on: above the
 * middle, which leaves room over the head for the label and keeps it clear of the top bar.
 */
const FIGHTER_HEIGHT = 2.1;
const SPOTLIGHT_AIM = 1.4;
/** The close-up's pan where the look picker docks along the bottom of a narrow screen. */
const SPOTLIGHT_PAN_UP = -0.23;
/**
 * Height of the label over a fighter. A human's sits above the slot marker floating over its head
 * (`rig.ts`), with a few pixels between the two for the stamina bar.
 */
const LABEL_HEIGHT = 2.65;
const LABEL_HEIGHT_MARKED = 2.9;
const LABEL_MARKER_GAP = 10;
/** Half the size, in pixels, of the slot shape drawn in the label over a fighter. */
const LABEL_GLYPH = 5;
const LABEL_GLYPH_GAP = 5;
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

interface FighterView {
  rig: FighterRig;
  motion: FighterMotion;
  trail: SwordTrail;
  /** Showing respawn protection (blinking). */
  protected: boolean;
  label: Text;
  stamina: Graphics;
  identity: string;
  /** Title screen: when a new look replaced the old one (a little pop), and the close-up's share. */
  changedAt: number;
  featured: number;
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
/** A streak of hot metal: drawn stretched along the way it is flying. */
interface Spark {
  mesh: Mesh3D;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  width: number;
}
/** A crackle of static: a jagged line that jumps to a new shape every few frames. */
interface Bolt {
  segments: Mesh3D[];
  reach: number;
  until: number;
  redrawAt: number;
  seed: number;
}
interface Impact {
  root: Container3D;
  parts: { mesh: Mesh3D; vx: number; vy: number; vz: number; spin: number; size: number }[];
  cracks: Mesh3D[];
  sparks: Spark[];
  bolts: Bolt[];
  /** Rings opening from radius `from` to `to` over the impact's life. */
  rings: { mesh: Mesh3D; from: number; to: number }[];
  /** Speed lines sliding along the floor, thinning as they go. */
  streaks: { mesh: Mesh3D; vx: number; vz: number; length: number }[];
  flash: Mesh3D | null;
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
  private previousState: GameState | null = null;
  private readonly trainingDebug = new Graphics();
  private readonly labels = new Container();
  private readonly assets = new MeshLibrary();
  private readonly stageShapes = new StageShapes();
  /** The floor being shown; rebuilt whenever the state's stage is another one. */
  private stage: StageView | null = null;
  /** Runs only while belts do (not while paused or after the match), so their arrows stop too. */
  private beltTime = 0;
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
  private readonly destination: Mesh3D;
  private readonly zonePath: Mesh3D;
  private readonly zoneArrow: Mesh3D;
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
  /** A thicker ring than the library's, for the invulnerable-dodge rings. */
  private readonly evadeRing = new TorusGeometry({
    radius: 1,
    tube: 0.05,
    radialSegments: 4,
    tubularSegments: 40,
  });
  /**
   * Each slot's dodge count (`playerStats`) when last drawn. It rises exactly when a sword or a
   * bomb passes through a fighter's invulnerable step, on whatever tick that happened, so the
   * dodge is shown even when several ticks fall between two frames.
   */
  private readonly dodgesSeen = new Map<number, number>();
  /** KO and finish highlights (finishFx.ts). */
  private readonly finishFx: FinishFx;
  private arenaHalfSize = 7;
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
  /** Share of the screen height the HUD leaves free for the arena. */
  private usableHeight = 0.6;
  /** What the camera is looking at and from how far, eased every frame. */
  private focusRight = 0;
  private focusUp = 0;
  private viewScale = 0;
  private lastElapsed = 0;
  /** Humans in the match being drawn: decides between "YOU" and player numbers. */
  private humanCount = 1;
  /** Title screen: the slot shown in close-up while its look is chosen, or null for the line-up. */
  private spotlight: number | null = null;
  private spotlightSince = 0;
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
    app.stage.addChild(this.view, this.trainingDebug, this.labels);
    this.view.root.addChild(this.scenery, this.scene);
    this.finishFx = new FinishFx(this.scene, this.assets);
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
    const routeInk = this.assets.material(PALETTE.zone.label, 1, 0.3);
    this.destination = this.assets.mesh(this.scene, this.assets.dashedRing, routeInk);
    this.zonePath = this.assets.mesh(this.scene, this.assets.cube, routeInk);
    this.zoneArrow = this.assets.mesh(this.scene, this.stageShapes.chevron, routeInk);
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

  /**
   * Shows the stage the match is on. The floor is built from the stage's tiles (stageMesh.ts),
   * so picking another stage on the title screen swaps the whole island under the fighters.
   */
  private showStage(state: GameState): StageView {
    const { stageId } = state.arena;
    if (this.stage?.stageId === stageId) return this.stage;
    this.stage?.destroy();
    this.stage = new StageView(this.assets, this.stageShapes, stageId);
    // Under everything else in the scene: zone, bombs and fighters draw over the floor.
    this.scene.addChildAt(this.stage.root, 0);
    this.canvas.dataset.stage = stageId;
    return this.stage;
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
    const reset = state.elapsed < this.lastElapsed;
    const safe = state.arena.safeZone;
    this.showStage(state).update(state, this.time, this.beltTime, this.shadowsActive, reset);
    this.zone.visible = safe.active;
    this.zone.position.set(safe.x, 0.045, safe.z);
    this.zoneRing.scale.set(safe.radius);
    this.zoneCore.scale.set(safe.radius, 1, safe.radius);
    const target = safe.destination;
    this.destination.visible = this.zonePath.visible = safe.active && target !== null;
    this.zoneArrow.visible = false;
    if (target) {
      this.destination.position.set(target.x, 0.075, target.z);
      this.destination.scale.set(target.radius, 1, target.radius);
      const dx = target.x - safe.x;
      const dz = target.z - safe.z;
      const length = Math.hypot(dx, dz);
      this.zonePath.position.set((target.x + safe.x) / 2, 0.08, (target.z + safe.z) / 2);
      this.zonePath.scale.set(0.07, 0.02, length);
      this.zonePath.rotation.y = Math.atan2(dx, dz);
      this.zoneArrow.visible = safe.active && length > 0.3;
      this.zoneArrow.position.set(safe.x + dx * 0.7, 0.1, safe.z + dz * 0.7);
      this.zoneArrow.scale.set(Math.min(1, length));
      this.zoneArrow.rotation.y = this.zonePath.rotation.y;
    }
    // Label the far edge of the ring, the one leaning away from the camera.
    const far = safe.radius - 0.4;
    const marker = this.view.worldToScreen({
      x: safe.x + CAMERA_FORWARD.x * far,
      y: 0.1,
      z: safe.z + CAMERA_FORWARD.z * far,
    });
    this.zoneMarker.visible = safe.active && marker !== null;
    if (marker) this.zoneMarker.position.set(marker.x, marker.y);
    for (const [i, line] of this.windLines.entries()) {
      line.visible = state.arena.windActive;
      const progress = (this.time * 0.6 + i * 0.19) % 1;
      line.position.set(-8 + progress * 16, 0.2 + (i % 3) * 0.3, -6 + (i % 7) * 2);
      line.rotation.y = Math.atan2(state.arena.wind.x, state.arena.wind.z);
    }
    this.lastElapsed = state.elapsed;
  }

  /**
   * Title screen only: frames `slot` in close-up (and turns it slowly) while its look is being
   * chosen, so the finished fighter can be judged before the match. Null returns to the line-up.
   */
  setSpotlight(slot: number | null): void {
    if (slot === this.spotlight) return;
    this.spotlight = slot;
    this.spotlightSince = this.time;
  }

  /**
   * What floats over a human: "YOU" for a lone player, the player number when several share the
   * screen. Empty for a CPU.
   */
  private playerTag(f: Fighter): string {
    return f.human ? fighterTag(f, this.humanCount) : "";
  }

  /** A lone player is the sunny one; several each wear their fighter's colour. */
  private tagColor(f: Fighter): number {
    return this.humanCount > 1 ? f.color : PALETTE.label.you;
  }

  /**
   * The words over a fighter. A human is its tag (YOU, P1...). A CPU is its name and damage, or
   * its tag (CPU 02) when another fighter has the same name. The title screen shows both, so each
   * row of the menu can be matched to its fighter.
   */
  private labelText(f: Fighter, state: GameState): string {
    const tag = fighterTag(f, this.humanCount);
    if (state.phase === "menu") return `${tag}  ${f.name}`;
    if (f.human) return tag;
    return `${sharesName(f, state.fighters) ? tag : f.name}  ${Math.round(f.damage)}%`;
  }

  private fighterView(f: Fighter): FighterView {
    const tag = this.playerTag(f);
    // The look (animal, colours, accessory, slot shape) and whose it is.
    const identity = `${rigIdentity(f)}/${tag}`;
    let view = this.fighters.get(f.id);
    const previous = view && view.identity !== identity ? view : undefined;
    if (previous) {
      this.destroyFighter(previous);
      this.fighters.delete(f.id);
      view = undefined;
    }
    if (view) return view;
    const rig = createFighterRig(
      this.assets,
      this.rigAssets,
      this.scene,
      f,
      this.humanCount > 1 ? f.color : undefined,
      MARKER_CAMERA,
    );
    // A new look on the same fighter keeps its pose: only the meshes are swapped.
    const motion = previous?.motion ?? new FighterMotion();
    // On the pale floor a white smear would vanish: each blade trails its owner's colour.
    const trail = new SwordTrail(this.scene, f.color);
    const label = new Text({
      text: tag || f.name,
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 11,
        fontWeight: "800",
        fill: f.human ? this.tagColor(f) : PALETTE.label.text,
        letterSpacing: 1,
        dropShadow: { color: PALETTE.label.shadow, alpha: 0.65, blur: 3, distance: 1 },
      },
    });
    label.anchor.set(0.5, 1);
    const stamina = new Graphics();
    this.labels.addChild(stamina, label);
    view = {
      rig,
      motion,
      trail,
      protected: false,
      label,
      stamina,
      identity,
      changedAt: previous ? this.time : -Infinity,
      featured: previous?.featured ?? 0,
    };
    this.fighters.set(f.id, view);
    return view;
  }

  private updateFighter(f: Fighter, dt: number, state: GameState): void {
    const view = this.fighterView(f);
    // Over floor that is really there: no blob shadow or foot ring above a pit or a gap.
    const onPlatform = canStandAt(state, f.x, f.z);
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
    // How the combat state reads (combatCues.ts): read from this frame's state, never smoothed.
    const cue = combatCue(shown, this.time);
    applyFrame(view.rig, frame, shown, this.time, cue);
    view.trail.update(frame.bladeBase, frame.bladeTip, f.mode === "dead" ? 0 : frame.trail, dt);
    for (const event of frame.events) this.spawnImpact(event);
    if (state.phase === "menu") {
      // Showcase pose: face the camera, each turned a little toward the middle of the line-up.
      const across = f.x * CAMERA_RIGHT.x + f.z * CAMERA_RIGHT.z;
      const turn = Math.max(-1, Math.min(1, -across / 2.8)) * 0.4;
      // The fighter in close-up turns slowly from side to side, so its back can be seen too.
      view.featured += ((this.spotlight === f.id ? 1 : 0) - view.featured) * Math.min(1, dt * 5);
      const sway = Math.sin((this.time - this.spotlightSince) * 0.85) * 0.85;
      view.rig.root.rotation.y = FACING_CAMERA + turn * (1 - view.featured) + sway * view.featured;
      // A freshly chosen look arrives with a small pop.
      const age = (this.time - view.changedAt) / 0.26;
      view.rig.root.scale.set(age < 1 ? 1 + Math.sin(age * Math.PI) * 0.07 : 1);
    } else if (view.rig.root.scale.x !== 1) view.rig.root.scale.set(1);
    // The blob is a stand-in for a shadow; with real shadow maps it would double up.
    // Back from a knock-out: the body blinks for as long as nothing can touch it.
    if (f.invulnerable > 1) view.protected = true;
    else if (f.invulnerable <= 0 || f.mode === "dead") view.protected = false;
    view.rig.squash.visible = !view.protected || Math.floor(this.time * 11) % 2 === 0;
    view.rig.shadow.visible &&= onPlatform && !this.shadowsActive;
    view.rig.footRing.visible &&= onPlatform;
    view.rig.brokenRing.visible &&= onPlatform;
    view.rig.badge.visible &&= onPlatform;
    view.rig.heading.visible &&= onPlatform && state.phase !== "menu";
    const point = this.view.worldToScreen({
      x: f.x,
      y: Math.max(f.y, -1) + (f.human ? LABEL_HEIGHT_MARKED : LABEL_HEIGHT),
      z: f.z,
    });
    // The stamina bar hangs under the label: it goes between the label and a human's marker.
    if (point && f.human) point.y -= state.phase === "menu" ? 3 : LABEL_MARKER_GAP;
    const labelVisible = f.mode !== "dead" && point !== null;
    view.label.visible = labelVisible;
    view.stamina.visible = labelVisible;
    if (point) {
      view.label.text = this.labelText(f, state);
      const fill =
        f.outsideTime > 0.5
          ? PALETTE.label.outside
          : f.human
            ? this.tagColor(f)
            : PALETTE.label.text;
      view.label.style.fill = fill;
      // The slot's shape leads the words, drawn in 2D so it stays sharp at any 3D resolution:
      // with the same animal in the same colours, shape and tag still say who is who.
      const lead = LABEL_GLYPH * 2 + LABEL_GLYPH_GAP;
      const left = point.x - (lead + view.label.width) / 2;
      const middle = point.y - view.label.height / 2;
      view.label.position.set(left + lead + view.label.width / 2, point.y);
      view.stamina
        .clear()
        .roundRect(
          left - 6,
          point.y - view.label.height - 4,
          lead + view.label.width + 12,
          view.label.height + 8,
          4,
        )
        .fill({ color: PALETTE.label.ink, alpha: 0.9 })
        .poly(
          SLOT_SHAPE_POINTS[slotShape(f.id)].flatMap(([x, y]) => [
            left + LABEL_GLYPH + x * LABEL_GLYPH,
            middle - y * LABEL_GLYPH,
          ]),
        )
        .fill({ color: fill });
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
            : effect.kind === "cancel"
              ? PALETTE.fx.snuff
              : effect.kind === "jump" || effect.kind === "land"
                ? PALETTE.fx.dust
                : effect.color;
    const material = a.material(color, 1, 0.55);
    const count =
      effect.kind === "ko" || effect.kind === "bomb"
        ? 12
        : effect.kind === "clash" || effect.kind === "cancel"
          ? 10
          : 6;
    const particles = Array.from({ length: count }, (_, i) =>
      a.mesh(root, i % 2 ? a.cube : a.pebble, material, 0, 0, 0, 0.08, 0.08, 0.08),
    );
    const ring = a.mesh(root, a.ring, a.material(color, 0.65, 0.4));
    view = { root, particles, ring };
    this.effects.set(effect.id, view);
    // The first frame an impact exists is the frame the screen feels it.
    if (effect.kind === "hit") {
      this.addShake(0.3 + effect.size * 0.32);
      this.spawnSparks(effect.x, effect.y, effect.z, effect.size, false);
    } else if (effect.kind === "clash") {
      this.addShake(0.6);
      this.spawnSparks(effect.x, effect.y, effect.z, 1.1, true);
    } else if (effect.kind === "bomb") this.addShake(0.85);
    else if (effect.kind === "ko") this.addShake(0.7);
    else if (effect.kind === "throw") this.addShake(0.28);
    return view;
  }

  private updateEffect(effect: Effect): void {
    const view = this.effectView(effect);
    const progress = Math.max(0, Math.min(1, 1 - effect.life / effect.duration));
    if (effect.kind === "cancel") {
      view.root.position.set(effect.x, effect.y + 0.04, effect.z);
      this.updateCancelEffect(view, progress);
      return;
    }
    const large = effect.kind === "bomb" || effect.kind === "ko";
    const radius = effect.size * (large ? 2.2 : 1.1) * ease(progress);
    const remaining = Math.max(0.01, 1 - progress);
    view.root.position.set(effect.x, effect.y + 0.04, effect.z);
    view.ring.scale.set(Math.max(0.01, radius));
    view.ring.visible = effect.kind === "ukemi" || progress < 0.7;
    for (const [i, particle] of view.particles.entries()) {
      const angle = (i / view.particles.length) * TAU + effect.id * 0.4;
      const vertical =
        effect.kind === "step" || effect.kind === "land"
          ? 0.12
          : Math.sin(progress * Math.PI) * (large ? 2.2 : 0.8);
      // A second, tight halo rises inside the tech ring while the fighter rolls away.
      const spread = effect.kind === "ukemi" ? radius * 0.62 : radius;
      particle.position.set(
        Math.cos(angle) * spread,
        vertical * (0.5 + (i % 3) * 0.25),
        Math.sin(angle) * spread,
      );
      particle.scale.set(
        remaining * (large ? 0.18 : 0.08),
        remaining * (effect.kind === "clash" ? 0.36 : large ? 0.21 : 0.1),
        remaining * 0.07,
      );
      particle.rotation.set(angle + progress * 4, progress * 2, angle);
    }
  }

  /**
   * A called-off swing: the charge halo breaks into dark shards that drift apart and sink, low
   * round the feet. It never expands into a ring or throws particles up, so it reads neither as a
   * hit nor as the dust of a jump, and it leaves the fighter's broken foot ring behind it.
   */
  private updateCancelEffect(view: EffectView, progress: number): void {
    view.ring.visible = false;
    const remaining = Math.max(0.01, 1 - progress);
    const radius = 0.62 + 0.3 * ease(progress);
    for (const [i, shard] of view.particles.entries()) {
      const angle = (i / view.particles.length) * TAU;
      shard.position.set(
        Math.sin(angle) * radius,
        0.28 * (1 - progress) + 0.03,
        Math.cos(angle) * radius,
      );
      // Each shard lies along the circle it broke from (its long side is local X).
      shard.rotation.set(0, angle, 0);
      shard.scale.set(0.2 * remaining, 0.04, 0.05);
    }
  }

  /**
   * An invulnerable dodge: two ink rings opening round the dodger where the blade (or blast)
   * passed through, and speed lines left behind along the step. No sparks, flash or shake, so it
   * can never be mistaken for a hit or a clash.
   */
  private spawnEvade(f: Fighter): void {
    if (this.impacts.length > 40) return;
    const a = this.assets;
    const root = new Container3D();
    root.position.set(f.x, Math.max(0, f.y), f.z);
    this.scene.addChild(root);
    const impact = this.blankImpact(root);
    impact.life = 0.34;
    const material = a.material(PALETTE.fx.evade, 0.85, 0.3);
    for (const [height, from, to] of [
      [0.95, 0.4, 1.05],
      [0.45, 0.3, 0.8],
    ] as const) {
      const ring = a.mesh(root, this.evadeRing, material, 0, height, 0, from);
      impact.rings.push({ mesh: ring, from, to });
    }
    const travel = Math.hypot(f.stepDirection.x, f.stepDirection.z);
    const back =
      travel > 0.01
        ? { x: -f.stepDirection.x / travel, z: -f.stepDirection.z / travel }
        : { x: -Math.sin(f.facing), z: -Math.cos(f.facing) };
    const yaw = Math.atan2(back.x, back.z);
    for (let i = 0; i < 4; i++) {
      const across = (i - 1.5) * 0.22;
      const line = a.mesh(
        root,
        a.cube,
        material,
        back.x * 0.5 + back.z * across,
        0.35 + (i % 2) * 0.5,
        back.z * 0.5 - back.x * across,
        0.035,
        0.035,
        0.6,
      );
      line.rotation.y = yaw;
      impact.streaks.push({ mesh: line, vx: back.x * 2.4, vz: back.z * 2.4, length: 0.6 });
    }
    this.impacts.push(impact);
  }

  /** Shows the invulnerable dodges made since the last frame (`dodgesSeen`). */
  private showDodges(state: GameState): void {
    for (const f of state.fighters) {
      const count = state.playerStats[f.id]?.dodges ?? 0;
      const seen = this.dodgesSeen.get(f.id);
      this.dodgesSeen.set(f.id, count);
      if (seen !== undefined && count > seen && f.mode !== "dead" && state.phase !== "menu")
        this.spawnEvade(f);
    }
  }

  render(state: GameState, dt: number, showHitboxes = false): void {
    if (this.destroyed) return;
    if (
      this.previousState &&
      this.previousState !== state &&
      (this.previousState.phase !== "menu" || state.phase !== "menu")
    ) {
      for (const view of this.fighters.values()) {
        view.motion = new FighterMotion();
        view.trail.clear();
      }
      for (const impact of this.impacts) impact.root.destroy({ children: true });
      this.impacts.length = 0;
      for (const effect of this.effects.values()) effect.root.destroy({ children: true });
      this.effects.clear();
      this.finishFx.clear();
      this.dodgesSeen.clear();
      this.shake = 0;
    }
    this.previousState = state;
    this.adjustResolution(state);
    const visualDelta = state.phase === "paused" ? 0 : Math.min(dt, 0.05);
    this.time += visualDelta;
    // Belts only carry fighters while the match is being played, so their arrows and the cog run
    // only then (and on the title, as a preview): still through the countdown, a pause and the end.
    if (state.phase === "playing" || state.phase === "menu") this.beltTime += visualDelta;
    // On the menu the arena slides right of the title panel (desktop) or above the menu copy (phone).
    const menu = state.phase === "menu";
    const sidePanel = this.width >= 900 || (this.height <= 570 && this.width > this.height);
    const panRight = menu && sidePanel ? MENU_PAN_RIGHT : 0;
    // A close-up with no room beside the menu sits above it (the look picker docks below).
    const closeUp = menu && this.spotlight !== null && !sidePanel;
    const panUp = !menu
      ? this.hudPanUp
      : closeUp
        ? SPOTLIGHT_PAN_UP
        : this.width < 650
          ? MENU_PAN_UP
          : 0;
    this.panRight += (panRight - this.panRight) * Math.min(1, dt * 4);
    this.panUp += (panUp - this.panUp) * Math.min(1, dt * 4);
    this.pullBack += ((menu ? MENU_PULL_BACK : 0) - this.pullBack) * Math.min(1, dt * 4);
    this.updateFollow(state, visualDelta);
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
    this.humanCount = countHumans(state.fighters);
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
    this.showDodges(state);
    this.updateImpacts(visualDelta);
    const showDebug = state.mode === "training" && state.phase !== "menu" && showHitboxes;
    if (showDebug) {
      drawTrainingDebug(this.trainingDebug, state.fighters, (p) => this.view.worldToScreen(p));
    } else if (this.trainingDebug.visible) {
      this.trainingDebug.clear();
    }
    this.trainingDebug.visible = showDebug;
    this.arenaHalfSize = state.arena.initialHalfSize;
    this.finishFx.update(visualDelta, state.phase);
    this.app.render();
  }

  /**
   * KO and finish highlights for this frame's presentation events. Visual only: the camera may
   * jolt (when shake is on) but nothing waits, so the fighters still in play keep moving.
   */
  present(events: readonly PresentationEvent[]): void {
    if (this.destroyed) return;
    for (const event of events) {
      const shake = this.finishFx.trigger(event, this.arenaHalfSize, this.settings.reducedFlash);
      if (shake > 0) this.addShake(shake);
    }
  }

  screenToWorld(clientX: number, clientY: number): Vec2 | null {
    const rect = this.canvas.getBoundingClientRect();
    // Cosmetic impact/KO shake must never perturb gameplay aiming: pick through the unshaken camera.
    const shaken = this.shake > 0 && this.settings.cameraShake && !this.debugCamera;
    if (shaken) this.placeCamera(false);
    const hit = this.view.screenToWorld(
      {
        x: ((clientX - rect.left) * this.width) / rect.width,
        y: ((clientY - rect.top) * this.height) / rect.height,
      },
      this.ground,
    );
    if (shaken) this.placeCamera(true);
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
    this.usableHeight = (this.height - top - bottom) / this.height;
    // First layout, or the fixed view: sit at the whole-arena distance straight away.
    if (!this.viewScale || !this.settings.cameraFollow) this.viewScale = this.cameraScale;
    this.viewScale = Math.min(this.viewScale, this.cameraScale);
    this.placeCamera();
  }

  /**
   * Chooses where the camera looks and how close it sits. With the follow camera off this eases
   * back to the fixed view of the whole arena.
   */
  private updateFollow(state: GameState, dt: number): void {
    let right = 0,
      up = 0,
      scale = this.cameraScale;
    const subjects =
      this.settings.cameraFollow && state.phase !== "menu"
        ? state.fighters.filter((f) => f.mode !== "dead")
        : [];
    const featured =
      state.phase === "menu" && this.spotlight !== null
        ? state.fighters.find((f) => f.id === this.spotlight)
        : undefined;
    if (featured) {
      // The close-up of the fighter whose look is being chosen, whatever the camera setting.
      const aspect = this.width / this.height;
      right = featured.x * CAMERA_RIGHT.x + featured.z * CAMERA_RIGHT.z;
      up =
        (featured.x * CAMERA_FORWARD.x + featured.z * CAMERA_FORWARD.z) * CAMERA_SIN +
        SPOTLIGHT_AIM * CAMERA_COS;
      scale = Math.min(
        this.cameraScale,
        Math.max(
          (FIGHTER_HEIGHT * CAMERA_COS) / (VIEW_HEIGHT * SPOTLIGHT_HEIGHT_SHARE),
          SPOTLIGHT_MIN_WIDTH / (VIEW_HEIGHT * aspect),
        ),
      );
    } else if (subjects.length) {
      let minRight = Infinity,
        maxRight = -Infinity,
        minUp = Infinity,
        maxUp = -Infinity;
      // Someone sent flying is on the way out: do not chase them into the sky.
      const limit = state.arena.initialHalfSize + 4;
      for (const f of subjects) {
        const x = Math.max(-limit, Math.min(limit, f.x));
        const z = Math.max(-limit, Math.min(limit, f.z));
        const y = Math.max(-2, Math.min(7, f.y));
        const across = x * CAMERA_RIGHT.x + z * CAMERA_RIGHT.z;
        const feet = (x * CAMERA_FORWARD.x + z * CAMERA_FORWARD.z) * CAMERA_SIN + y * CAMERA_COS;
        minRight = Math.min(minRight, across);
        maxRight = Math.max(maxRight, across);
        minUp = Math.min(minUp, feet);
        maxUp = Math.max(maxUp, feet + 2 * CAMERA_COS);
      }
      const aspect = this.width / this.height;
      const needed = Math.max(
        (maxRight - minRight + 2 * FOLLOW_MARGIN_X) / (VIEW_HEIGHT * aspect * FOLLOW_USABLE_WIDTH),
        (maxUp - minUp + 2 * FOLLOW_MARGIN_Y) / (VIEW_HEIGHT * this.usableHeight),
      );
      const closest = Math.min(FOLLOW_MIN_SCALE, this.cameraScale);
      scale = Math.max(closest, Math.min(this.cameraScale, needed));
      // The further out it is, the more the frame settles on the arena itself, so the widest
      // follow shot is exactly the fixed view.
      const wide =
        this.cameraScale > closest ? (scale - closest) / (this.cameraScale - closest) : 1;
      const hold = 1 - wide * wide;
      right = ((minRight + maxRight) / 2) * hold;
      up = ((minUp + maxUp) / 2) * hold;
    }
    const drift = 1 - Math.exp(-dt * 4);
    this.focusRight += (right - this.focusRight) * drift;
    this.focusUp += (up - this.focusUp) * drift;
    // Back off quickly so nobody leaves the frame; close in gently so the view does not pump.
    const zoom = 1 - Math.exp(-dt * (scale > this.viewScale ? 6 : featured ? 5 : 1.7));
    this.viewScale += (scale - this.viewScale) * zoom;
  }

  /** The only place the camera is positioned: pan the look-at target, then the fixed offset. */
  private placeCamera(applyShake = true): void {
    const s = (this.viewScale || this.cameraScale) * (1 + this.pullBack);
    const up = this.panUp * VIEW_HEIGHT * s;
    const right = ((this.panRight * VIEW_HEIGHT * s) / this.height) * this.width + this.focusRight;
    // The focus is a point on the floor: `focusUp` is measured on screen, so undo the foreshortening.
    const depth = this.focusUp / CAMERA_SIN;
    const target = {
      x: CAMERA_RIGHT.x * right + CAMERA_FORWARD.x * depth + CAMERA_UP.x * up,
      y: CAMERA_UP.y * up,
      z: CAMERA_RIGHT.z * right + CAMERA_FORWARD.z * depth + CAMERA_UP.z * up,
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
    if (applyShake && this.shake > 0 && this.settings.cameraShake) {
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
    const impact = this.blankImpact(root);
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

  private blankImpact(root: Container3D): Impact {
    return {
      root,
      parts: [],
      cracks: [],
      sparks: [],
      bolts: [],
      rings: [],
      streaks: [],
      flash: null,
      age: 0,
      life: 0.5,
      gravity: 9,
    };
  }

  /**
   * Steel on a body, or steel on steel: sparks thrown outward and a crackle of static round the
   * point of contact. `power` is about 0.7 for a tap and above 1 for a charged blow.
   */
  private spawnSparks(x: number, y: number, z: number, power: number, clash: boolean): void {
    if (this.impacts.length > 40) return;
    const a = this.assets;
    const root = new Container3D();
    root.position.set(x, y, z);
    this.scene.addChild(root);
    const impact = this.blankImpact(root);
    impact.life = 0.55;
    const seed = (x * 12.9898 + z * 78.233 + this.time * 37.7) % 1;
    const random = (i: number) => {
      const v = Math.sin((seed + i * 0.6180339) * 43758.5453) * 0.5 + 0.5;
      return v - Math.floor(v);
    };
    const colours = [PALETTE.fx.sparkCore, PALETTE.fx.spark, PALETTE.fx.sparkEmber];
    const count = Math.round((clash ? 16 : 8) + power * 6);
    for (let i = 0; i < count; i++) {
      // A rough hemisphere, leaning upward so the spray reads from the high camera.
      const angle = random(i) * TAU;
      const lift = 0.15 + random(i + 40) * 0.85;
      const speed = (4.5 + random(i + 80) * 6.5) * (0.75 + power * 0.35);
      const flat = Math.sqrt(1 - lift * lift * 0.6);
      const mesh = a.mesh(root, a.cube, a.material(colours[i % 3]!, 1, 0.9), 0, 0, 0, 0.03);
      impact.sparks.push({
        mesh,
        x: 0,
        y: 0,
        z: 0,
        vx: Math.cos(angle) * flat * speed,
        vy: lift * speed * 0.8,
        vz: Math.sin(angle) * flat * speed,
        life: 0.22 + random(i + 120) * 0.28,
        width: 0.028 + random(i + 160) * 0.022,
      });
    }
    const bolts = clash ? 3 : power > 1.05 ? 3 : 2;
    for (let b = 0; b < bolts; b++) {
      const core = b % 2 === 1;
      const material = a.material(core ? PALETTE.fx.boltCore : PALETTE.fx.bolt, 1, 0.9);
      impact.bolts.push({
        segments: Array.from({ length: 4 }, () => a.mesh(root, a.cube, material, 0, 0, 0, 0.03)),
        reach: (0.75 + random(b + 200) * 0.5) * (0.8 + power * 0.3),
        until: 0.16 + random(b + 220) * 0.14,
        redrawAt: 0,
        seed: seed + b * 3.7,
      });
    }
    impact.flash = a.mesh(root, a.pebble, a.material(PALETTE.fx.flash, 0.7, 1), 0, 0, 0, 0.15);
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
      for (const spark of impact.sparks) {
        const age = impact.age / spark.life;
        if (age >= 1) {
          spark.mesh.visible = false;
          continue;
        }
        spark.vy -= 13 * dt;
        const drag = Math.exp(-dt * 2.6);
        spark.vx *= drag;
        spark.vz *= drag;
        spark.x += spark.vx * dt;
        spark.y += spark.vy * dt;
        spark.z += spark.vz * dt;
        const speed = Math.hypot(spark.vx, spark.vy, spark.vz);
        const along = norm({ x: spark.vx, y: spark.vy, z: spark.vz });
        const q = qLook(along, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 });
        spark.mesh.position.set(spark.x, spark.y, spark.z);
        spark.mesh.quaternion.set(q.x, q.y, q.z, q.w);
        // Long while fast, shrinking to a point as it cools.
        const width = spark.width * (1 - age * 0.7);
        spark.mesh.scale.set(width, Math.max(0.06, speed * 0.062) * (1 - age * 0.5), width);
      }
      for (const bolt of impact.bolts) {
        const live = impact.age < bolt.until;
        for (const segment of bolt.segments) segment.visible = live;
        if (!live || impact.age < bolt.redrawAt) continue;
        // Static does not move: it is somewhere else every few frames.
        bolt.redrawAt = impact.age + 0.035;
        const step = Math.floor(impact.age / 0.035);
        const jitter = (i: number) => {
          const v = Math.sin((bolt.seed + step * 1.37 + i * 0.6180339) * 43758.5453) * 0.5 + 0.5;
          return v - Math.floor(v);
        };
        const heading = jitter(0) * TAU;
        let from = { x: 0, y: 0, z: 0 };
        bolt.segments.forEach((segment, i) => {
          const distance = (bolt.reach * (i + 1)) / bolt.segments.length;
          const swerve = heading + (jitter(i * 3 + 1) - 0.5) * 1.5;
          const to = {
            x: Math.cos(swerve) * distance,
            y: (jitter(i * 3 + 2) - 0.35) * 0.7 * ((i + 1) / bolt.segments.length),
            z: Math.sin(swerve) * distance,
          };
          const dx = to.x - from.x,
            dy = to.y - from.y,
            dz = to.z - from.z;
          const length = Math.hypot(dx, dy, dz) || 0.001;
          const q = qLook(
            { x: dx / length, y: dy / length, z: dz / length },
            { x: 0, y: 0, z: 1 },
            { x: 1, y: 0, z: 0 },
          );
          segment.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
          segment.quaternion.set(q.x, q.y, q.z, q.w);
          const thick = 0.045 * (1 - i / (bolt.segments.length + 1));
          segment.scale.set(thick, length, thick);
          from = to;
        });
      }
      for (const ring of impact.rings) {
        const radius = ring.from + (ring.to - ring.from) * ease(t);
        ring.mesh.visible = t < 0.85;
        ring.mesh.scale.set(radius, 1.6 * (1 - t) + 0.2, radius);
      }
      for (const streak of impact.streaks) {
        const p = streak.mesh.position;
        streak.mesh.position.set(p.x + streak.vx * dt, p.y, p.z + streak.vz * dt);
        const thin = Math.max(0.001, 1 - t);
        streak.mesh.scale.set(0.035 * thin, 0.035 * thin, streak.length * (0.5 + 0.5 * thin));
      }
      if (impact.flash) {
        const pop = impact.age / 0.07;
        impact.flash.visible = pop < 1;
        impact.flash.scale.set(0.15 + pop * 0.4);
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

    for (const view of this.fighters.values()) this.destroyFighter(view);
    this.fighters.clear();
    for (const bomb of this.bombs.values()) {
      bomb.root.destroy({ children: true });
      bomb.label.destroy();
    }
    this.bombs.clear();
    for (const effect of this.effects.values()) effect.root.destroy({ children: true });
    this.effects.clear();
    this.finishFx.clear();
    for (const impact of this.impacts) impact.root.destroy({ children: true });
    this.impacts.length = 0;

    this.view.destroy({ children: true });
    this.ssao?.destroy();
    this.fxaa?.destroy();
    this.rigAssets.destroy();
    this.evadeRing.destroy(true);
    this.stageShapes.destroy();
    this.assets.destroy();
    this.skyTexture.destroy(true);
    this.app.destroy({ removeView: true }, { children: true });
  }
}
