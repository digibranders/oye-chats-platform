---
layout: home

hero:
  name: "OyeChats"
  text: "System Design"
  tagline: "Comprehensive architecture, data model, flows, and capacity analysis for the OyeChats SaaS chatbot platform."
  actions:
    - theme: brand
      text: Start with the system context
      link: /01-context/system-context
    - theme: alt
      text: Jump to the ER diagram
      link: /03-data/er-diagram
    - theme: alt
      text: View deployment topology
      link: /07-deployment/topology

features:
  - icon: 🏗️
    title: C4 architecture (Context · Container · Component)
    details: Three zoom levels, from "what is OyeChats" to every internal module of the API, widget, and admin app.
    link: /02-architecture/containers
  - icon: 🗄️
    title: Full ER diagram
    details: 23 tables across core, billing, qualification, live chat, and webhooks — with per-domain sub-diagrams for clarity.
    link: /03-data/er-diagram
  - icon: 🔁
    title: Sequence diagrams for every critical flow
    details: Signup, ingestion, RAG chat, live-chat handoff, billing checkout, credit ledger, webhook delivery, qualification, auth.
    link: /04-flows/visitor-chat-rag
  - icon: 🚦
    title: State machines
    details: ChatSession lifecycle, Subscription billing states, and Webhook delivery retry FSM.
    link: /05-state-machines/chat-session
  - icon: 🌐
    title: Deployment topology
    details: DigitalOcean droplet, Vercel admin, Cloudflare R2 widget CDN, and every external SaaS dependency mapped.
    link: /07-deployment/topology
  - icon: 📈
    title: Capacity & scaling
    details: Current limits, bottleneck ranking, and a phased scaling plan from 1-worker to horizontal.
    link: /09-capacity/current-limits
---

## How to read this

**New engineer onboarding** — read in order:

1. [Product overview](/01-context/product-overview)
2. [Personas](/01-context/personas)
3. [Containers](/02-architecture/containers)
4. [Visitor chat (RAG)](/04-flows/visitor-chat-rag) — the main product flow
5. [ER diagram](/03-data/er-diagram)
6. Skim the rest of `04-flows/`

**CTO / leadership** — read in order:

1. [System context](/01-context/system-context)
2. [Containers](/02-architecture/containers)
3. [Tech stack](/02-architecture/tech-stack)
4. [Deployment topology](/07-deployment/topology)
5. [Current limits](/09-capacity/current-limits) → [Bottlenecks](/09-capacity/bottlenecks) → [Scaling plan](/09-capacity/scaling-plan)
6. [Security](/08-cross-cutting/security) and [Observability](/08-cross-cutting/observability)

**Operator / on-call** — start at [Reliability](/08-cross-cutting/reliability) and the runbooks linked from there.

## What's not in here

- Landing page (`landing/`) and the standalone marketing site — out of scope.
- Auto-generated diagrams from the code-review-graph or graphify — these docs are hand-authored from those sources but are not regenerated. See the parent `platform/docs/graph-*.md` for graph snapshots.
- API endpoint reference. See [`platform/docs/api-reference.md`](../../api-reference.md).
