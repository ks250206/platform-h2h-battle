import { expect, test, type Page } from "@playwright/test";

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 1,
});

async function load(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./");
  await page.waitForFunction(() => Boolean(window.__BRAMBLE__));
  return errors;
}

test("mobile double taps leave the stick and attack buttons ready for simultaneous touch", async ({
  page,
  context,
}) => {
  const errors = await load(page);
  await page.locator('button[data-mode="training"]').tap();
  await page.locator('[data-action="start"]').tap();
  await page.waitForFunction(() => window.__BRAMBLE__?.snapshot().phase === "playing");
  const stick = page.locator(".touch-stick");
  const attack = page.locator('.touch-attacks [data-attack="sweep"]');
  for (const control of await page.locator(".touch-stick, .touch-actions button:visible").all()) {
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(16);
    expect(box.x + box.width).toBeLessThanOrEqual(390 - 16);
  }

  const stickBox = (await stick.boundingBox())!;
  expect(stickBox.width).toBeCloseTo(390 * 0.29, 0);
  const attackBox = (await attack.boundingBox())!;
  expect(attackBox.width).toBeCloseTo(390 * 0.126, 0);
  const move = { x: stickBox.x + stickBox.width * 0.8, y: stickBox.y + stickBox.height / 2, id: 1 };
  const swing = {
    x: attackBox.x + attackBox.width / 2,
    y: attackBox.y + attackBox.height / 2,
    id: 2,
  };
  const cdp = await context.newCDPSession(page);
  for (const point of [move, swing]) {
    for (let tap = 0; tap < 2; tap++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
  }
  await expect(attack).not.toHaveClass(/pressed/);
  expect(await page.evaluate(() => visualViewport?.scale)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

  const x = await page.evaluate(() => window.__BRAMBLE__!.snapshot().fighters[0].x);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [move] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [move, swing] });
  await expect(attack).toHaveClass(/pressed/);
  await expect(stick.locator(".stick-knob")).toHaveCSS("transform", /matrix/);
  await page.waitForFunction(
    (before) => window.__BRAMBLE__!.snapshot().fighters[0].x > before + 0.15,
    x,
  );
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(attack).not.toHaveClass(/pressed/);
  await expect(stick.locator(".stick-knob")).toHaveCSS("transform", "none");
  await expect(page.locator(".fullscreen-button")).toBeHidden();
  await page.locator(".pause-button").tap();
  await expect(page.locator(".fullscreen-pause-button")).toBeVisible();
  expect(errors).toEqual([]);
});

test("mobile fullscreen works in Chromium and the installed-app assets resolve under the preview base", async ({
  page,
  request,
}) => {
  const errors = await load(page);
  const toggle = page.locator(".fullscreen-button");
  await expect(toggle).toBeVisible();
  await toggle.tap();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.fullscreenElement === document.documentElement)).toBe(
    true,
  );
  await toggle.tap();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  const manifestLink = page.locator('link[rel="manifest"]');
  const manifestUrl = await manifestLink.evaluate((link: HTMLLinkElement) => link.href);
  expect(new URL(manifestUrl).pathname).toBe("/platform-h2h-battle/manifest.webmanifest");
  const manifestResponse = await request.get(manifestUrl);
  expect(manifestResponse.status()).toBe(200);
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    name: "BRAMBLE",
    scope: "./",
    start_url: "./",
    display: "fullscreen",
    display_override: ["fullscreen", "standalone"],
  });
  expect(manifest.icons).toHaveLength(3);
  expect(manifest.icons).toContainEqual(expect.objectContaining({ purpose: "maskable" }));
  const appleIcon = await page
    .locator('link[rel="apple-touch-icon"]')
    .evaluate((link: HTMLLinkElement) => link.href);
  for (const icon of [...manifest.icons, { src: appleIcon, sizes: "180x180" }]) {
    const response = await request.get(new URL(icon.src, manifestUrl).href);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toMatch(/^image\/png/);
    const png = await response.body();
    const [width, height] = icon.sizes.split("x").map(Number);
    expect(png.readUInt32BE(16)).toBe(width);
    expect(png.readUInt32BE(20)).toBe(height);
  }
  expect(errors).toEqual([]);
});

