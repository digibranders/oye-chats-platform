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

Each page carries a `Last updated:` field. After landing a sizeable feature, please:

1. Open the affected pages and update diagrams + walk-throughs.
2. Bump `Last updated:` to the merge date.
3. If the change introduced a new container/component/table, add it to the relevant C4/ER diagram too.

## Style conventions

- All diagrams in **Mermaid**. Wrap large diagrams (≥ 40 nodes) in `<ZoomableMermaid>`.
- File references use markdown links with `path:line` syntax so they navigate from rendered site and from GitHub.
- Each page follows the template in the [authoring guide](./AUTHORING.md) (TLDR → Why → Diagram → Walk-through → Key files → Failure modes → Open questions).

## Hosting

The current build outputs static HTML in `docs/.vitepress/dist/`. Deployment is intentionally not wired up yet — a future ticket will publish to `docs.oyechats.com` (Cloudflare Pages or Vercel).
