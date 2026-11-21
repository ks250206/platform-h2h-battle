import { expect, test, type Page } from "@playwright/test";

async function load(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("Browser error:", error.message);
  });
  const started = Date.now();
  await page.goto("./");
  await page.waitForFunction(() => Boolean(window.__BRAMBLE__));
  await expect(page.locator("#arena canvas")).toBeVisible();
  console.info(`3D ready in ${Date.now() - started}ms`);
  console.info(
    await page.locator("#arena canvas").evaluate((canvas) => ({
      backend: (canvas as HTMLCanvasElement).dataset.renderBackend,
      resolution: (canvas as HTMLCanvasElement).dataset.sceneResolution,
    })),
  );
  return errors;
}

type Level = "easy" | "normal" | "hard";

/** Picks the title menu's 対戦設定 through its buttons (the mode must already be selected). */
async function chooseMatch(
  page: Page,
  options: { stocks?: number; difficulty?: Level; overrides?: Record<number, Level> },
) {
  if (options.stocks) await page.locator(`[data-stocks="${options.stocks}"]`).click();
  if (options.difficulty) await page.locator(`[data-difficulty="${options.difficulty}"]`).click();
  // Each CPU's row has its own strength; おまかせ ("auto") follows the overall one.
  for (const [id, level] of Object.entries(options.overrides ?? {}))
    await page.locator(`.player-level[data-override="${id}"]`).selectOption(level);
}

async function start(page: Page, mode: string, options?: Parameters<typeof chooseMatch>[1]) {
  const started = Date.now();
  // The button: the UI root also carries data-mode (the current match's mode).
  await page.locator(`button[data-mode="${mode}"]`).click();
  if (options) await chooseMatch(page, options);
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__BRAMBLE__?.snapshot().phase === "playing");
  console.info(`${mode} countdown completed in ${Date.now() - started}ms`);
}

type Spot = { x: number; z: number };
type AimProbe = { __aimGap: (self: Spot & { facing: number }, to: Spot) => number };
/** One frame of the lock-on log: the facing's error, and whether the player was free to turn. */
type AimFrame = { gap: number; settled: boolean };

