import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

/** Portrait phones: the iPhone 12–15 size and the iPhone SE. */
const PHONES = [
  { name: "390x844", width: 390, height: 844 },
  { name: "375x667", width: 375, height: 667 },
] as const;

async function phone(browser: Browser, width: number, height: number) {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("Browser error:", error.message);
  });
  await page.goto("./");
  await page.waitForFunction(() => Boolean(window.__BRAMBLE__));
  await expect(page.locator("#arena canvas")).toBeVisible();
  return { context, page, errors };
}

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  expect(rect).not.toBeNull();
  return rect!;
}

/** The element itself (not the pinned Start block or a sheet) answers a tap at its centre. */
async function hitsItself(locator: Locator) {
  return locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === el || el.contains(hit);
  });
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

for (const size of PHONES) {
  test(`phone title at ${size.name}: hero band, sheet and pinned Start all fit`, async ({
    browser,
  }) => {
    const { context, page, errors } = await phone(browser, size.width, size.height);
    const visible = [
      page.locator('button[data-mode="duel"]'),
      page.locator('button[data-mode="ladder"]'),
      page.locator('button[data-stage="garden"]'),
      page.locator('button[data-stage="factory"]'),
      page.locator(".stage-detail"),
      page.locator(".rules-toggle"),
      page.locator(".player-character").first(),
      page.locator('[data-action="start"]'),
      page.locator(".tutorial-entry"),
    ];
    for (const locator of visible) {
      await expect(locator).toBeVisible();
      await expect(locator).toBeInViewport({ ratio: 1 });
      expect(await hitsItself(locator)).toBe(true);
    }
    await noHorizontalOverflow(page);
    // The headline is still there for screen readers, just not drawn over the arena.
    await expect(page.getByRole("heading", { name: /小さな体に、.*大きな一撃。/ })).toHaveCount(1);

    // The top bar and the sheet never meet; the hero band in between is left to the 3D scene.
    const topbar = await box(page.locator(".topbar"));
    const sheet = await box(page.locator(".menu-content"));
    expect(topbar.y + topbar.height).toBeLessThanOrEqual(sheet.y);
    expect(sheet.y).toBeGreaterThan(size.height * 0.3);
    expect(sheet.x).toBe(0);
    expect(sheet.width).toBe(size.width);
    // Phone top bar budget on the title: no camera button.
    await expect(page.locator(".topbar .camera-button")).toBeHidden();

    // The pinned Start block stays clear of the stage words.
    const cta = await box(page.locator(".menu-cta"));
    const detail = await box(page.locator(".stage-detail"));
    expect(detail.y + detail.height).toBeLessThanOrEqual(cta.y);
    expect(cta.y + cta.height).toBeLessThanOrEqual(size.height + 1);

    // The line-up stands in the hero band, under the top bar and above the sheet.
    const fighters = await page.evaluate(() =>
      window.__BRAMBLE__!.snapshot().fighters.map((f) => window.__BRAMBLE__!.screen(f.x, 1, f.z)),
    );
    for (const point of fighters) {
      expect(point!.y).toBeGreaterThan(topbar.y + topbar.height);
      expect(point!.y).toBeLessThan(sheet.y);
    }
    await page.screenshot({ path: `test-results/mobile-title-${size.name}.png` });

    // The rules sheet: open from the summary, change lives and a gimmick, close with 完了.
    const toggle = page.locator(".rules-toggle");
    const panel = page.locator("#match-rules-panel");
    await expect(panel).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.tap();
    await expect(panel).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const panelBox = await box(panel);
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(size.height + 1);
    expect(panelBox.y).toBeGreaterThanOrEqual(0);
    const done = panel.locator("[data-rules-close]");
    await expect(done).toBeInViewport({ ratio: 1 });
    await panel.locator('[data-stocks="2"]').tap();
    await panel.locator('[data-gimmick="wind"]').tap();
    await expect
      .poll(() => page.evaluate(() => window.__BRAMBLE__!.snapshot().options.stocks))
      .toBe(2);
    await expect
      .poll(() => page.evaluate(() => window.__BRAMBLE__!.snapshot().rules.gimmicks.wind))
      .toBe(false);
    await page.screenshot({ path: `test-results/mobile-rules-${size.name}.png` });
    await done.tap();
    await expect(panel).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".rules-toggle-summary")).toContainText("カスタム");
    await expect(page.locator(".rules-toggle-summary")).toContainText("残機2");
    await noHorizontalOverflow(page);

    // The ladder's overview fits the same sheet above the pinned Start.
    await page.locator('button[data-mode="ladder"]').tap();
    await expect(page.locator(".ladder-overview")).toBeVisible();
    await expect(page.locator('[data-action="start"]')).toBeInViewport({ ratio: 1 });
    await expect(page.locator(".rules-toggle")).toBeHidden();
    const ladder = await box(page.locator(".ladder-overview"));
    expect(ladder.y).toBeGreaterThan(topbar.y + topbar.height);
    await noHorizontalOverflow(page);
    expect(errors).toEqual([]);
    await context.close();
  });
}

