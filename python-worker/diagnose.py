"""
One-time diagnostic tool. NOT part of the production worker pipeline —
run this manually against the actual failing chunk to get hard evidence
for the root cause instead of a hypothesis.

Usage:
    python3 diagnose.py path/to/File.tsx        # scans the whole file
    python3 diagnose.py                          # paste text into
                                                   # FAILING_TEXT below first

What each step proves, and why it's evidence rather than a guess:

  1. repr(text), not print(text) — print() can silently swallow or
     misrender control characters and zero-width characters; repr()
     cannot.

  2. A full codepoint scan — reports the exact index and Unicode
     category of every character outside plain printable ASCII/whitespace.
     If nothing is flagged here, H1 (unusual-but-valid character) is
     disproven for this text.

  3. text.encode('utf-8') — if this raises UnicodeEncodeError, the
     exception object's .start/.end attributes give the EXACT character
     position that is invalid. This is unambiguous proof, not inference —
     Python computed it, we didn't guess it.

  4. The raw HuggingFace tokenizer, called directly on this one string,
     bypassing SentenceTransformer's batching wrapper entirely. If the
     raw tokenizer accepts the string alone but SentenceTransformer.encode()
     still rejects it, that's proof the bug is in how SentenceTransformer
     dispatches/batches input — not in the string's content. That would
     disprove H1 and point at H2 instead.

  5. Binary search bisection — only runs if step 4 shows the raw
     tokenizer itself rejects the string. Repeatedly halves the string
     and re-tests, narrowing down to the exact character responsible,
     the same way you'd bisect a git history to find a breaking commit.
"""

import sys
import unicodedata

FAILING_TEXT = """"""  # paste chunk 38's exact source text here if not using a file argument


def scan_codepoints(text: str) -> None:
    print(f"type={type(text)}  len={len(text)}")
    print(f"repr (first 200 chars): {text[:200]!r}")

    suspicious = []
    for i, ch in enumerate(text):
        code = ord(ch)
        category = unicodedata.category(ch)
        is_ascii_printable = 0x20 <= code <= 0x7E
        is_allowed_whitespace = ch in ("\n", "\t")
        # Anything below 0x2000 that isn't plain printable ASCII or our
        # two allowed whitespace chars is worth a look — this is where
        # control characters (0x00-0x1F, 0x7F) and surrogates (0xD800-
        # 0xDFFF) live. Above 0x2000 is normal Unicode (accents, CJK,
        # emoji, smart quotes) and not inherently a problem.
        if not (is_ascii_printable or is_allowed_whitespace) and code < 0x2000:
            suspicious.append((i, code, category, ch))

    if suspicious:
        print(f"\n{len(suspicious)} suspicious character(s) found:")
        for i, code, category, ch in suspicious:
            print(f"  index={i}  codepoint=U+{code:04X}  category={category}  repr={ch!r}")
    else:
        print("\nNo control characters or low-range anomalies found by static scan.")
        print("(This would disprove H1 for this text — see module docstring.)")


def try_utf8_encode(text: str) -> None:
    try:
        text.encode("utf-8")
        print("\ntext.encode('utf-8') succeeded — string is valid UTF-8.")
    except UnicodeEncodeError as e:
        print(f"\ntext.encode('utf-8') FAILED: {e}")
        print(f"  Exact failing position: start={e.start} end={e.end}")
        print(f"  Offending character(s): {text[e.start:e.end]!r}")


def try_raw_tokenizer(text: str) -> None:
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        print("\nsentence-transformers not installed here — skipping tokenizer tests.")
        return None

    model = SentenceTransformer("all-MiniLM-L6-v2")
    raw_tokenizer = model.tokenizer  # underlying HF fast tokenizer, no SentenceTransformer batching wrapper involved

    print("\n--- Testing raw tokenizer directly on this string, alone ---")
    raw_ok = True
    try:
        raw_tokenizer(text)
        print("Raw tokenizer accepted the string on its own.")
    except Exception as e:
        raw_ok = False
        print(f"Raw tokenizer REJECTED the string on its own: {type(e).__name__}: {e}")
        print("-> Evidence for H1: the content itself is the problem.")

    print("\n--- Testing SentenceTransformer.encode() on this string, alone ---")
    try:
        model.encode([text])
        print("SentenceTransformer.encode() accepted it alone.")
        if not raw_ok:
            print("(Inconsistent with the raw tokenizer result above — worth a closer look.)")
    except Exception as e:
        print(f"SentenceTransformer.encode() REJECTED it alone: {type(e).__name__}: {e}")
        if raw_ok:
            print("-> Evidence for H2: raw tokenizer was fine, but SentenceTransformer's")
            print("   own dispatch/batching logic is rejecting it. Not a content problem.")

    return model if raw_ok is not None else None


def bisect_failure(text: str, model) -> None:
    if model is None:
        return
    tokenizer = model.tokenizer

    def fails(s: str) -> bool:
        try:
            tokenizer(s)
            return False
        except Exception:
            return True

    if not fails(text):
        print("\nBisection skipped: the raw tokenizer does not fail on the full text.")
        return

    lo, hi = 0, len(text)
    print("\n--- Bisecting to isolate the exact failing character ---")
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if fails(text[lo:mid]):
            hi = mid
        else:
            lo = mid

    print(f"Failure isolated to character index {lo}:")
    print(f"  context: {text[max(0, lo - 5):lo + 5]!r}")
    print(f"  codepoint=U+{ord(text[lo]):04X}  category={unicodedata.category(text[lo])}")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        # errors='strict' deliberately, NOT 'replace' — if the file itself
        # has invalid UTF-8 bytes on disk, we want Python to tell us that
        # directly and loudly, rather than silently sanitizing it away
        # before we've even looked.
        try:
            with open(sys.argv[1], "r", encoding="utf-8", errors="strict") as f:
                text = f.read()
            print(f"Loaded {len(text)} characters from {sys.argv[1]} (strict UTF-8 decode succeeded)")
        except UnicodeDecodeError as e:
            print(f"FILE ITSELF is not valid UTF-8 on disk: {e}")
            print(f"  Exact byte position: start={e.start} end={e.end}")
            sys.exit(1)
    else:
        text = FAILING_TEXT
        if not text.strip():
            print("Paste the failing chunk's exact source into FAILING_TEXT, or pass a file path.")
            sys.exit(1)

    scan_codepoints(text)
    try_utf8_encode(text)
    model = try_raw_tokenizer(text)
    bisect_failure(text, model)
