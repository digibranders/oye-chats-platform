"""Model id helpers shared by the LLM path and its tracing.

LiteLLM ids carry a provider prefix (``openai/gpt-5.4-mini``,
``gemini/gemini-2.5-flash``) while the provider reports the model under its
own, usually bare and sometimes snapshot-dated, name (``gpt-5.4-mini-2026-03-01``).
``llm_service`` compares the two to meter a silent fallback, and
``langfuse_client`` compares them to record one consistent model name per
generation, so the comparison lives here rather than in either of them.
"""


def bare_model(model: str) -> str:
    """Strip a LiteLLM provider prefix (``openai/``, ``azure/`` …) from a model id."""
    return model.split("/", 1)[1] if "/" in model else model


def provider_prefix(model: str | None) -> str | None:
    """The LiteLLM provider prefix of ``model`` (``openai`` for ``openai/gpt-5.4-mini``), or ``None``."""
    if not model or "/" not in model:
        return None
    return model.split("/", 1)[0] or None


def same_model(requested_model: str, actual_model: str) -> bool:
    """Whether ``actual_model`` (as LiteLLM reports it) is the model we asked for.

    Provider prefixes are stripped from both sides and the comparison is
    case-insensitive. A dated snapshot suffix counts as the same model in
    either direction: ``gpt-5.4-mini`` requested and ``gpt-5.4-mini-2026-03-01``
    served is the primary answering under its resolved snapshot, and a pinned
    snapshot request served under the bare alias is the same thing the other
    way round. Two genuinely different ids (``gpt-5.4-mini`` vs
    ``gemini-2.5-flash``) share no prefix and never match.
    """
    requested = bare_model(requested_model).strip().lower()
    actual = bare_model(actual_model).strip().lower()
    if not requested or not actual:
        return False
    return requested == actual or actual.startswith(requested) or requested.startswith(actual)
