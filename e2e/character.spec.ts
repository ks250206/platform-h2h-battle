import { expect, test, type Page } from "@playwright/test";

/** Character selection and looks: the picker on the title, its live preview, and what a match shows. */

type Look = { species: string; palette: string; accessory: string };

async function load(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("Browser error:", error.message);
  });
  await page.goto("./");
  await page.waitForFunction(() => Boolean(window.__BRAMBLE__));
  await expect(page.locator("#arena canvas")).toBeVisible();
  return errors;
}

/** What the fighters in the arena (the title's line-up, or the match) look like right now. */
const shown = (page: Page) =>
  page.evaluate(() =>
    window.__BRAMBLE__!.snapshot().fighters.map((f) => ({
      name: f.name,
      species: f.species,
      palette: f.palette,
      accessory: f.accessory,
    })),
  );
const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("bramble.match.v1") ?? "null"));
const characterButton = (page: Page, slot: number) =>
  page.locator(`.player-row[data-slot="${slot}"] .player-character`);

async function pick(page: Page, look: Partial<Look>, tap = false) {
  const dialog = page.locator(".character-dialog");
  for (const [attribute, value] of Object.entries(look)) {
    const option = dialog.locator(`[data-${attribute}="${value}"]`);
    await (tap ? option.tap() : option.click());
    await expect(option).toHaveAttribute("aria-pressed", "true");
  }
}

test("a look is chosen with a live preview, cancelled, confirmed and kept across a reload", async ({
  page,
}) => {
  const errors = await load(page);
  const dialog = page.locator(".character-dialog");
  // The title lines up the original cast.
  expect(await shown(page)).toMatchObject([
    { name: "コハク", species: "fox", palette: "coral", accessory: "none" },
    { name: "シロ", species: "rabbit", palette: "sky", accessory: "none" },
  ]);
  await expect(characterButton(page, 0)).toContainText("コハク");

  // Keyboard: the row's character button opens the picker on that slot.
  await characterButton(page, 0).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-customize-slot="0"]')).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.locator('[data-species="fox"]')).toBeFocused();
  await expect(dialog.locator('[data-action="revert-character"]')).toBeDisabled();
  await expect(dialog.locator(".character-note")).toContainText("見た目だけの変更です");

  // Every choice shows on the fighter in the arena at once.
  await pick(page, { species: "bear", palette: "mint", accessory: "crown" });
  await expect
    .poll(() => shown(page))
    .toMatchObject([
      { name: "モカ", species: "bear", palette: "mint", accessory: "crown" },
      { name: "シロ", species: "rabbit", palette: "sky", accessory: "none" },
    ]);
  await expect(dialog.locator(".character-summary")).toContainText("モカ");
  await expect(dialog.locator(".character-summary")).toContainText("ミニ王冠");
  await expect(page.locator(".menu-content")).toBeHidden();
  await page.screenshot({ path: "test-results/character-picker.png" });

  // Esc is "back": every slot looks as it did when the picker opened.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect.poll(() => shown(page)).toMatchObject([{ species: "fox", accessory: "none" }, {}]);
  await expect(characterButton(page, 0)).toContainText("コハク");
  await expect(characterButton(page, 0)).toBeFocused();

  // Mouse: both slots take the very same look; the other slot is reached through its tab.
  await characterButton(page, 0).click();
  await pick(page, { species: "bear", palette: "mint", accessory: "crown" });
  await dialog.locator('[data-customize-slot="1"]').click();
  await pick(page, { species: "bear", palette: "mint", accessory: "crown" });
  // 元に戻す puts both back without closing; then they are chosen again and confirmed.
  await dialog.locator('[data-action="revert-character"]').click();
  await expect.poll(() => shown(page)).toMatchObject([{ species: "fox" }, { species: "rabbit" }]);
  await pick(page, { species: "bear", palette: "mint", accessory: "crown" });
  await dialog.locator('[data-customize-slot="0"]').click();
  await pick(page, { species: "bear", palette: "mint", accessory: "crown" });
  const controlsBefore = (await saved(page)).controls;
  await dialog.locator('[data-action="confirm-character"]').click();
  await expect(dialog).toBeHidden();
  const same = { species: "bear", palette: "mint", accessory: "crown" };
  expect((await saved(page)).loadouts.slice(0, 2)).toEqual([same, same]);
  // Looks never touch who plays what.
  expect((await saved(page)).controls).toEqual(controlsBefore);
  await expect(page.locator('.player-row[data-slot="0"] .player-device')).toHaveValue("keyboard");
  await expect(page.locator('.player-row[data-slot="1"] .player-device')).toHaveValue("cpu");

  // The match starts with two identical fighters, told apart by tag and by the slot's shape.
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().phase === "playing");
  expect(await shown(page)).toMatchObject([
    { name: "モカ", ...same },
    { name: "モカ", ...same },
  ]);
  await expect(page.locator(".fighter-card .fighter-tag")).toHaveText(["YOU", "CPU 01"]);
  await expect(page.locator(".fighter-card .fighter-name")).toHaveText(["モカ", "モカ"]);
  const glyphs = await page
    .locator(".fighter-card .fighter-tag .slot-glyph polygon")
    .evaluateAll((polygons) => polygons.map((polygon) => polygon.getAttribute("points")));
  expect(glyphs).toHaveLength(2);
  expect(new Set(glyphs).size).toBe(2);
  await page.screenshot({ path: "test-results/character-same-look-duel.png" });

  // Back on the title and after a reload the looks are still there.
  await page.keyboard.press("Escape");
  await page.locator('.pause-screen [data-action="menu"]').click();
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().phase === "menu");
  expect(await shown(page)).toMatchObject([same, same]);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__BRAMBLE__));
  await expect(characterButton(page, 0)).toContainText("モカ");
  await expect(characterButton(page, 1)).toContainText("モカ");
  expect(await shown(page)).toMatchObject([same, same]);

  // The field guide says how to pick a look and that it gives no advantage.
  await page.getByRole("button", { name: "操作方法を表示" }).click();
  await expect(page.locator(".character-help")).toContainText("見た目による性能差はありません");
  expect(errors).toEqual([]);
});

