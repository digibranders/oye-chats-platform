# OyeChats Feature — Grounded Chatbot & Knowledge Training

*Single-source NotebookLM knowledge document on this feature. Self-contained — no other file is required to understand this feature. Evidence tags: [T1] = confirmed directly in code, [T2] = confirmed in project documentation, [T3] = positioning/marketing framing, [VERIFY] = flagged, unconfirmed.*

---

## 1. What This Feature Is

OyeChats reads a business's own website and documents, turns that content into a private knowledge base, and answers visitors' questions using only what it learned there. If a visitor asks something the business's content doesn't cover, the AI says so honestly instead of guessing. [T1 — `api/app/services/rag_service.py`, `api/app/ingestion/pipeline.py`]

## 2. Who Cares & Why

A business owner installs a chatbot because they don't want a visitor to leave unanswered — but they're equally afraid of an AI that makes things up and embarrasses the brand. This feature is the direct answer to that fear: the AI is scoped to *this business's* real content, and it is architecturally built to decline rather than fabricate. [T3] For a marketing/CX lead, this means the chatbot can go live on day one without a human writing a script or an FAQ tree by hand — the business's existing website and docs already are the training material. [T1 — `api/app/ingestion/pipeline.py`, `crawl_orchestrator.py`]

## 3. How It Actually Works

**Training (turning content into knowledge):**
- The business points OyeChats at its website URL (or uploads PDF/DOCX/TXT documents). A crawl pipeline (Spider.cloud primary, Jina Reader fallback — HTTP-only, no local browser) fetches pages. [T1 — `crawl_orchestrator.py`, `spider_service.py`, `jina_service.py`]
- Content is extracted, cleaned, and split into chunks (recursive splitting, ~1000 characters with 200-character overlap, tunable). [T1 — CLAUDE.md RAG Pipeline section, `api/app/ingestion/chunking.py`]
- Each chunk is embedded with Google's `gemini-embedding-001` (768-dimensional) and stored in PostgreSQL with `pgvector`, alongside a full-text `TSVECTOR` index for keyword matching. [T1 — CLAUDE.md]
- Crawling can stream-ingest in waves concurrently with the scrape (for faster time-to-trained), and a follow-up sweep removes chunks for pages that no longer exist on the site so stale content doesn't linger. [T1 — `crawl_orchestrator.py` docstring: "streaming enabled... ingestion runs in waves concurrently with the scrape, followed by a dedup-protected final sweep... sweeps orphan chunks for pages that were removed from the site since the last crawl"]
- While crawling, the pipeline also extracts brand tone, company context, and recommended colors from the first few pages — feeding the widget's branding/customization step (a separate feature; see the Widget Customization doc). [T1 — `crawl_orchestrator.py`: "Extracts brand tone, company context, and recommended colors from the first few pages"]

**Answering (turning a question into a grounded reply):**
- A visitor's question triggers hybrid retrieval — vector similarity search *and* keyword (TSVECTOR) search over that specific bot's documents, merged via reciprocal rank fusion. [T1 — `rag_service.py`: `_vector_search`, `_keyword_search`, `reciprocal_rank_fusion`; CLAUDE.md RAG Pipeline]
- A **relevance gate** (CRAG-style, on by default) has an LLM judge score every retrieved chunk against the question on a 0–1 scale. If every chunk scores below threshold (default 0.55, tunable per bot), the pipeline stops before generation and returns a "can't help" response — it deliberately never lets an ungrounded question reach the answer-writing model. [T1 — `relevance_gate.py` docstring: "If ALL chunks score below the threshold, the gate fires... returns a 'can't help' response without generating an answer from irrelevant context"]
- An optional reranker (cross-encoder, FlashRank) can further sharpen which chunks make it into context. [T1 — `rag_service.py` imports `RERANK_ENABLED`, `reranker.py`]
- The primary LLM (OpenAI `gpt-5.4-mini`, routed via LiteLLM, with automatic fallback to Google `gemini-2.5-flash`) generates the answer from the retrieved chunks plus conversation history, streamed to the widget via SSE. [T1 — CLAUDE.md Tech Stack, RAG Pipeline]
- **After** the answer has already streamed to the visitor, a second, independent check runs in the background: a **groundedness gate** has an LLM judge rate whether the generated answer's actual claims are supported by the chunks it was built from. This is deliberately observability-only (it logs a metric, it does not block or rewrite the live answer) — the team treats detection and correction as two separate problems, and chose not to risk a false-positive rewrite of a good answer without safe retry infrastructure in place. [T1 — `groundedness_gate.py` docstring, verbatim: "Deliberately observability-only, not blocking: it runs fire-and-forget after the answer has already streamed to the visitor... Blocking or rewriting a live answer on a groundedness-gate verdict would trade a real (but bounded) hallucination risk for a new one"]
- If a question looks off-topic (e.g., "what's the weather"), the AI gives a company-scoped refusal, rotating through several phrasings so consecutive refusals in one conversation don't read as a repeated canned line — and escalates to offering a human handoff after two refusals in a row. [T1 — `rag_service.py` `_off_topic_refusal` docstring and logic]
- A subtler case is handled separately: a question that clearly **is** about the company (mentions "your team," "pricing," "the CEO," etc.) but where the knowledge base simply has no matching chunk. Here the AI does not give the generic off-topic refusal — it gives a graceful "no-info pivot" (acknowledging the question is valid, offering to connect the visitor with the team) rather than sounding defensive or contradicting the fact that it clearly understood the topic. [T1 — `rag_service.py` comment: "Returning the off-topic refusal here feels defensive and contradicts the previous turn; the no-info pivot offers a graceful path forward"]
- Every gap the AI couldn't answer is recorded and surfaced back to the business as a "Knowledge gaps" list inside the dashboard, so the business knows exactly what to add next. [T1 — `app/src/features/agents/knowledge/KnowledgeGapsPanel.tsx`: "Questions visitors asked that your AI couldn't answer. Add a matching website or document below to close them."]

