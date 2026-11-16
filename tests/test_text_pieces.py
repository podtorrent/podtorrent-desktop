"""Streamed text never shows U+FFFD for characters that span several byte-level tokens."""
from podtorrent.peer import TextPieces


class ByteTokenizer:
    """One token per UTF-8 byte, like the byte fallback in BPE vocabularies."""

    def decode(self, ids):
        return bytes(ids).decode("utf-8", errors="replace")


def stream(text: str) -> list[str]:
    pieces = TextPieces(ByteTokenizer())
    return [pieces.push(b) for b in text.encode()]


def test_multibyte_characters_come_out_whole():
    for text in ["Hey! 😀 how are you?", "Python 🐍 — not the snake", "你好，世界", "naïve café"]:
        out = stream(text)
        assert "".join(out) == text
        assert not any("�" in p for p in out)


def test_one_piece_per_token():
    text = "ok 👍"
    out = stream(text)
    assert len(out) == len(text.encode())  # callers count tokens by pieces
    assert out[-4:] == ["", "", "", "👍"]


def test_invalid_bytes_still_come_out():
    pieces = TextPieces(ByteTokenizer())
    out = [pieces.push(b) for b in [0xF0, 0x9F, 0x98, 0x41, 0x42]]  # cut-off emoji, then "AB"
    assert "".join(out).endswith("B")
    assert "A" in "".join(out)
