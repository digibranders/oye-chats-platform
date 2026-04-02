"""Quick test: verify LiteLLM can reach the configured LLM model."""

import os
from dotenv import load_dotenv

load_dotenv()

import litellm

from app.config import LLM_MODEL, FALLBACK_MODEL

model = LLM_MODEL
fallback = FALLBACK_MODEL

print(f"Primary model:  {model}")
print(f"Fallback model: {fallback}")
print(
    f"OPENAI_API_KEY: {'...' + os.getenv('OPENAI_API_KEY', '')[-4:] if os.getenv('OPENAI_API_KEY') else '❌ NOT SET'}"
)
print(
    f"GOOGLE_API_KEY: {'...' + os.getenv('GOOGLE_API_KEY', '')[-4:] if os.getenv('GOOGLE_API_KEY') else '❌ NOT SET'}"
)
print()

# Test primary model
print(f"── Testing: {model} ──")
try:
    resp = litellm.completion(
        model=model,
        messages=[{"role": "user", "content": "Reply with exactly: Hello World"}],
        max_tokens=20,
    )
    content = resp.choices[0].message.content
    print(f"✅ Response: {repr(content)}")
    print(f"   Model used: {resp.model}")
    print(f"   Tokens: {resp.usage.prompt_tokens} in / {resp.usage.completion_tokens} out")
except Exception as e:
    print(f"❌ FAILED: {type(e).__name__}: {e}")

print()

# Test fallback model
print(f"── Testing: {fallback} ──")
try:
    resp = litellm.completion(
        model=fallback,
        messages=[{"role": "user", "content": "Reply with exactly: Hello World"}],
        max_tokens=20,
    )
    content = resp.choices[0].message.content
    print(f"✅ Response: {repr(content)}")
    print(f"   Model used: {resp.model}")
    print(f"   Tokens: {resp.usage.prompt_tokens} in / {resp.usage.completion_tokens} out")
except Exception as e:
    print(f"❌ FAILED: {type(e).__name__}: {e}")
