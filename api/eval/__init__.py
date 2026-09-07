"""Answer-quality evaluation harness for the OyeChats RAG chatbot.

Drives the real ``POST /chat`` endpoint of a deployed bot with a golden set of
questions, grades every answer with a strict-JSON LLM judge, and writes a
report that fails the run below a pass-rate threshold.

Modules
-------
``golden``    golden-set schema (:class:`~eval.golden.GoldenCase`), loader and
              validation; coverage minimums the shipped set must meet.
``judge``     the LLM judge (strict ``json_schema`` output, reasoning disabled),
              pure parsing of its verdict, the pass rule and the aggregation.
``report``    ``report.json`` / ``report.md`` writers.
``run_eval``  the CLI: ``uv run python -m eval.run_eval --help`` from ``api/``.

This package is deliberately NOT part of the ``app`` wheel
(``[tool.hatch.build.targets.wheel] packages = ["app"]``): it is a developer
and CI tool that imports ``app``, never the other way round. It is importable
as ``eval`` because ``python -m`` puts the current directory (``api/``) on
``sys.path``, and pytest does the same for the ``tests`` package's root.

See ``docs/eval/README.md`` for how to run it and how to add cases.
"""
