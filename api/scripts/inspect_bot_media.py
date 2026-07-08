"""Print the media catalog the RAG pipeline will hand to the LLM for a bot.

Usage (from ``platform/api`` inside the conda ``oye`` env):

    uv run python scripts/inspect_bot_media.py <bot_key>

Diagnoses "no card ever comes up" failures by showing exactly what the
LLM sees. Three outcomes:

  1. "videos=0 files=0" — Ingestion never captured any media URLs. No
     prompt change or safety net can help; the KB documents don't
     contain the raw ``https://youtube.com/...`` or ``https://.../file.pdf``
     URLs that ``extract_media_urls`` scans for. Re-ingest with URL-rich
     source docs, or crawl a URL that embeds them.

  2. "videos=N files=M" but N/M are small and don't cover the topic
     the visitor asked about — the LLM is correctly skipping because
     the catalog doesn't hold the asset. Same fix: re-ingest.

  3. "videos=N files=M" with the expected asset present — catalog is
     healthy. The failure is at the LLM step (prompt discipline) or
     the API isn't running the latest code. Restart the API and
     retest; if it still fails, capture the raw bot reply.
"""

from __future__ import annotations

import sys

from app.db.models import Bot
from app.db.repository import get_bot_media_urls
from app.db.session import get_session


def main(bot_key: str) -> int:
    with get_session() as session:
        bot = session.query(Bot).filter(Bot.bot_key == bot_key).first()
        if bot is None:
            print(f"[!] No bot found with bot_key={bot_key!r}")
            return 2
        payloads = get_bot_media_urls(session, bot_id=bot.id)

    videos: list[dict] = []
    files: list[dict] = []
    for payload in payloads:
        for yt in payload.get("youtube") or []:
            if isinstance(yt, dict) and yt.get("video_id"):
                videos.append(yt)
        for f in payload.get("files") or []:
            if isinstance(f, dict) and f.get("url"):
                files.append(f)

    print(f"bot_key={bot_key}  bot_id={bot.id}")
    print(f"AVAILABLE MEDIA catalog: videos={len(videos)}  files={len(files)}")
    print()

    if videos:
        print("YouTube videos:")
        for v in videos:
            title = v.get("title") or "(no title captured)"
            print(f"  - {title}  [video_id={v['video_id']}]")
        print()
    if files:
        print("Downloadable files:")
        for f in files:
            print(f"  - {f.get('name') or '(no name)'}  {f['url']}")
        print()

    if not videos and not files:
        print("→ The catalog is EMPTY. This is the failure.")
        print("  Ingestion only captures media URLs that appear verbatim in")
        print("  your source docs. Add the raw YouTube / file URLs to the KB")
        print("  and re-ingest, or crawl a URL that embeds them.")
        return 1
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: inspect_bot_media.py <bot_key>")
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
