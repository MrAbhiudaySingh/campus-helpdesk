// Screenshot helper for the redesign loop.
//   node scripts/shots.mjs [role] [outDir]
//   role: student | staff | admin | custodian   (default: admin)
//   outDir: where PNGs land                      (default: ./.shots)
//
// Needs the app running (default http://localhost:4000) and Playwright's
// chromium installed (`npx playwright install chromium`).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const role = process.argv[2] || 'admin';
const outDir = process.argv[3] || '.shots';
const LOGINS = {
  student: ['abhiuday.student@campus.edu', 'Student@123'],
  staff: ['rahul.it@campus.edu', 'Staff@123'],
  admin: ['admin@campus.edu', 'Admin@123'],
  custodian: ['warden@campus.edu', 'Custodian@123'],
};
const [email, password] = LOGINS[role] || LOGINS.admin;

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });

async function shot(name) {
  await page.waitForTimeout(600);
  const path = `${outDir}/${role}-${name}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log(path);
}

await page.goto(BASE);
await shot('01-login');
await page.fill('input[name="email"]', email);
await page.fill('input[name="password"]', password);
await page.click('button[type="submit"]');
await page.waitForSelector('.shell', { timeout: 10000 });
await shot('02-landing');

// walk the nav — re-query each time, render() rebuilds the DOM on click
const navKeys = await page.$$eval('[data-nav]', (els) => els.map((e) => e.dataset.nav));
for (const key of navKeys) {
  await page.click(`[data-nav="${key}"]`);
  await shot(`nav-${key}`);
  if (key === 'queue') {
    await page.waitForTimeout(600);
    const row = await page.$('.row-link');
    if (row) {
      await row.click();
      await shot('ticket-detail');
      await page.click(`[data-nav="${key}"]`); // back to queue for the next nav item
    }
  }
}

await browser.close();