test("phone training at 390x844: slim cards above the touch controls, pills inside the screen", async ({
  browser,
}) => {
  const { context, page, errors } = await phone(browser, 390, 844);
  await page.locator('button[data-mode="training"]').tap();
  await expect(page.locator(".rules-toggle")).toBeHidden();
  await page.locator('[data-action="start"]').tap();
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().phase === "playing");
  await expect(page.locator(".touch-controls")).toBeVisible();

  // The training pills: inside the screen, touch words only, no empty "待機 · 記録なし" line.
  const hud = page.locator(".training-hud");
  await expect(hud).toBeVisible();
  const hudBox = await box(hud);
  expect(hudBox.x).toBeGreaterThanOrEqual(8);
  expect(hudBox.x + hudBox.width).toBeLessThanOrEqual(382);
  for (const button of [hud.locator("[data-open]"), hud.locator("[data-reset]")]) {
    await expect(button).toBeInViewport({ ratio: 1 });
    await expect(button.locator(".shortcut-hint")).toBeHidden();
  }
  await expect(hud.locator("[data-open]")).toHaveText("稽古設定T / 十字↑");
  await expect(hud.locator(".training-status")).toBeHidden();
  // During a match the phone's top bar keeps sound, camera and pause: settings live in pause.
  await expect(page.locator(".topbar .settings-button")).toBeHidden();
  await expect(page.locator(".topbar .help-button")).toBeHidden();
  await expect(page.locator(".topbar .pause-button")).toBeVisible();

  // Slim cards, side by side, clear of the controls and of the pills.
  const cards = page.locator(".fighter-card");
  await expect(cards).toHaveCount(2);
  const controls = await box(page.locator(".touch-controls"));
  const first = await box(cards.nth(0));
  const second = await box(cards.nth(1));
  for (const card of [first, second]) {
    expect(card.height).toBeLessThanOrEqual(85);
    expect(card.y + card.height).toBeLessThanOrEqual(controls.y);
    expect(card.y).toBeGreaterThan(hudBox.y + hudBox.height);
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(390);
  }
  expect(first.x + first.width).toBeLessThanOrEqual(second.x);
  await expect(cards.first().locator(".fighter-damage")).toBeVisible();
  await expect(cards.first().locator(".stamina-track")).toBeVisible();
  await expect(cards.first().locator(".fighter-avatar")).toBeHidden();

  // The middle of the screen is open arena: nothing of the HUD on it, and room above the cards.
  const open = await page.evaluate(
    ([top, bottom]) =>
      [0.25, 0.5, 0.75].every((x) =>
        [0.35, 0.5, 0.65].every((y) => {
          const py = top + (bottom - top) * y;
          return document.elementFromPoint(innerWidth * x, py)?.matches("#arena canvas");
        }),
      ),
    [hudBox.y + hudBox.height, first.y],
  );
  expect(open).toBe(true);
  expect(first.y - (hudBox.y + hudBox.height)).toBeGreaterThan(844 * 0.45);
  await noHorizontalOverflow(page);
  await page.screenshot({ path: "test-results/mobile-training-390x844.png" });

  // A tap on the pill still opens the settings.
  await hud.locator("[data-open]").tap();
  await expect(page.locator("dialog.training-dialog")).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});