test("title, real 3D canvas, help and keyboard navigation load without errors", async ({
  page,
}) => {
  const errors = await load(page);
  await expect(page.getByRole("heading", { name: /小さな体に、.*大きな一撃。/ })).toBeVisible();
  await page.screenshot({ path: "test-results/title-desktop.png" });
  await page.getByRole("button", { name: "操作方法を表示" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.locator('[data-action="start"]').focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(() => window.__BRAMBLE__?.snapshot().phase === "countdown");
  expect(errors).toEqual([]);
});

test("training accepts movement, jump, charged feint, all attacks and pause", async ({ page }) => {
  // This full input sequence includes four long recovery animations and image readback.
  test.setTimeout(120_000);
  const errors = await load(page);
  await start(page, "training");
  const before = await page.evaluate(() => window.__BRAMBLE__!.snapshot().fighters[0].x);
  await page.keyboard.down("KeyD");
  await page.waitForFunction((x) => window.__BRAMBLE__!.snapshot().fighters[0].x > x + 0.5, before);
  await page.keyboard.up("KeyD");

  // Jump, then an air dodge with a direction held. The whole airtime is under a second, so the
  // inputs are sent from inside the page and every frame is logged for the assertions below.
  const air = await page.evaluate(
    () =>
      new Promise<{ mode: string; grounded: boolean; y: number; airStepUsed: boolean }[]>(
        (resolve) => {
          const key = (type: "keydown" | "keyup", code: string) =>
            window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
          const log: { mode: string; grounded: boolean; y: number; airStepUsed: boolean }[] = [];
          let dodged = false;
          const poll = () => {
            const { mode, grounded, y, airStepUsed } = window.__BRAMBLE__!.snapshot().fighters[0];
            log.push({ mode, grounded, y, airStepUsed });
            if (!dodged && !grounded && y > 0.3) {
              dodged = true;
              key("keydown", "KeyA");
              key("keydown", "ShiftLeft");
              key("keyup", "ShiftLeft");
            }
            if (dodged && grounded) {
              key("keyup", "KeyA");
              resolve(log);
            } else if (log.length > 600) resolve(log);
            else requestAnimationFrame(poll);
          };
          key("keydown", "Space");
          key("keyup", "Space");
          requestAnimationFrame(poll);
        },
      ),
  );
  expect(air.some((frame) => frame.y > 0.2)).toBe(true);
  expect(air.some((frame) => frame.mode === "step" && !frame.grounded && frame.airStepUsed)).toBe(
    true,
  );
  expect(air.at(-1)!.grounded).toBe(true);
  expect(air.at(-1)!.airStepUsed).toBe(false);
  // Landing gives the air dodge back; wait for the step's stamina to refill before the feints.
  await page.waitForFunction(() => {
    const f = window.__BRAMBLE__!.snapshot().fighters[0];
    return f.grounded && !f.airStepUsed && f.mode === "idle" && f.stamina >= 100;
  });
  // Records the fighter's mode every frame: short-lived states are asserted from this log
  // rather than waited for, so a slow software-rendered frame cannot make the test miss them.
  const record = () =>
    page.evaluate(() => {
      const recorder = window as unknown as {
        __modes: string[];
        __lowestStamina: number;
        __recording: boolean;
      };
      recorder.__modes = [];
      recorder.__lowestStamina = Infinity;
      if (recorder.__recording) return;
      recorder.__recording = true;
      const poll = () => {
        const fighter = window.__BRAMBLE__!.snapshot().fighters[0];
        recorder.__modes.push(fighter.mode);
        recorder.__lowestStamina = Math.min(recorder.__lowestStamina, fighter.stamina);
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    });
  const lowestStamina = () =>
    page.evaluate(() => (window as unknown as { __lowestStamina: number }).__lowestStamina);
  const recorded = () =>
    page.evaluate(() => (window as unknown as { __modes: string[] }).__modes.slice());
  const swingId = () => page.evaluate(() => window.__BRAMBLE__!.snapshot().fighters[0].swingId);
  const idleAgain = () =>
    page.waitForFunction(() => {
      const modes = (window as unknown as { __modes: string[] }).__modes;
      const f = window.__BRAMBLE__!.snapshot().fighters[0];
      return f.mode === "idle" && modes.some((mode) => mode !== "idle");
    });

  // Charge cancel: the attack is never committed, even though the button is released afterwards.
  const swingBefore = await swingId();
  await record();
  await page.keyboard.down("KeyJ");
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().fighters[0].charge > 0.2);
  await page.keyboard.press("KeyQ");
  await idleAgain();
  await page.keyboard.up("KeyJ");
  expect(await recorded()).toContain("cancel");
  expect(await recorded()).not.toContain("windup");
  // Only the 10 prepaid for the charge is lost. Stamina starts refilling half a second later,
  // so the lowest value seen is checked rather than the value now.
  expect(await lowestStamina()).toBeCloseTo(90, 0);
  expect(await swingId()).toBe(swingBefore);

  // Wind-up cancel: a committed attack can still be stopped before the hit becomes active.
  await page.waitForFunction(() => {
    const f = window.__BRAMBLE__!.snapshot().fighters[0];
    return f.mode === "idle" && f.stamina >= 35 && f.grounded;
  });
  await record();
  // Tap the attack and press cancel from inside the page, on the first frame that shows the
  // wind-up: a round trip through the test runner can outlast the 0.43 s wind-up on a slow machine.
  await page.evaluate(() => {
    const press = (code: string) => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keyup", { code, bubbles: true }));
    };
    const cancelOnWindup = () => {
      if (window.__BRAMBLE__!.snapshot().fighters[0].mode === "windup") press("KeyQ");
      else requestAnimationFrame(cancelOnWindup);
    };
    press("KeyJ");
    requestAnimationFrame(cancelOnWindup);
  });
  await idleAgain();
  const modes = await recorded();
  expect(modes).toContain("windup");
  expect(modes).toContain("cancel");
  expect(modes).not.toContain("active");
  expect(modes).not.toContain("recovery");
  expect(await swingId()).toBe(swingBefore + 1);
  // The whole cost of the overhead (25) stays spent: nothing is refunded for stopping.
  expect(await lowestStamina()).toBeLessThanOrEqual(75.5);
  expect(await page.evaluate(() => window.__BRAMBLE__!.snapshot().stats.hits)).toBe(0);
  for (const key of ["KeyI", "KeyJ", "KeyK", "KeyL"]) {
    await page.waitForFunction(() => {
      const f = window.__BRAMBLE__!.snapshot().fighters[0];
      return f.mode === "idle" && f.stamina >= 35 && f.grounded;
    });
    await page.keyboard.down(key);
    await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().fighters[0].mode === "charge");
    await page.keyboard.up(key);
    await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().fighters[0].mode === "windup");
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "ひと休み。" })).toBeVisible();
  const paused = await page.evaluate(() => window.__BRAMBLE__!.snapshot().elapsed);
  await page.keyboard.press("KeyW");
  const stillPaused = await page.evaluate(() => window.__BRAMBLE__!.snapshot().elapsed);
  expect(stillPaused).toBe(paused);
  await page.locator('[data-action="resume"]').click();
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().phase === "playing");
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/training-desktop.png" });
});

