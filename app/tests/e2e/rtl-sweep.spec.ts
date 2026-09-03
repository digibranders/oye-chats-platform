/**
 * RTL layout sweep.
 *
 * Walks a representative set of routes with `dir="rtl"` forced (the English
 * strings stay put; only the layout mirrors) and asserts the two structural
 * failures a passing unit-test suite cannot see, because jsdom never lays
 * anything out:
 *
 *   1. No element overflows the viewport on either side.
 *   2. The page itself never grows a horizontal scrollbar.
 *
 * A screenshot per route is written to `test-results/rtl-sweep/` at both a
 * desktop and a phone width, for the visual pass described in
 * `docs/i18n/2026-09-03-admin-arabic-cloud-session-prompt.md` (Part 1
 * verification) — this spec is the scripted half of that check; a human
 * still has to look at the images once.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

import { mockBackend, BOT_ID } from './mockBackend';

const ROUTES: Array<{ path: string; heading: string | RegExp }> = [
  { path: '/', heading: /./ },
  { path: '/chatbots', heading: /./ },
  { path: `/chatbots/${BOT_ID}/overview`, heading: /./ },
  { path: `/chatbots/${BOT_ID}/knowledge`, heading: /./ },
  { path: `/chatbots/${BOT_ID}/experience`, heading: /./ },
  { path: `/chatbots/${BOT_ID}/deploy`, heading: /./ },
  { path: `/chatbots/${BOT_ID}/qualification`, heading: /./ },
  { path: `/chatbots/${BOT_ID}/behaviour`, heading: /./ },
  { path: `/chatbots/${BOT_ID}/quotation`, heading: /./ },
  { path: '/inbox', heading: /./ },
  { path: '/leads', heading: /./ },
  { path: '/journey', heading: /./ },
  { path: '/analytics', heading: /./ },
  { path: '/billing', heading: /./ },
  { path: '/billing/usage', heading: /./ },
  { path: '/billing/reports', heading: /./ },
  { path: '/settings/workspace', heading: /./ },
  { path: '/settings/team', heading: /./ },
  { path: '/settings/integrations', heading: /./ },
  { path: '/settings/developers', heading: /./ },
  { path: '/settings/affiliate', heading: /./ },
  { path: '/account', heading: /./ },
];

const WIDTHS: Array<{ name: string; width: number; height: number }> = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 375, height: 812 },
];

/**
 * Every element whose box extends past the viewport on either side, plus
 * whether the page itself scrolls horizontally.
 *
 * An element inside a container that is DELIBERATELY horizontally scrollable
 * (`overflow-x: auto|scroll` - a wide `DataTable`, a `CodeBlock`) is expected
 * to extend past its own viewport-visible slice; that is what the scroller
 * is for, and only the scroller's own outer box has to fit the page. So the
 * walk skips any element with a scrollable ancestor and instead checks that
 * ancestor itself once, at the point it is reached.
 */
async function overflowReport(page: Page): Promise<{ offenders: string[]; pageScrolls: boolean }> {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const offenders: string[] = [];

    function isScrollableX(el: Element): boolean {
      return /(auto|scroll)/.test(getComputedStyle(el).overflowX);
    }

    function label(el: Element): string {
      const cls =
        el.className && typeof el.className === 'string'
          ? `.${el.className.split(' ').filter(Boolean).slice(0, 2).join('.')}`
          : '';
      return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + cls;
    }

    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      // Skip anything nested inside a scroll container - it is checked once,
      // as that container, not once per descendant.
      let ancestorScrolls = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (isScrollableX(p)) {
          ancestorScrolls = true;
          break;
        }
      }
      if (ancestorScrolls) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      // A couple of px of slack: a translated panel mid-close-animation or a
      // hairline scrollbar gutter is not a layout defect.
      if (rect.left < -2 || rect.right > vw + 2) {
        offenders.push(`${label(el)} [left=${Math.round(rect.left)} right=${Math.round(rect.right)} vw=${vw}]`);
      }
    }
    return {
      offenders: offenders.slice(0, 15),
      pageScrolls: document.documentElement.scrollWidth > window.innerWidth + 2,
    };
  });
}

test.describe('RTL sweep (English strings, dir forced)', () => {
  for (const { path, heading } of ROUTES) {
    for (const { name, width, height } of WIDTHS) {
      test(`${path} @ ${name} mirrors with no overflow`, async ({ page }) => {
        await mockBackend(page);
        await page.setViewportSize({ width, height });
        await page.goto(path);
        await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible({ timeout: 20_000 });

        await page.evaluate(() => {
          document.documentElement.setAttribute('dir', 'rtl');
        });
        // One frame for layout to settle after the mirror.
        await page.waitForTimeout(150);

        mkdirSync('test-results/rtl-sweep', { recursive: true });
        const safeName = path.replace(/\//g, '_') || '_root';
        await page.screenshot({
          path: `test-results/rtl-sweep/${safeName}__${name}.png`,
          fullPage: false,
        });

        const { offenders, pageScrolls } = await overflowReport(page);
        expect(offenders, `overflowing elements on ${path} @ ${name}`).toEqual([]);
        expect(pageScrolls, `page-level horizontal scroll on ${path} @ ${name}`).toBe(false);
      });
    }
  }
});
