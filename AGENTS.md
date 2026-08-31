# Project: OyeChats

OyeChats is a **SaaS chatbot platform** where customers sign up, create chatbot instances, upload their knowledge base, and embed an AI chatbot on their website with a single script tag. The chatbot uses RAG (Retrieval-Augmented Generation) to answer visitor questions from the customer's documents.

> **This file is the agent-facing rulebook, not the technical reference.**
>
> It used to carry its own copy of the architecture, schema, RAG pipeline, key-file
> map and tech stack. That copy drifted until nearly every line of it was false: it
> described an `admin/` directory (the dashboard is `app/`), an `aiorb-preview/`
> directory and a `../landing/` sibling (neither exists), a self-contained ~416KB
> IIFE with a sibling `oyechats-widget.css` (the widget is a ~3KB loader plus
> code-split ESM chunks in a shadow root), OpenAI `text-embedding-3-small` at
> 1536-dim into `Vector(384)` (embeddings are Gemini `gemini-embedding-001` at
> 768-dim into `Vector(768)`, `models.py:788`), 2000/300 chunking (it is 1000/200,
> `config.py:110-111`), Gemini as the primary LLM (it is OpenAI `gpt-5.4-mini` with
> Gemini as the LiteLLM fallback, `config.py:45-46`), Playwright for scraping (there
> is no local browser; crawling is Jina Reader primary + Spider.cloud fallback) and
> Backblaze B2 for storage (it is Cloudflare R2, `services/r2_service.py`).
>
> Two hand-maintained copies of the same facts is how that happened, so there is now
> exactly one: **[`CLAUDE.md`](./CLAUDE.md)**. Read it for architecture, the RAG
> pipeline, the DB schema, auth headers, key files, the tech stack, environment
> setup, production access and every development command. What stays here is only
> what an agent must not get wrong before touching anything.

## Code Quality Gate
> **Codex Agent reviews every edit.** Write clean, production-ready code on every change — no placeholders, no shortcuts, no "fix later" comments. Each edit is evaluated for correctness, type safety, error handling, and adherence to project conventions. Treat every diff as if it's going straight to a code review.

## Mandatory Pre-Completion Checks
**BEFORE confirming any code changes to the user OR before pushing code, you MUST run all baseline checks for every project that was touched.** Do not skip these. If any check fails, fix the issue BEFORE presenting the final result.

Run only the checks relevant to the files you changed:

### JavaScript / TypeScript Projects
| Project | Directory | Lint | Typecheck | Tests | Build |
|---------|-----------|------|-----------|-------|-------|
| Admin Dashboard | `app/` | `npm run lint` | `npx tsc --noEmit` | `npx vitest run` | `npm run build` |
| Chat Widget | `widget/` | `npm run lint` | — (JS) | `npm test` | `npm run build` |

`app/` is TypeScript end to end, so `tsc --noEmit` is not optional there: Vite
transpiles and strips types without checking them, and `npm run build` passes on
code that does not typecheck.

The admin dashboard also has a Playwright browser suite, and CI runs it. It needs
the build first, because it drives `vite preview` rather than the dev server:

```bash
cd app && npm run build && npx playwright install chromium && npm run e2e
```

### Python Backend
| Check | Command (run inside conda `oye` env) |
|-------|---------------------------------------|
| Lint | `cd api && uv run ruff check .` |
| Format | `cd api && uv run ruff format .` |
| Tests | `cd api && uv run pytest` |

### Rules
1. **Scope checks to what changed** — don't lint the entire monorepo if you only touched the widget.
2. **Fix before reporting/pushing** — if lint, format, or build fails, fix all errors and re-run until clean. Do not push breaking or unformatted code!
3. **Never skip checks** — even for "small" changes. One-line typos can break builds.
4. **Report the results** — include a brief summary of checks passed in your final message (e.g., "lint ✓ · format ✓ · build ✓").

## Git Workflow
> **STRICT RULE — NO EXCEPTIONS.**

- **NEVER use `main` branch locally.** Do not checkout, commit to, or push from `main`. Ever.
- **NEVER push directly to `main`.** The `main` branch is production and is only updated via GitHub PR merges.
- **Always work on the `development` branch.** All commits and pushes go to `development`.
- Before every commit/push, verify current branch: `git branch --show-current` — must output `development`.
- If you are on `main` by mistake: `git checkout development` immediately — do not commit.
- When ready to release, create a PR from `development` → `main` on GitHub. The user will merge it from there.

## Working inside `app/` (the admin dashboard)

`app/` is under a complete rebuild mandate. Read [`app/CLAUDE.md`](app/CLAUDE.md)
and [`app/DESIGN.md`](app/DESIGN.md) before writing anything there. Existing pages
are pointers to reusable logic, never to UX worth keeping.

## Everything else

See [`CLAUDE.md`](./CLAUDE.md). If you find something in this file that contradicts
it, `CLAUDE.md` and the code win — and the contradiction is a bug in this file.