test("instructions stay zoomable, reset and pinch-out recovery both return to 1x, and touch controls work afterward", async ({
  page,
  context,
}) => {
  const errors = await load(page);
  const cdp = await context.newCDPSession(page);
  const notice = page.locator(".zoom-notice");

  const commitCompositor = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

  const zoomViaHelp = async () => {
    await page.locator(".pause-button").tap();
    await page.locator('.pause-panel [data-action="help"]').tap();
    await expect(page.locator("dialog.help-dialog")).toBeVisible();
    // Wait for compositor commit so hit-testing sees help-dialog (not the canvas behind it).
    await commitCompositor();
    await cdp.send("Input.synthesizePinchGesture", {
      x: 195,
      y: 400,
      scaleFactor: 1.5,
      relativeSpeed: 300,
      gestureSourceType: "touch",
    });
    await expect.poll(() => page.evaluate(() => visualViewport?.scale ?? 1)).toBeGreaterThan(1.2);
    await expect(page.locator("html")).toHaveAttribute("data-zoomed", "");
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog.help-dialog")).toBeHidden();
    await page.locator('.pause-panel [data-action="resume"]').dispatchEvent("click");
    await page.waitForFunction(() => window.__BRAMBLE__?.snapshot().phase === "playing");
    await expect(notice).toBeVisible();
    await commitCompositor();
  };

  // Start Training and exercise reset-button recovery first.
  await page.locator('button[data-mode="training"]').tap();
  await page.locator('[data-action="start"]').tap();
  await page.waitForFunction(() => window.__BRAMBLE__?.snapshot().phase === "playing");
  await zoomViaHelp();
  await notice.locator("button").dispatchEvent("click");
  await expect.poll(() => page.evaluate(() => visualViewport?.scale ?? 0)).toBeCloseTo(1, 2);
  await expect
    .poll(() => page.locator('meta[name="viewport"]').getAttribute("content"))
    .toBe("width=device-width, initial-scale=1, viewport-fit=cover");
  await expect(page.locator("html")).not.toHaveAttribute("data-zoomed", "");
  await expect(notice).toBeHidden();

  // Exercise manual 2-finger pinch-out recovery separately without pressing reset.
  await zoomViaHelp();
  expect(await page.evaluate(() => visualViewport?.scale ?? 1)).toBeGreaterThan(1.2);
  await cdp.send("Input.synthesizePinchGesture", {
    x: 195,
    y: 420,
    scaleFactor: 0.5,
    relativeSpeed: 300,
    gestureSourceType: "touch",
  });
  await expect.poll(() => page.evaluate(() => visualViewport?.scale ?? 0)).toBeCloseTo(1, 2);
  await expect(page.locator("html")).not.toHaveAttribute("data-zoomed", "");
  await expect(notice).toBeHidden();

  // Verify simultaneous stick and attack input still work cleanly after recovery.
  const stick = page.locator(".touch-stick");
  const attack = page.locator('.touch-attacks [data-attack="sweep"]');
  const stickBox = (await stick.boundingBox())!;
  const attackBox = (await attack.boundingBox())!;
  const move = { x: stickBox.x + stickBox.width * 0.8, y: stickBox.y + stickBox.height / 2, id: 1 };
  const swing = {
    x: attackBox.x + attackBox.width / 2,
    y: attackBox.y + attackBox.height / 2,
    id: 2,
  };
  const beforeX = await page.evaluate(() => window.__BRAMBLE__!.snapshot().fighters[0].x);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [move] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [move, swing] });
  await expect(attack).toHaveClass(/pressed/);
  await page.waitForFunction(
    (x) => window.__BRAMBLE__!.snapshot().fighters[0].x > x + 0.15,
    beforeX,
  );
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(attack).not.toHaveClass(/pressed/);
  expect(errors).toEqual([]);
});
