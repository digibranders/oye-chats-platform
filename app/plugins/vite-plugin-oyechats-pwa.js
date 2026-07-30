import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Post-bundle injector for the OyeChats service worker.
 *
 * Vite copies `public/sw.js` to `dist/sw.js` verbatim. After the bundle is
 * written, we swap two sentinels in place so the SW knows exactly which
 * assets to precache and which cache-version to own:
 *
 *   '__OYECHATS_BUILD_ID__'                 → deterministic hash of asset names
 *   /* @__OYECHATS_PRECACHE__ * / []        → JSON array of precache URLs
 *
 * In dev the placeholders remain, the SW detects them (BUILD_ID starts with
 * '__') and skips precaching entirely - safe for the hot-reload workflow.
 */
export function oyechatsPwaPlugin() {
  const BUILD_ID_SENTINEL = "'__OYECHATS_BUILD_ID__'";
  const PRECACHE_SENTINEL = '/* @__OYECHATS_PRECACHE__ */ []';

  const STATIC_PRECACHE_URLS = [
    '/',
    '/index.html',
    '/manifest.webmanifest',
    '/offline.html',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/apple-touch-icon-180.png',
  ];

  let outDir = 'dist';

  return {
    name: 'oyechats-pwa',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      outDir = config.build.outDir || 'dist';
    },
    closeBundle() {
      const distDir = path.resolve(outDir);
      const swPath = path.join(distDir, 'sw.js');

      let sw;
      try {
        sw = readFileSync(swPath, 'utf8');
      } catch {
        const publicSwPath = path.join(distDir, '..', 'public', 'sw.js');
        try {
          sw = readFileSync(publicSwPath, 'utf8');
        } catch (fallbackErr) {
          this.error(`[oyechats-pwa] sw.js not found at ${swPath} or ${publicSwPath}: ${fallbackErr.message}`);
          return;
        }
      }

      const assetsDir = path.join(distDir, 'assets');
      let bundledAssetUrls = [];
      try {
        const entries = readdirSync(assetsDir);
        bundledAssetUrls = entries
          .filter((name) => /\.(js|css)$/i.test(name))
          .filter((name) => {
            const stat = statSync(path.join(assetsDir, name));
            return stat.isFile() && stat.size > 0;
          })
          .sort()
          .map((name) => `/assets/${name}`);
      } catch (err) {
        this.warn(`[oyechats-pwa] no assets dir at ${assetsDir}: ${err.message}`);
      }

      const precacheUrls = [...STATIC_PRECACHE_URLS, ...bundledAssetUrls];

      const buildId = createHash('sha256')
        .update(precacheUrls.join('\n'))
        .digest('hex')
        .slice(0, 12);

      if (!sw.includes(BUILD_ID_SENTINEL)) {
        this.error(`[oyechats-pwa] sw.js is missing the ${BUILD_ID_SENTINEL} sentinel`);
        return;
      }
      if (!sw.includes(PRECACHE_SENTINEL)) {
        this.error(`[oyechats-pwa] sw.js is missing the __OYECHATS_PRECACHE__ sentinel`);
        return;
      }

      const nextSw = sw
        .replace(BUILD_ID_SENTINEL, JSON.stringify(buildId))
        .replace(PRECACHE_SENTINEL, JSON.stringify(precacheUrls));

      writeFileSync(swPath, nextSw, 'utf8');

      this.info(
        `[oyechats-pwa] sw.js sealed · build ${buildId} · ${precacheUrls.length} precache urls`,
      );
    },
  };
}
