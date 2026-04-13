"""Tests for app.ingestion.cleaner — markdown noise removal."""

from app.ingestion.cleaner import clean_text


class TestCleanText:
    def test_removes_markdown_images(self):
        text = "Before ![alt text](https://img.png) after"
        result = clean_text(text)
        assert "![" not in result
        assert "Before" in result
        assert "after" in result

    def test_removes_navigation_links(self):
        text = "* [Home](/)\n* [About](/about)\nReal content here."
        result = clean_text(text)
        assert "[Home]" not in result
        assert "[About]" not in result
        assert "Real content here." in result

    def test_removes_dash_navigation_links(self):
        text = "- [Home](/)\n- [About](/about)\nContent."
        result = clean_text(text)
        assert "[Home]" not in result
        assert "Content." in result

    def test_preserves_descriptive_bullet_links(self):
        text = "* [Learn more](/pricing) — our flexible plans"
        result = clean_text(text)
        assert "Learn more" in result
        assert "flexible plans" in result

    def test_removes_table_lines(self):
        text = "| Header1 | Header2 |\n|---|---|\n| val1 | val2 |\nReal content."
        result = clean_text(text)
        assert "|" not in result
        assert "Real content." in result

    def test_removes_standalone_links(self):
        text = "[Click here](https://example.com)\nReal content."
        result = clean_text(text)
        assert "[Click here]" not in result
        assert "Real content." in result

    def test_empty_input(self):
        assert clean_text("") == ""

    def test_whitespace_only_lines_removed(self):
        text = "Hello\n   \n\n  \nWorld"
        result = clean_text(text)
        assert result == "Hello\nWorld"

    def test_preserves_normal_content(self):
        text = "This is a normal paragraph.\nAnother line of text."
        result = clean_text(text)
        assert "This is a normal paragraph." in result
        assert "Another line of text." in result

    def test_complex_markdown_mixed(self):
        text = (
            "# Welcome\n"
            "![logo](logo.png)\n"
            "* [Home](/)\n"
            "This is real content.\n"
            "| col1 | col2 |\n"
            "[Link](http://x.com)\n"
            "More real content."
        )
        result = clean_text(text)
        assert "# Welcome" in result
        assert "This is real content." in result
        assert "More real content." in result
        assert "![logo]" not in result
        assert "[Home]" not in result
        assert "| col1" not in result
