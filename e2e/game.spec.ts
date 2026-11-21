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
  await page.keyboard.down("KeyJ");
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().fighters[0].charge > 0.2);
  await page.keyboard.press("KeyQ");
  await page.keyboard.up("KeyJ");
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().fighters[0].mode === "idle");
  expect(
    await page.evaluate(() => window.__BRAMBLE__!.snapshot().fighters[0].stamina),
  ).toBeLessThan(100);
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
