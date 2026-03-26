import json
import os
import subprocess
import sys


async def crawl_website(url: str):
    """
    Crawls the given URL by running a separate subprocess.
    This avoids asyncio event loop conflicts on Windows.
    """
    print(f"DEBUG: Starting subprocess crawl for {url}")

    script_path = os.path.join(os.path.dirname(__file__), "crawler_script.py")

    try:
        process = subprocess.Popen(
            [sys.executable, script_path, url],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",  # Ensure UTF-8 encoding
            errors="replace",  # Gracefully handle non-UTF8 bytes by replacing them
        )

        stdout, stderr = process.communicate()

        if stderr:
            print(f"DEBUG: Crawler stderr: {stderr}")

        if process.returncode != 0:
            error_msg = f"Crawler process failed with code {process.returncode}. Stderr: {stderr}"
            print(f"DEBUG: {error_msg}")
            raise Exception(error_msg)  # noqa: TRY002

        # Parse the JSON output
        try:
            # crawl4ai prints logs to stdout, so we need to separate our JSON
            if "---CRAWLER_JSON_OUTPUT---" in stdout:
                json_str = stdout.split("---CRAWLER_JSON_OUTPUT---")[1].strip()
            else:
                # Fallback if no delimiter found (unexpected, but handle it)
                json_str = stdout

            data = json.loads(json_str)

            if "error" in data:
                error_msg = f"Crawler script reported error: {data['error']}"
                print(f"DEBUG: {error_msg}")
                raise Exception(error_msg)  # noqa: TRY002

            return data
        except (json.JSONDecodeError, IndexError) as e:
            # If split fails or json decode fails
            error_msg = f"Failed to parse crawler output. Raw output: {stdout}"
            print(f"DEBUG: {error_msg}")
            raise Exception(error_msg) from e  # noqa: TRY002

    except Exception as e:
        print(f"DEBUG: Subprocess exception: {str(e)}")
        raise
