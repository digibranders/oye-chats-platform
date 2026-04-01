# OyeChat Platform Documentation

> Internal developer documentation for the OyeChat SaaS chatbot platform.

## Overview

OyeChat is a SaaS chatbot platform where customers sign up, create chatbot instances, upload their knowledge base, and embed an AI chatbot on their website with a single script tag. The chatbot uses RAG (Retrieval-Augmented Generation) to answer visitor questions from the customer's documents.

## Documentation Index

| Document | Description |
|----------|-------------|
| [Architecture Overview](./architecture.md) | System architecture, application map, and data flow |
| [Local Development Setup](./development-setup.md) | Environment setup, running services, and dev workflow |
| [API Reference](./api-reference.md) | All REST endpoints, authentication, request/response schemas |
| [Database Schema](./database-schema.md) | ORM models, relationships, indexes, and migrations |
| [RAG Pipeline & Ingestion](./rag-pipeline.md) | Document processing, embedding, hybrid search, and LLM generation |
| [Widget Embedding Guide](./widget-embedding.md) | How the embeddable chat widget works, build process, and integration |
| [Admin Dashboard](./admin-dashboard.md) | Bot management UI, analytics, and configuration |
| [Configuration Reference](./configuration.md) | Environment variables, feature flags, and service dependencies |

## Quick Links

- **Backend API:** `api/` — FastAPI + SQLAlchemy + pgvector
- **Chat Widget:** `widget/` — React 19 + Vite IIFE bundle
- **Admin Dashboard:** `admin/` — React 19 + Vite SPA
- **Landing Page:** `../landing/` — Next.js 16

## Contributing

All development happens on the `development` branch. Never commit directly to `main`. See [Development Setup](./development-setup.md) for the full workflow.
