// Full screenshot sweep for the redesign loop.
//   node scripts/shots-all.mjs [label]
//   label: subfolder under .shots/ (default: "after")
//
// Shoots: login, then every demo role's landing + queue, plus the
// admin sub-views and a fully-populated ticket-detail page.
// Needs the app running on http://localhost:4000 and chromium installed
// (`npx playwright install chromium`).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const label = process.argv[2] || 'after';
const outDir = `.shots/${label}`;
mkdirSync(outDir, { recursive: true });

const ROLES = {
  admin: ['admin@campus.edu', 'Admin@123'],
  staff: ['rahul.it@campus.edu', 'Staff@123'],
  lead: ['priya.facilities@campus.edu', 'Staff@123'],
  custodian: ['warden@campus.edu', 'Custodian@123'],
  student: ['abhiuday.student@campus.edu', 'Student@123'],
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

async function shot(page, name) {
  await page.waitForTimeout(500);
  const path = `${outDir}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log(path);
}

async function session(role) {
  const [email, password] = ROLES[role];
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.evaluate(() => localStorage.removeItem('helpdesk_token'));
  await page.reload();
  await page.waitForSelector('.auth-card');
  if (role === 'admin') await shot(page, '00-login');

  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.shell', { timeout: 10000 });
  await shot(page, `${role}-01-landing`);

  const navKeys = await page.$$eval('[data-nav]', (els) => els.map((e) => e.dataset.nav));
  for (const key of navKeys) {
    await page.click(`[data-nav="${key}"]`);
    await page.waitForTimeout(500);
    if (key !== 'queue' || navKeys.indexOf(key) !== 0) await shot(page, `${role}-nav-${key}`);
    if (key === 'queue') {
      const row = await page.$('.row-link');
      if (row) {
        // open the fully-populated ticket (TCK-01018) if it's in view, else first row
        const target =
          (await page.$('.row-link:has(.ticket-no:text-is("TCK-01018"))')) || row;
        await target.click();
        await page.waitForSelector('.detail-head', { timeout: 8000 });
        await shot(page, `${role}-ticket-detail`);
      }
    }
  }
  await page.close();
}

for (const role of Object.keys(ROLES)) {
  await session(role).catch((e) => console.error(`${role}:`, e.message));
}

await browser.close();
