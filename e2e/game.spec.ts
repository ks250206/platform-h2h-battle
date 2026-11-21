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

async function start(page: Page, mode: string) {
  const started = Date.now();
  await page.locator('[data-mode="' + mode + '"]').click();
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__BRAMBLE__?.snapshot().phase === "playing");
  console.info(`${mode} countdown completed in ${Date.now() - started}ms`);
}

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
  await page.keyboard.press("Space");
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().fighters[0].y > 0.2);
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().fighters[0].grounded);
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

test("rumble shows four different fighters and CPU combat progresses", async ({ page }) => {
  const errors = await load(page);
  await start(page, "rumble");
  await expect(page.locator(".fighter-card")).toHaveCount(4);
  expect(
    await page.evaluate(
      () => new Set(window.__BRAMBLE__!.snapshot().fighters.map((f) => f.species)).size,
    ),
  ).toBe(4);
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

  await page.reload();
  await page.waitForFunction(() => Boolean(window.__BRAMBLE__));
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("bramble.settings.v1") ?? "{}"),
  );
  expect(stored).toMatchObject({ shadows: "high", antialiasing: "fxaa", showFps: true });
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
