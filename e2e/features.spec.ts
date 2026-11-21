import { expect, test, type Page } from "@playwright/test";

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

test("default duel title scrolls at 1280x720, selects accept pointer clicks, and stages/presets persist", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const errors = await load(page);

  // Title <select> controls accept real pointer interaction despite #interface pointer-events: none.
  const levelSelect = page.locator('.player-level[data-override="1"]');
  expect(await levelSelect.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("auto");
  await levelSelect.selectOption("hard");
  await expect(levelSelect).toHaveValue("hard");

  // Stage preview and rule presets update live state and persist across reload.
  for (const stage of ["ruins", "bridges", "factory"] as const) {
    await page.locator(`button[data-stage="${stage}"]`).click();
    await expect
      .poll(() => page.evaluate(() => window.__BRAMBLE__!.snapshot().options.stage))
      .toBe(stage);
  }
  await page.locator('[data-preset="noGimmicks"]').click();
  await expect
    .poll(() => page.evaluate(() => window.__BRAMBLE__!.snapshot().rules.gimmicks))
    .toEqual({ collapse: false, safeZone: false, bombs: false, wind: false });

  // At 1280x720, scrolling the title menu column reaches both Start and Tutorial via mouse.
  const menuContent = page.locator(".menu-content");
  await menuContent.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const startButton = page.locator('[data-action="start"]');
  const tutorialButton = page.locator(".tutorial-entry");
  await expect(startButton).toBeInViewport();
  await expect(tutorialButton).toBeInViewport();
  await tutorialButton.click();
  await expect(page.locator("dialog.tutorial-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog.tutorial-dialog")).toBeHidden();

  await page.reload();
  await page.waitForFunction(() => Boolean(window.__BRAMBLE__));
  expect(await page.evaluate(() => window.__BRAMBLE__!.snapshot().options.stage)).toBe("factory");
  expect(errors).toEqual([]);
});

test("interactive tutorial launches from title, completes cancel lesson, and hands off cleanly to duel", async ({
  page,
}) => {
  const errors = await load(page);

  const tutorialButton = page.locator(".tutorial-entry");
  await tutorialButton.scrollIntoViewIfNeeded();
  await tutorialButton.click();
  const dialog = page.locator("dialog.tutorial-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".tutorial-list button")).toHaveCount(9);

  await dialog.locator('[data-tutor="cancel"]').click();
  await dialog.locator('[data-tutor="play"]').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#interface")).toHaveAttribute("data-tutorial", "keyboard");
  await expect(page.locator(".tutorial-hud")).toBeVisible();
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().phase === "playing");

  // Hold overhead to enter charge, then press Q to cancel and complete the lesson.
  await page.keyboard.down("KeyJ");
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().fighters[0]!.mode === "charge");
  await page.keyboard.press("KeyQ");
  await page.keyboard.up("KeyJ");

  await expect(dialog).toBeVisible();
  await expect(page.locator(".result-screen")).toBeHidden();
  await dialog.locator('[data-tutor="summary"]').click();
  await expect(dialog.locator("#tutorial-heading")).toHaveText("学習のまとめ");

  await dialog.locator('[data-tutor="duel"]').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#interface")).not.toHaveAttribute("data-tutorial");
  await page.waitForFunction(
    () =>
      window.__BRAMBLE__!.snapshot().mode === "duel" &&
      ["countdown", "playing"].includes(window.__BRAMBLE__!.snapshot().phase),
  );
  expect(errors).toEqual([]);
});