test("four fighters in the same look keep their own tags in a rumble, and old saves still load", async ({
  page,
}) => {
  const same = { species: "raccoon", palette: "berry", accessory: "goggles" };
  // Saved by an earlier version: no looks at all. Then a save with junk in it.
  await page.addInitScript((look) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem(
      "bramble.match.v1",
      JSON.stringify({ controls: { 0: "keyboard" }, stocks: 2, difficulty: "easy", overrides: {} }),
    );
    sessionStorage.setItem("look", JSON.stringify(look));
  }, same);
  const errors = await load(page);
  expect((await shown(page)).map((f) => f.name)).toEqual(["コハク", "シロ"]);
  await expect(page.locator('[data-stocks="2"]')).toHaveAttribute("aria-pressed", "true");

  await page.evaluate(() => {
    const look = JSON.parse(sessionStorage.getItem("look")!);
    localStorage.setItem(
      "bramble.match.v1",
      JSON.stringify({
        controls: { 0: "keyboard" },
        stocks: 2,
        difficulty: "easy",
        overrides: {},
        loadouts: [look, look, { ...look, species: "dragon" }, "junk"],
      }),
    );
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__BRAMBLE__));
  await page.locator('button[data-mode="rumble"]').click();
  // The bad animal and the junk entry fall back to their slots' own cast members.
  await expect
    .poll(() => shown(page))
    .toMatchObject([
      { name: "スミ", ...same },
      { name: "スミ", ...same },
      { name: "モカ", species: "bear", palette: "berry", accessory: "goggles" },
      { name: "スミ", species: "raccoon", palette: "marigold", accessory: "none" },
    ]);

  // The last slot joins the others through the picker: four of the same.
  await characterButton(page, 3).click();
  await pick(page, { palette: "berry", accessory: "goggles" });
  await page.locator('.character-dialog [data-customize-slot="2"]').click();
  await pick(page, { species: "raccoon" });
  await page.locator('.character-dialog [data-action="confirm-character"]').click();
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().phase === "playing");
  expect(await shown(page)).toMatchObject([same, same, same, same]);
  await expect(page.locator(".fighter-card .fighter-tag")).toHaveText([
    "YOU",
    "CPU 01",
    "CPU 02",
    "CPU 03",
  ]);
  const glyphs = await page
    .locator(".fighter-card .fighter-tag .slot-glyph polygon")
    .evaluateAll((polygons) => polygons.map((polygon) => polygon.getAttribute("points")));
  expect(new Set(glyphs).size).toBe(4);
  // The CPUs still fight: the look changed nothing about how they play.
  await page.waitForFunction(() =>
    window
      .__BRAMBLE__!.snapshot()
      .fighters.slice(1)
      .some((f) => f.mode !== "idle"),
  );
  await page.screenshot({ path: "test-results/character-same-look-rumble.png" });
  expect(errors).toEqual([]);
});

test("the picker works by touch and leaves the fighter in view on a phone", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = await load(page);
  const dialog = page.locator(".character-dialog");
  await characterButton(page, 1).tap();
  await expect(dialog).toBeVisible();
  await pick(page, { species: "fox", palette: "lavender", accessory: "flower" }, true);
  await expect
    .poll(() => shown(page))
    .toMatchObject([{}, { name: "コハク", palette: "lavender", accessory: "flower" }]);
  // The picker docks along the bottom; the fighter being dressed stays visible above it.
  const box = (await dialog.boundingBox())!;
  expect(box.y).toBeGreaterThan(844 * 0.4);
  const fighter = await page.evaluate(() => {
    const f = window.__BRAMBLE__!.snapshot().fighters[1]!;
    return window.__BRAMBLE__!.screen(f.x, 1, f.z);
  });
  expect(fighter!.y).toBeGreaterThan(60);
  expect(fighter!.y).toBeLessThan(box.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: "test-results/character-picker-mobile.png" });
  // Cancel by touch puts the old look back; choosing again and 決定 keeps the new one.
  await dialog.locator(".character-foot [data-action='cancel-character']").tap();
  await expect(dialog).toBeHidden();
  await expect.poll(() => shown(page)).toMatchObject([{}, { name: "シロ", accessory: "none" }]);
  await characterButton(page, 1).tap();
  await pick(page, { accessory: "beret" }, true);
  await dialog.locator('[data-action="confirm-character"]').tap();
  await expect(dialog).toBeHidden();
  expect((await saved(page)).loadouts[1]).toEqual({
    species: "rabbit",
    palette: "sky",
    accessory: "beret",
  });
  await page.locator('[data-action="start"]').tap();
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().phase !== "menu");
  expect((await shown(page))[1]).toMatchObject({ name: "シロ", accessory: "beret" });
  expect(errors).toEqual([]);
  await context.close();
});
