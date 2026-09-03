/**
 * Arabic route sweep.
 *
 * The rtl-sweep spec proves the LAYOUT mirrors with English strings still in
 * place. This one proves the real thing: booted in Arabic from a cold load
 * (the stored preference is seeded before the app ever paints, the same way
 * a returning user's browser would have it), every route actually renders
 * Arabic, `dir` resolves to `rtl` on its own — nobody forces it — and the
 * same structural checks (no overflow, no page-level horizontal scroll)
 * still hold now that real Arabic text, not English placeholder text, is
 * what has to fit the layout.
 *
 * See docs/i18n/2026-09-03-admin-arabic-cloud-session-prompt.md's Part 2
 * verification: "Cold load with the stored preference: the first paint must
 * be Arabic, not English flipping to Arabic."
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

/** Arabic script block (؀-ۿ), matching the range used elsewhere in the i18n suite. */
const ARABIC = /[؀-ۿ]/;

/**
 * Pre-existing, out-of-scope gap this sweep surfaced: several settings and
 * billing surfaces hardcode their English strings with no `t()` call at all,
 * so they render in English under EVERY dashboard language, not just Arabic -
 * the same content shows English under Hindi today too. Not a regression
 * introduced by the Arabic rollout.
 *
 * The settings sub-navigation (`WorkspaceLayout.tsx`), the billing plan card
 * (`billing/PlanSummary.tsx`) and the affiliate page (`AffiliatePage.tsx`)
 * were wired up in the settings/billing/affiliate i18n follow-up, closing
 * `/billing`, `/settings/team` and `/settings/affiliate` at phone width. Still
 * open: `UsagePage.tsx` and `ReportsPage.tsx` have no `t()` call at all, so
 * `/billing/usage` and `/billing/reports` remain untranslated at phone width,
 * where the translated nav rail that satisfies the check at desktop width is
 * collapsed. Tracked as a follow-up task. Remove an entry once its page's
 * content is wired up, and rely on the ARABIC assertion to confirm the fix.
 */
const KNOWN_UNTRANSLATED_CONTENT = new Set(['/billing/usage@phone', '/billing/reports@phone']);

/** Same overflow walk as rtl-sweep.spec.ts — see that file for why scroll containers are skipped. */
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

test.describe('Arabic sweep (booted in ar-AE from a cold load)', () => {
  for (const { path, heading } of ROUTES) {
    for (const { name, width, height } of WIDTHS) {
      const known = KNOWN_UNTRANSLATED_CONTENT.has(`${path}@${name}`);
      const runner = known ? test.fixme : test;
      runner(`${path} @ ${name} renders Arabic, rtl, no overflow`, async ({ page }) => {
        await mockBackend(page);
        // Seeds the stored preference BEFORE the bundle evaluates, the same
        // way a returning Arabic-reading user's browser already has it -
        // this is what proves the first paint is Arabic, not a flip after
        // mount. See I18nProvider.tsx's preloadDictionary comment.
        await page.addInitScript(() => {
          window.localStorage.setItem('oc_ui_locale', 'ar-AE');
        });
        await page.setViewportSize({ width, height });
        await page.goto(path);
        await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible({ timeout: 20_000 });

        await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
        await expect(page.locator('html')).toHaveAttribute('lang', 'ar-AE');

        const bodyText = await page.locator('body').innerText();
        expect(ARABIC.test(bodyText), `expected Arabic text to render on ${path}`).toBe(true);

        mkdirSync('test-results/ar-sweep', { recursive: true });
        const safeName = path.replace(/\//g, '_') || '_root';
        await page.screenshot({
          path: `test-results/ar-sweep/${safeName}__${name}.png`,
          fullPage: false,
        });

        const { offenders, pageScrolls } = await overflowReport(page);
        expect(offenders, `overflowing elements on ${path} @ ${name}`).toEqual([]);
        expect(pageScrolls, `page-level horizontal scroll on ${path} @ ${name}`).toBe(false);
      });
    }
  }
});