test("training overhaul supports dummy setup, state overlay, input recording/playback, and quick reset", async ({
  page,
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  const errors = await load(page);

  await page.locator('button[data-mode="training"]').click();
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().phase === "playing");

  // Open training settings via T, configure dummy attack, starting damage, infinite stamina, hitboxes & overlay.
  await page.keyboard.press("KeyT");
  const dialog = page.locator("dialog.training-dialog");
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => window.__BRAMBLE__!.snapshot().phase)).toBe("paused");

  await dialog.locator('select[data-key="behavior"]').selectOption("repeatAttack");
  await dialog.locator('select[data-key="attack"]').selectOption("thrust");
  await dialog.locator('button[data-slot="0"][data-value="50"]').click();
  await dialog.locator('input[data-key="infinite"]').check();
  await dialog.locator('input[data-key="hitboxes"]').check();
  await dialog.locator('input[data-key="overlay"]').check();
  await dialog.locator("[data-pad-back]").click();
  await expect(dialog).toBeHidden();
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().phase === "playing");

  // State overlay renders live info, infinite stamina stays at 100 after dodging, and dummy attacks.
  await expect(page.locator(".training-state")).toBeVisible();
  await expect(page.locator(".training-state pre").first()).toContainText("1P");
  await page.keyboard.press("ShiftLeft");
  await page.waitForFunction(
    () =>
      window.__BRAMBLE__!.snapshot().fighters[0]!.damage === 50 &&
      window.__BRAMBLE__!.snapshot().fighters[0]!.stamina === 100,
  );
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().fighters[1]!.attack === "thrust");

  // Record a short 1P input sequence and replay it on the dummy.
  await page.keyboard.press("KeyT");
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-record]").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".training-status")).toContainText("記録中");
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(250);
  await page.keyboard.up("KeyD");
  await page.locator(".training-hud [data-stop]").click();
  await expect(page.locator(".training-status")).toContainText("待機");

  await page.keyboard.press("KeyT");
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-play]").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".training-status")).toContainText("再生中");

  // Quick reset via R restores starting damage cleanly.
  await page.keyboard.press("KeyR");
  await page.waitForFunction(() => {
    const f = window.__BRAMBLE__!.snapshot().fighters[0]!;
    return f.damage === 50 && f.mode === "idle";
  });
  expect(errors).toEqual([]);
});

test("BO3 set play and CPU ladder show their own HUDs and ladder leaves duel settings untouched", async ({
  page,
}) => {
  const errors = await load(page);

  await page.locator('button[data-mode="duel"]').click();
  await page.locator('[data-stocks="2"]').click();
  await page.locator('[data-set-format="bo3"]').click();
  await page.locator('button[data-stage="factory"]').click();
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().phase === "playing");

  await expect(page.locator(".match-set-score")).toBeVisible();
  await expect(page.locator(".match-set-score")).toContainText("YOU 0勝 – CPU 01 0勝");
  await page.keyboard.press("Escape");
  await expect(page.locator(".pause-exit-note")).toBeVisible();
  await page.locator('.pause-screen [data-action="menu"]').click();
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().phase === "menu");

  // Start CPU Ladder, verify round HUD, then exit and verify duel choices were not overwritten.
  await page.locator('button[data-mode="ladder"]').click();
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().phase === "playing");
  await expect(page.locator(".ladder-hud")).toBeVisible();
  await expect(page.locator(".ladder-hud")).toContainText("第1戦 / 全4戦");
  await page.keyboard.press("Escape");
  await page.locator('.pause-screen [data-action="menu"]').click();
  await page.waitForFunction(() => window.__BRAMBLE__!.snapshot().phase === "menu");

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("bramble.match.v1")!));
  expect(saved).toMatchObject({ stocks: 2, setFormat: "bo3", stage: "factory" });
  expect(errors).toEqual([]);
});

test("audio mix sliders, mute sync, and reducedFlash persist across reloads", async ({ page }) => {
  const errors = await load(page);

  const settingsButton = page.getByRole("button", { name: "グラフィック設定を開く" });
  const dialog = page.locator(".settings-dialog");
  await settingsButton.click();
  await expect(dialog).toBeVisible();

  await dialog.locator('input[data-setting="bgmVolume"]').fill("35");
  await dialog.locator('input[data-setting="seVolume"]').fill("50");
  await dialog.locator('input[data-setting="reducedFlash"]').check();
  await expect(dialog.locator('[data-output="bgmVolume"]')).toHaveText("35%");
  await expect(dialog.locator('[data-output="seVolume"]')).toHaveText("50%");
  await expect(page.locator("#interface")).toHaveAttribute("data-reduced-flash", "");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Topbar sound button toggles mute and syncs across reload.
  const soundButton = page.locator('[data-action="sound"]');
  await expect(soundButton).toHaveAttribute("aria-pressed", "true");
  await soundButton.click();
  await expect(soundButton).toHaveAttribute("aria-pressed", "false");

  await page.reload();
  await page.waitForFunction(() => Boolean(window.__BRAMBLE__));
  await expect(page.locator('[data-action="sound"]')).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#interface")).toHaveAttribute("data-reduced-flash", "");
  await settingsButton.click();
  await expect(dialog.locator('input[data-setting="bgmVolume"]')).toHaveValue("35");
  await expect(dialog.locator('input[data-setting="seVolume"]')).toHaveValue("50");
  await expect(dialog.locator('input[data-setting="reducedFlash"]')).toBeChecked();
  expect(errors).toEqual([]);
});
