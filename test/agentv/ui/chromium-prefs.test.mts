// ADR-032's settings for the services' Chromium (bin/agentv-chromium-prefs)
// in a real Chromium: it reads them as its own, so it offers to save no
// password and fills no address or card, translates nothing and lets no
// site ask to send notifications. A setting name Chromium doesn't know would
// be dropped here, and the prompt would come back on the TV (S1.7).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(`${process.env.AGENTV_UI_MODULES}/`);
const { chromium } = require("playwright-core") as typeof import("playwright-core");

const ROOT = join(import.meta.dirname, "../../..");

test("S1.7 Chromium takes the services' profile's settings: no password, autofill, translate or notification prompts", async () => {
  const profile = mkdtempSync(join(tmpdir(), "agentv-services-"));
  execFileSync(join(ROOT, "bin/agentv-chromium-prefs"), [profile]);
  const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.AGENTV_UI_BROWSER, headless: true });
  try {
    const page = await context.newPage();
    await page.goto("chrome://prefs-internals");
    const prefs = JSON.parse(await page.evaluate(() => document.body.innerText));
    const value = (path: string) => path.split(".").reduce((at, key) => at?.[key], prefs)?.value;
    assert.equal(value("credentials_enable_service"), false, "saving passwords");
    assert.equal(value("credentials_enable_autosignin"), false, "signing in by itself");
    assert.equal(value("autofill.profile_enabled"), false, "addresses");
    assert.equal(value("autofill.credit_card_enabled"), false, "cards");
    assert.equal(value("translate.enabled"), false, "translate");
    assert.equal(value("profile.default_content_setting_values.notifications"), 2, "site notifications, blocked");
  } finally {
    await context.close();
  }
});
