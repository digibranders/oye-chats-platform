"""OyeChats background worker — ARQ-based async task queue.

Start the worker:
    uv run arq app.worker.settings.WorkerSettings

The worker shares the same codebase as the API but runs as a separate
process. Tasks enqueued via ``enqueue()`` are picked up here and
executed asynchronously with automatic retry on failure.
"""