test("rumble starts with the chosen match settings, four fighters and CPU combat", async ({
  page,
}) => {
  const errors = await load(page);
  await start(page, "rumble", { stocks: 4, difficulty: "hard", overrides: { 2: "easy" } });
  await expect(page.locator(".fighter-card")).toHaveCount(4);
  const state = await page.evaluate(() => window.__BRAMBLE__!.snapshot());
  expect(state.options).toMatchObject({ stocks: 4, difficulty: "hard" });
  expect(state.options.overrides).toEqual({ 2: "easy" });
  expect(state.fighters.map((f) => f.stocks)).toEqual([4, 4, 4, 4]);
  expect(state.fighters.slice(1).map((f) => f.aiLevel)).toEqual(["hard", "easy", "hard"]);
  expect(new Set(state.fighters.map((f) => f.species)).size).toBe(4);
  // The HUD shows each CPU's strength and four life pips per fighter.
  await expect(page.locator(".opponent-card .fighter-level")).toHaveText([
    "つよい",
    "よわい",
    "つよい",
  ]);
  await expect(page.locator(".player-card .fighter-life i")).toHaveCount(4);
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().stats.hits > 0, undefined, {
    timeout: 25_000,
  });
  await page.screenshot({ path: "test-results/rumble-desktop.png" });
  expect(errors).toEqual([]);
});

test("touch controls fit a portrait viewport and trigger an attack", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = await load(page);
  await page.screenshot({ path: "test-results/title-mobile.png" });
  await start(page, "training");
  await expect(page.locator(".touch-controls")).toBeVisible();
  const attack = page.locator('.touch-attacks [data-attack="sweep"]');
  await expect(attack).toBeInViewport();
  await attack.tap();
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().fighters[0].stamina < 90);
  await page.screenshot({ path: "test-results/training-mobile.png" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(attack).toBeInViewport();
  const card = await page.locator(".fighter-card").first().boundingBox();
  const controls = await page.locator(".touch-controls").boundingBox();
  expect(card!.y + card!.height).toBeLessThan(controls!.y);
  await page.screenshot({ path: "test-results/training-landscape.png" });
  expect(errors).toEqual([]);
  await context.close();
});

