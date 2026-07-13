"""
Wraps the sentence-transformers embedding model.

This is the only file that imports sentence_transformers, and it does so
lazily (inside get_model(), not at module load) so that:
  1. worker.py starts instantly even before this heavy dependency has
     finished installing/downloading its model weights.
  2. A failure to load the model only breaks requests that actually need
     embeddings ("index", "check_duplicates") — "ping" and any other
     lightweight message type keep working regardless.
"""

import re
import sys

_MODEL_NAME = "all-MiniLM-L6-v2"
_model = None

_CONTROL_CHAR_PATTERN = re.compile(
    "["
    + "".join(
        chr(c)
        for c in list(range(0x00, 0x09))
        + list(range(0x0B, 0x0D))
        + list(range(0x0E, 0x20))
        + [0x7F]
    )
    + "]"
)


def get_model():
    global _model

    if _model is None:
        print("[embedder] importing sentence_transformers...", file=sys.stderr, flush=True)

        from sentence_transformers import SentenceTransformer

        print("[embedder] import successful", file=sys.stderr, flush=True)

        print(f"[embedder] loading model '{_MODEL_NAME}'...", file=sys.stderr, flush=True)

        _model = SentenceTransformer(_MODEL_NAME)

        print("[embedder] model loaded successfully", file=sys.stderr, flush=True)

    return _model


def sanitize_text(text: str) -> str:
    cleaned = _CONTROL_CHAR_PATTERN.sub("", text)

    try:
        return cleaned.encode("utf-8", errors="replace").decode("utf-8")
    except Exception as e:
        print("SANITIZE FAILED")
        print(repr(cleaned[:500]))
        raise


def embed_texts(texts: list) -> tuple:
    print(f"[embedder] embed_texts() called with {len(texts)} texts", file=sys.stderr, flush=True)

    model = get_model()

    print("[embedder] sanitizing text...", file=sys.stderr, flush=True)

    sanitized = [sanitize_text(t) for t in texts]

    print("[embedder] starting batch encode...", file=sys.stderr, flush=True)

    try:
        vectors = model.encode(
            sanitized,
            normalize_embeddings=True,
            convert_to_numpy=True,
            batch_size=32,
        ).tolist()

        print("[embedder] batch encode finished", file=sys.stderr, flush=True)

        return vectors, []

    except TypeError as exc:
        print(f"[embedder] batch encode failed: {exc}", file=sys.stderr, flush=True)
        print("[embedder] falling back to one-at-a-time encoding", file=sys.stderr, flush=True)

        return _embed_one_at_a_time(sanitized, model)


def _embed_one_at_a_time(sanitized: list, model) -> tuple:
    print("[embedder] entered one-at-a-time fallback", file=sys.stderr, flush=True)

    dimension = model.get_sentence_embedding_dimension()
    vectors = []
    failed_indices = []

    for i, text in enumerate(sanitized):
        print(f"[embedder] encoding chunk {i+1}/{len(sanitized)}", file=sys.stderr, flush=True)

        try:
            vector = model.encode(
                [text],
                normalize_embeddings=True,
                convert_to_numpy=True,
            )[0].tolist()
        except Exception as exc:
            print(f"[embedder] chunk {i} failed: {exc}", file=sys.stderr, flush=True)

            vector = [0.0] * dimension
            failed_indices.append(i)

        vectors.append(vector)

    print("[embedder] fallback finished", file=sys.stderr, flush=True)

    return vectors, failed_indices