## 4. What It Looks Like

- **Training/Knowledge screen** (dashboard): a page where the business adds a website URL or uploads documents, sees a live crawl-progress state, and browses a page tree of what's been ingested (`CrawlPageTree.tsx`). [T1]
- **Knowledge gaps panel**: an empty state reading "No gaps recorded yet" until real visitor questions start missing coverage, at which point it lists the actual unanswered questions as rows. [T1 — `KnowledgeGapsPanel.tsx`]
- **The widget chat window**: visitor types a question, sees a normal streaming answer for in-scope questions.
- **A refusal moment**: for an out-of-scope question, the widget shows a warm, natural decline (not an error state, not a broken/empty response).
- **A no-info-pivot moment**: visitor asks something plausible about the company that isn't covered; the widget offers to connect them with the team rather than refusing outright — visually this can look like a soft hand-off cue inside the same chat bubble flow.

## 5. A Real Scenario Walkthrough

1. A consulting firm signs up and points OyeChats at their website. Within minutes, the crawl pipeline has read their services pages, case studies, and an "About" page, chunked and embedded them.
2. A visitor lands on the site and asks, "What's your turnaround time for a typical project?" — this is answerable from a page the crawl ingested. The relevance gate confirms strong matches, the reranker orders the best chunks, and the AI answers directly from that content, streaming the reply.
3. Another visitor asks, "What's the weather like today?" — completely unrelated. The relevance gate finds nothing relevant, generation never happens, and the AI gives a company-scoped, natural-sounding decline ("I can help with questions about [Company] — ask me about our services, pricing, or how we work.").
4. A third visitor asks, "Is your CEO on LinkedIn?" — clearly about the company, but the crawled content has no bio page with a LinkedIn link. Instead of a flat refusal, the AI acknowledges the question is valid and offers to connect them with the team.
5. Later, the business opens their dashboard and sees that exact LinkedIn question sitting in "Knowledge gaps" — so they know precisely what to add next.

## 6. Capabilities vs Limits

**Does:**
- Trains from a business's own website (crawl) and uploaded documents.
- Answers only from that business's ingested content, per-bot (multi-tenant isolation — each bot's retrieval is scoped to its own documents). [T1 — `rag_service.py` `_vector_search`/`_keyword_search` take `cid`/`bid`]
- Declines honestly when it has no grounding, with two distinct decline modes (off-topic vs. no-info pivot).
- Runs a background, non-blocking self-check on its own answers for observability.
- Surfaces unanswered questions back to the business as an actionable gap list.
- Re-crawls and removes chunks for pages that were deleted from the source site.

**Does NOT do (explicitly, per source material):**
- It does not block or auto-correct a live answer based on the groundedness check — that check is observability-only today. [T1]
- It does not claim any specific hallucination-rate or accuracy percentage — no such metric exists in the inspected source material. [VERIFY — do not invent a number]
- It does not browse the live internet at answer-time; all answers come from previously ingested/chunked content, not real-time web search.
- It does not guarantee zero hallucination — the gates reduce risk, they are not described anywhere in source material as eliminating it.

## 7. Evidence & Open [VERIFY] Items

- All mechanics above are [T1], sourced directly from `rag_service.py`, `groundedness_gate.py`, `relevance_gate.py`, `crawl_orchestrator.py`, `spider_service.py`, `jina_service.py`, CLAUDE.md, and `KnowledgeGapsPanel.tsx`.
- **[VERIFY]** No hallucination-rate, accuracy percentage, or "trained in N minutes" claim exists in any inspected source — do not state one.
- **[VERIFY]** Whether the groundedness-gate metric is surfaced anywhere in the customer-facing dashboard (vs. internal observability only) was not confirmed in this pass — do not depict it as a customer-visible feature unless separately verified.
- Reranker (`RERANK_ENABLED`) and relevance-gate thresholds are tunable/feature-flagged; exact production defaults beyond what's quoted above were not independently re-verified against live runtime config.
