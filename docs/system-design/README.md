# OyeChats — System Design Documentation

Living architecture documentation for the OyeChats platform. Authored as VitePress + Mermaid so diagrams are text-diff-able and the rendered site is zoom/pan friendly.

## Local development

```bash
cd platform/docs/system-design
npm install
npm run dev          # http://localhost:5173
```

## Production build

```bash
npm run build        # outputs to docs/.vitepress/dist/
npm run preview      # serve the built site on http://localhost:4180
```

## Layout

| Section | Path | Audience focus |
|---|---|---|
| 1 — Context | `docs/01-context/` | New engineers · CTO |
| 2 — Architecture (C4) | `docs/02-architecture/` | New engineers · CTO |
| 3 — Data | `docs/03-data/` | New engineers |
| 4 — Critical flows | `docs/04-flows/` | New engineers |
| 5 — State machines | `docs/05-state-machines/` | New engineers |
| 6 — RAG pipeline | `docs/06-rag/` | New engineers |
| 7 — Deployment | `docs/07-deployment/` | Ops · CTO |
| 8 — Cross-cutting | `docs/08-cross-cutting/` | All |
| 9 — Capacity & scaling | `docs/09-capacity/` | CTO |

## Keeping diagrams current

Each page carries a `Last updated:` field, and pages disagree with each other when one is refreshed and its neighbours are not — several pages cite each other, so a wrong fact propagates. Verify against source, never against a sibling page. After landing a sizeable feature, please:

1. Open the affected pages and update diagrams + walk-throughs.
2. Bump `Last updated:` to the merge date.
3. If the change introduced a new container/component/table, add it to the relevant C4/ER diagram too.
4. Diagrams are claims. A sequence diagram that shows an ARQ box for work that runs on a thread pool is as wrong as a sentence saying so.

## Style conventions

- All diagrams in **Mermaid**. Wrap large diagrams (≥ 40 nodes) in `<ZoomableMermaid>`.
- File references use markdown links with `path:line` syntax so they navigate from rendered site and from GitHub.
- Each page follows the same template: **TL;DR → Why → Diagram → Walk-through → Key files → Failure modes → Why this matters.** (There is no separate authoring guide; the template is the pages themselves.)
- Links to source files are relative from the page, so they resolve on GitHub: from `docs/<section>/page.md` the repo root is `../../../../`, e.g. `../../../../api/app/db/models.py`. `ignoreDeadLinks` is on in the VitePress config, so a wrong depth fails silently — check new links by clicking them on GitHub.

## Hosting

The current build outputs static HTML in `docs/.vitepress/dist/`. Deployment is intentionally not wired up yet — a future ticket will publish to `docs.oyechats.com` (Cloudflare Pages or Vercel).
