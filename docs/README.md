# OyeChats Platform Documentation

> Internal developer documentation for the OyeChats SaaS chatbot platform.

## Overview

OyeChats is a SaaS chatbot platform where customers sign up, create chatbot instances, upload their knowledge base, and embed an AI chatbot on their website with a single script tag. The chatbot uses RAG (Retrieval-Augmented Generation) to answer visitor questions from the customer's documents.

## Documentation Index

| Document | Description |
|----------|-------------|
| [Architecture Overview](./architecture.md) | System architecture, application map, and data flow |
| [Local Development Setup](./development-setup.md) | Environment setup, running services, and dev workflow |
| [API Reference](./api-reference.md) | All REST endpoints, authentication, request/response schemas |
| [Database Schema](./database-schema.md) | ORM models, relationships, indexes, and migrations |
| [Timezone & Datetime Handling](./timezone-handling.md) | How time is stored (UTC), business-hours zones, and frontend display |
| [RAG Pipeline & Ingestion](./rag-pipeline.md) | Document processing, embedding, hybrid search, and LLM generation |
| [Widget Embedding Guide](./widget-embedding.md) | How the embeddable chat widget works, build process, and integration |
| [Configuration Reference](./configuration.md) | Environment variables, feature flags, and service dependencies |

### Codebase Navigation (auto-generated)

| Document | Description |
|----------|-------------|
| [Architecture Map](./graph-architecture-map.md) | Module/community map of the codebase |
| [Critical Flows](./graph-critical-flows.md) | Impact ranking — which flows break if you touch X |
| [Onboarding Map](./graph-onboarding.md) | Entry points and auth schemes for new contributors |
| [System Design Site](./system-design/) | Interactive C4-style VitePress docs (context → capacity) |

### Planning & Reviews

| Document | Description |
|----------|-------------|
| [Consolidated Roadmap](./consolidated-roadmap.md) | **Single source of truth for all outstanding/unfinished work** |
| [AI Response Audit (2026-04)](./ai-response-audit-fynix-2026-04.md) | Scored AI-quality audit + methodology (reference) |
| [Capacity Plan — hundreds of bots (2026-08-18)](./capacity-plan-hundreds-of-bots.md) | Measured capacity envelope and the vector-index tenancy trap |
| [Live-chat process split — plan](./live-chat-process-split-plan.md) · [rollout](./live-chat-process-split-rollout.md) | Why `/ws/` moved to its own process, and the executed procedure |
| [Runbooks](./runbooks/) | Dated operational history. Read the status notes before following one |

> `PRODUCTION_READINESS_REVIEW_2026-07-03.md` is referenced by
> [`consolidated-roadmap.md`](./consolidated-roadmap.md) but **is not present in this
> repository**. Treat that citation as unresolvable until someone restores the file or
> removes the reference.

## Quick Links

- **Backend API:** `api/` — FastAPI + SQLAlchemy + pgvector
- **Chat Widget:** `widget/` — React 19; loader IIFE + code-split ESM app in a shadow root
- **Admin Dashboard:** `app/` — React 19 + Vite SPA, TypeScript end to end
- **Load tests:** `load-tests/` — k6 scenarios and the measured capacity results
- **Landing Page:** `../oyechats-website/` — Next.js 16 (separate repo, a sibling of `platform/`)

## Contributing

All development happens on the `development` branch. Never commit directly to `main`. See [Development Setup](./development-setup.md) for the full workflow.
