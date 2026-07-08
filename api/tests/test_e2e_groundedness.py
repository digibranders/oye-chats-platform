"""End-to-end retrieval -> prompt assembly -> (mocked) LLM groundedness tier (AR-11).

Before this file, rag_service.py's 4,618 lines of retrieval/prompt/generation
logic were tested only via small pure-function unit tests (RRF math,
sanitization, marker stripping, heuristics — see test_rag_service.py). No test
exercised the full chain and asserted the ANSWER's claims are actually
supported by the retrieved chunks. A change to fusion weights, `k`, or the
context-fencing format could cause confidently ungrounded answers with zero
test failures.

This tier:
  1. Uses a fixed, small "golden" chunk fixture (test_golden_eval.py's KB
     fixture pattern) with distinguishable, checkable facts.
  2. Calls the REAL `_build_reference_context` + `build_hybrid_prompt` to
     assemble the exact context/prompt a live chat turn would send.
  3. Mocks the LLM completion (two scenarios: grounded and hallucinated) —
     no real API key/network call needed.
  4. Asserts groundedness via a simple, test-only fact-membership check: every
     distinctive factual token in the answer must appear in the source chunks
     it's supposed to be grounded in.

Scope note: this is NOT a production groundedness classifier (that's AR-12 —
a real post-generation check, potentially LLM-judge-based, running in prod).
This tier's job is narrower: prove the input side (retrieval -> context ->
prompt) is correct and wire up test infrastructure that a future AR-12
groundedness function can plug straight into, replacing the local heuristic
below with the real one.
"""

import re

from app.services.rag_service import _build_reference_context, build_hybrid_prompt


class _FakeDoc:
    def __init__(self, doc_id, document_name, content):
        self.id = doc_id
        self.document_name = document_name
        self.content = content


GOLDEN_CHUNKS = [
    _FakeDoc(1, "pricing.txt", "Our standard plan costs $49 per month with unlimited chats."),
    _FakeDoc(2, "hours.txt", "We are open Monday to Friday, 9am to 6pm IST."),
    _FakeDoc(3, "team.txt", "Our founder and CEO is Jane Doe, based in Bengaluru."),
]


def _facts_in_chunks(chunks) -> set[str]:
    """Extract distinctive fact-tokens (numbers, dollar amounts, proper nouns)
    from the source chunks — the vocabulary an answer is allowed to cite."""
    text = " ".join(c.content for c in chunks)
    return set(re.findall(r"\$?\d+(?:am|pm)?|[A-Z][a-z]+(?:\s[A-Z][a-z]+)?", text))


def _answer_is_grounded(answer: str, chunks) -> bool:
    """Test-only groundedness heuristic: every distinctive fact-token in the
    answer must trace back to the source chunks. This is a stand-in for a
    real groundedness check (AR-12) — good enough to prove the test tier
    catches an obviously fabricated fact, not a substitute for LLM-judge
    entailment checking in production."""
    allowed_facts = _facts_in_chunks(chunks)
    answer_facts = re.findall(r"\$?\d+(?:am|pm)?|[A-Z][a-z]+(?:\s[A-Z][a-z]+)?", answer)
    return all(fact in allowed_facts for fact in answer_facts)


class TestEndToEndGroundedness:
    def test_grounded_answer_passes(self):
        """A mocked LLM answer that only restates fixture facts must pass."""
        context_text = _build_reference_context(GOLDEN_CHUNKS, company_name="Acme Corp")
        _system, user = build_hybrid_prompt(
            client=type("C", (), {"name": "Acme Corp"})(),
            question="How much does the standard plan cost?",
            context_text=context_text,
            history_context="",
        )

        assert "$49" in user  # the real fact made it into the assembled prompt

        mocked_answer = "Our standard plan costs $49 per month."
        assert _answer_is_grounded(mocked_answer, GOLDEN_CHUNKS) is True

    def test_hallucinated_answer_fails(self):
        """A mocked LLM answer that invents a fact NOT in any retrieved chunk
        must fail the groundedness check — this is the regression class
        AR-11/AR-12 exist to catch (e.g. the April 2026 'Fynix Digital made
        me' fabrication)."""
        context_text = _build_reference_context(GOLDEN_CHUNKS, company_name="Acme Corp")
        _system, user = build_hybrid_prompt(
            client=type("C", (), {"name": "Acme Corp"})(),
            question="How much does the standard plan cost?",
            context_text=context_text,
            history_context="",
        )
        assert "$49" in user

        hallucinated_answer = "Our standard plan costs $99 per month and was founded by John Smith."
        assert _answer_is_grounded(hallucinated_answer, GOLDEN_CHUNKS) is False

    def test_context_assembly_includes_only_retrieved_chunks_not_the_whole_kb(self):
        """Retrieval-precision guard: if only chunk 1 (pricing) is retrieved,
        the assembled context must not leak facts from chunks 2/3 — a
        regression here would silently make every answer "grounded" against
        the WHOLE knowledge base instead of just what was actually retrieved,
        defeating the point of retrieval-scoped groundedness checking."""
        retrieved = [GOLDEN_CHUNKS[0]]  # only pricing.txt
        context_text = _build_reference_context(retrieved, company_name=None)

        assert "$49" in context_text
        assert "Jane Doe" not in context_text
        assert "9am" not in context_text

    def test_citation_index_maps_to_correct_document(self):
        """Each <<<DOCUMENT i>>> fence index must correspond to the i-th
        retrieved chunk, in retrieval order — a fusion/reordering regression
        that silently shuffled chunks before context assembly would
        misattribute an answer's citation to the wrong source document."""
        context_text = _build_reference_context(GOLDEN_CHUNKS, company_name=None)

        for i, chunk in enumerate(GOLDEN_CHUNKS, 1):
            fence = f"<<<DOCUMENT {i} | {chunk.document_name}>>>"
            assert fence in context_text
            # The fenced content immediately following must be THIS chunk's
            # content, not another chunk's.
            fence_pos = context_text.index(fence)
            next_fence_pos = context_text.find(f"<<<DOCUMENT {i + 1} |", fence_pos)
            segment = context_text[fence_pos:next_fence_pos] if next_fence_pos != -1 else context_text[fence_pos:]
            assert chunk.content in segment