test("graphics settings apply, persist across a reload and reflect in the dialog", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await load(page);
  const dialog = page.locator(".settings-dialog");
  await page.getByRole("button", { name: "グラフィック設定を開く" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-output="resolution"]')).toHaveText(/^\d+ × \d+$/);
  await dialog.getByRole("button", { name: "高", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "高", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await dialog.getByLabel("アンチエイリアス").selectOption("fxaa");
  await dialog.getByLabel("FPS を表示").check();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".fps-counter")).toBeVisible();
  await expect(page.locator(".fps-counter")).toHaveText(/\d+ FPS/);
  // The title's 対戦設定 are remembered across the same reload.
  await chooseMatch(page, { stocks: 5, difficulty: "hard", overrides: { 1: "easy" } });
  await expect(page.locator('.player-level[data-override="1"]')).toHaveValue("easy");

  await page.reload();
  await page.waitForFunction(() => Boolean(window.__BRAMBLE__));
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("bramble.settings.v1") ?? "{}"),
  );
  expect(stored).toMatchObject({ shadows: "high", antialiasing: "fxaa", showFps: true });
  const match = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("bramble.match.v1") ?? "{}"),
  );
  expect(match).toMatchObject({ stocks: 5, difficulty: "hard" });
  expect(match.overrides).toEqual({ 1: "easy" });
  await expect(page.locator('[data-stocks="5"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-stocks="3"]')).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator('[data-difficulty="hard"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.player-level[data-override="1"]')).toHaveValue("easy");
  await expect(page.locator('.player-row[data-slot="0"] .player-device')).toHaveValue("keyboard");
  await expect(page.locator('.player-row[data-slot="1"] .player-device')).toHaveValue("cpu");
  await expect(page.locator(".fps-counter")).toBeVisible();
  await page.locator(".menu-links [data-action='settings']").click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "高", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(dialog.getByRole("button", { name: "なし", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(dialog.getByLabel("アンチエイリアス")).toHaveValue("fxaa");
  await expect(dialog.getByLabel("FPS を表示")).toBeChecked();
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.screenshot({ path: "test-results/settings-persisted.png" });
  expect(errors).toEqual([]);
});

test("duel: lock-on holds the aim, Tab frees it, and a lost life respawns", async ({ page }) => {
  // Angle (degrees, 0-180) between a fighter's facing and the bearing to a ground point.
  await page.addInitScript(() => {
    (window as unknown as AimProbe).__aimGap = (self, to) => {
      const bearing = Math.atan2(to.x - self.x, to.z - self.z);
      const d = (((self.facing - bearing) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2);
      return Math.abs(((d - Math.PI) * 180) / Math.PI);
    };
  });
  const errors = await load(page);
  // V on the title turns the follow camera off, so the view (and the mouse's ground point) is fixed.
  const camera = page.locator('[data-action="camera"]');
  await expect(camera).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("KeyV");
  await expect(camera).toHaveAttribute("aria-pressed", "false");
  // Four lives: whatever the opponent manages on a slow machine, the match outlasts the test.
  await start(page, "duel", { stocks: 4, difficulty: "easy" });
  const state = await page.evaluate(() => window.__BRAMBLE__!.snapshot());
  expect(state.options.stocks).toBe(4);
  expect(state.fighters.map((f) => f.stocks)).toEqual([4, 4]);
  expect(state.fighters[1].aiLevel).toBe("easy");

  // A ground point beside the player, well away from the opponent's bearing, and where it is on
  // screen; the mouse sweeps across the canvas from the opposite side to there.
  const player = state.fighters[0];
  const point = { x: player.x, z: player.z + 5 };
  const box = (await page.locator("#arena canvas").boundingBox())!;
  const onScreen = (await page.evaluate(({ x, z }) => window.__BRAMBLE__!.screen(x, 0, z), point))!;
  const target = { x: box.x + onScreen.x, y: box.y + onScreen.y };

  // Lock-on is on from the start: the LOCK chip sits on the opponent's card. Every frame of the
  // sweep is logged in the page; the facing must stay on the opponent whenever the player is free.
  await expect(page.locator(".opponent-card .fighter-lock")).toBeVisible();
  await expect(page.locator(".game-hud")).not.toHaveClass(/lock-off/);
  await page.evaluate(() => {
    const recorder = window as unknown as AimProbe & { __aim?: AimFrame[] };
    recorder.__aim = [];
    // The aim is taken from where both stood before the frame's simulation steps, so the facing
    // trails a moving opponent by one frame: a degree or two at 60 fps, several on a slow machine.
    // Measured against the previous frame's positions as well, the check holds at any frame rate.
    let before: [Spot, Spot] | null = null;
    // Match time since which the player has been free. A hit leaves the facing wherever it was,
    // and turning back takes up to 0.16 s (half a turn at the idle rate), so a frame only counts
    // once the player has been free for longer than that.
    let freeSince: number | null = null;
    const poll = () => {
      if (!recorder.__aim) return;
      const state = window.__BRAMBLE__!.snapshot();
      const [self, other] = state.fighters;
      const now = recorder.__aimGap(self, other);
      const then = before
        ? recorder.__aimGap({ ...before[0], facing: self.facing }, before[1])
        : now;
      if (self.mode !== "idle" || other.mode === "dead") freeSince = null;
      else freeSince ??= state.elapsed;
      recorder.__aim.push({
        gap: Math.min(now, then),
        settled: freeSince !== null && state.elapsed - freeSince > 0.3,
      });
      before = [
        { x: self.x, z: self.z },
        { x: other.x, z: other.z },
      ];
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
  await page.mouse.move(box.x + box.width - target.x, box.y + box.height - target.y);
  await page.mouse.move(target.x, target.y, { steps: 8 });
  // The opponent may land a hit meanwhile, so wait for enough settled frames with the cursor
  // parked on the far point rather than for a number of frames.
  const parked = await page.evaluate(
    () => (window as unknown as { __aim: AimFrame[] }).__aim.length,
  );
  await page.waitForFunction(
    (from) =>
      (window as unknown as { __aim: AimFrame[] }).__aim.slice(from).filter((f) => f.settled)
        .length > 5,
    parked,
  );
  const locked = await page.evaluate(() => {
    const recorder = window as unknown as { __aim?: AimFrame[] };
    const log = recorder.__aim!;
    delete recorder.__aim;
    return log;
  });
  const settled = locked.filter((frame) => frame.settled);
  expect(settled.length).toBeGreaterThan(5);
  for (const frame of settled) expect(frame.gap).toBeLessThan(5);

  // Tab turns the lock off: the chip goes, and the cursor now steers the facing (a steady state,
  // so waiting for it is safe even if a hit briefly freezes the player).
  await page.keyboard.press("Tab");
  await expect(page.locator(".game-hud")).toHaveClass(/lock-off/);
  await expect(page.locator(".opponent-card .fighter-lock")).toBeHidden();
  await page.mouse.move(target.x + 1, target.y);
  await page.waitForFunction((p) => {
    const probe = window as unknown as AimProbe;
    const [self, other] = window.__BRAMBLE__!.snapshot().fighters;
    return self.mode === "idle" && probe.__aimGap(self, p) < 6 && probe.__aimGap(self, other) > 30;
  }, point);

  // Tab again locks back on, and the facing returns to the opponent.
  await page.keyboard.press("Tab");
  await expect(page.locator(".opponent-card .fighter-lock")).toBeVisible();
  await page.waitForFunction(() => {
    const [self, other] = window.__BRAMBLE__!.snapshot().fighters;
    return self.mode === "idle" && (window as unknown as AimProbe).__aimGap(self, other) < 5;
  });

  // Walk off the island (screen up-left is world −x, the player's near edge). The HUD card's
  // status and invulnerability badge are logged every frame from here on.
  await page.evaluate(() => {
    const recorder = window as unknown as { __hud: { status: string; shield: boolean }[] };
    recorder.__hud = [];
    const card = document.querySelector(".player-card")!;
    const poll = () => {
      recorder.__hud.push({
        status: card.querySelector(".fighter-status")!.textContent ?? "",
        shield: !card.querySelector<HTMLElement>(".fighter-invulnerable")!.hidden,
      });
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
  // The opponent may have taken a life already, so the checks are relative to the lives left now.
  const livesBefore = await page.evaluate(() => window.__BRAMBLE__!.snapshot().fighters[0].stocks);
  await page.keyboard.down("KeyA");
  await page.keyboard.down("KeyW");
  await page.waitForFunction(
    (lives) => window.__BRAMBLE__!.snapshot().fighters[0].stocks < lives,
    livesBefore,
    { timeout: 30_000 },
  );
  await page.keyboard.up("KeyA");
  await page.keyboard.up("KeyW");
  // The respawned fighter, as the first poll that finds it back in play sees it.
  const back = (await (
    await page.waitForFunction(() => {
      const f = window.__BRAMBLE__!.snapshot().fighters[0];
      return f.mode === "dead" ? null : f;
    })
  ).jsonValue())!;
  const after = await page.evaluate(() => window.__BRAMBLE__!.snapshot());
  expect(back.stocks).toBe(livesBefore - 1);
  expect(back.invulnerable).toBeGreaterThan(0);
  expect(Math.abs(back.x)).toBeLessThan(after.arena.halfSize);
  expect(Math.abs(back.z)).toBeLessThan(after.arena.halfSize);
  expect(after.phase).toBe("playing");
  // The card lost a pip, said 復帰中 while down, and showed 無敵 once back.
  const lives = page.locator(".player-card .fighter-life");
  await expect(lives).toHaveAttribute("aria-label", `残機 ${back.stocks}`);
  await expect(lives.locator("i")).toHaveCount(4);
  await expect(lives.locator("i.lost")).toHaveCount(4 - back.stocks);
  await page.waitForFunction(() =>
    (window as unknown as { __hud: { shield: boolean }[] }).__hud.some((frame) => frame.shield),
  );
  const hud = await page.evaluate(
    () => (window as unknown as { __hud: { status: string }[] }).__hud,
  );
  expect(hud.some((frame) => frame.status === "復帰中")).toBe(true);
  await page.screenshot({ path: "test-results/duel-respawn.png" });
  expect(errors).toEqual([]);
});

test("the stage selector swaps the 3D stage on the title, persists, and the match is fought there", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const errors = await load(page);
  const canvas = page.locator("#arena canvas");
  const pick = (stage: string) => page.locator(`button[data-stage="${stage}"]`);
  const shown = () => page.evaluate(() => window.__BRAMBLE__!.snapshot().arena.stageId);
  // The garden by default: selected, named beside the preview, and the one on show.
  await expect(pick("garden")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".caption-title")).toHaveText("THE FLOATING GARDEN");
  await expect(canvas).toHaveAttribute("data-stage", "garden");
  expect(await shown()).toBe("garden");

  // Each stage: the title's state, the 3D floor and the card's words follow the click at once.
  const stages = [
    ["ruins", "SUNKEN RUINS", "中央穴の遺跡"],
    ["bridges", "SKY BRIDGES", "細い橋の回廊"],
    ["factory", "CONVEYOR WORKS", "コンベア工場"],
  ] as const;
  for (const [id, title, name] of stages) {
    await pick(id).click();
    await expect(pick(id)).toHaveAttribute("aria-pressed", "true");
    await expect(pick("garden")).toHaveAttribute("aria-pressed", "false");
    await expect(canvas).toHaveAttribute("data-stage", id);
    expect(await shown()).toBe(id);
    expect(await page.evaluate(() => window.__BRAMBLE__!.snapshot().phase)).toBe("menu");
    const card = page.locator(".arena-caption");
    await expect(card.locator(".caption-title")).toHaveText(title);
    await expect(card.locator(".caption-name")).toContainText(name);
    // What fighting there is about, and what each gimmick does there, before the match starts.
    await expect(card.locator(".stage-summary")).not.toBeEmpty();
    await expect(card.locator(".stage-rules")).not.toBeEmpty();
    await expect(card.locator(".gimmick-chip")).toHaveCount(5);
    await page.screenshot({ path: `test-results/title-stage-${id}.png` });
  }
  await expect(page.locator('.arena-caption .gimmick-chip[data-state="on"]')).toContainText([
    "コンベア",
  ]);

  // With the keyboard: focus a stage button and press Enter.
  await pick("bridges").focus();
  await page.keyboard.press("Enter");
  await expect(pick("bridges")).toHaveAttribute("aria-pressed", "true");
  expect(await shown()).toBe("bridges");
  await expect(page.locator('.arena-caption .gimmick-chip[data-state="off"]')).toContainText([
    "崩落",
    "風",
    "コンベア",
  ]);

  // Remembered across a reload, and shown again straight away.
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__BRAMBLE__));
  await expect(pick("bridges")).toHaveAttribute("aria-pressed", "true");
  await expect(canvas).toHaveAttribute("data-stage", "bridges");
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("bramble.match.v1") ?? "{}").stage),
  ).toBe("bridges");

  // The match is fought on it: fighters start on the two far islands, over floor.
  await start(page, "duel");
  const state = await page.evaluate(() => window.__BRAMBLE__!.snapshot());
  expect(state.arena.stageId).toBe("bridges");
  expect(state.options.stage).toBe("bridges");
  await expect(page.locator(".arena-status")).toHaveText("SKY BRIDGES");
  await page.screenshot({ path: "test-results/duel-bridges.png" });

  // A rematch and the way back to the title keep the stage.
  await page.keyboard.press("Escape");
  await page.locator('.pause-screen [data-action="restart"]').click();
  await page.waitForFunction(() => window.__BRAMBLE__?.snapshot().phase === "countdown");
  expect(await shown()).toBe("bridges");
  await page.keyboard.press("Escape");
  await page.locator('.pause-screen [data-action="menu"]').click();
  await page.waitForFunction(() => window.__BRAMBLE__?.snapshot().phase === "menu");
  expect(await shown()).toBe("bridges");
  await expect(pick("bridges")).toHaveAttribute("aria-pressed", "true");

  // The help dialog describes all four stages.
  await page.getByRole("button", { name: "操作方法を表示" }).click();
  await expect(page.locator(".help-dialog .stage-help-item")).toHaveCount(4);
  await expect(page.locator('.help-dialog [data-stage-help="factory"]')).toContainText(
    "コンベア工場",
  );
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("on a phone the stage is picked by touch and described under its buttons", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = await load(page);
  await page.locator('button[data-stage="factory"]').tap();
  await expect(page.locator('button[data-stage="factory"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await page.evaluate(() => window.__BRAMBLE__!.snapshot().arena.stageId)).toBe("factory");
  // No room for the card beside the preview: the same words sit in the match options.
  await expect(page.locator(".arena-caption")).toBeHidden();
  const detail = page.locator(".stage-detail");
  await expect(detail).toBeVisible();
  await expect(detail.locator(".stage-detail-name strong")).toHaveText("コンベア工場");
  await expect(detail.locator(".stage-summary")).toContainText("コンベア");
  await expect(detail.locator(".stage-rules")).toContainText("崩落");
  await expect(page.locator('[data-action="start"]')).toBeInViewport();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: "test-results/title-mobile-stage.png" });
  expect(errors).toEqual([]);
  await context.close();
});
