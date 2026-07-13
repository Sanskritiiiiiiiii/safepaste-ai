"""
Handlers for the "index" and "check_duplicates" message types.

Milestone 2 scope notes:
  - Full re-index only (no incremental diffing). Real repos re-index in
    low single-digit seconds; tracking dirty files is a genuine feature
    with real edge cases (deletions, renames) that isn't needed to prove
    duplicate detection works end to end.
  - The pasted snippet is embedded as-is, not re-chunked by the AST
    chunker. Chunking a pasted snippet into sub-functions is a reasonable
    future enhancement, not required for the core feature.
"""

from embedder import embed_texts, sanitize_text
from store import replace_all, query

# Below this cosine similarity, two pieces of code are not considered a
# meaningful duplicate. Deliberately a plain module constant, not a user
# setting yet — tune this once we've seen it against real repos.
MIN_SIMILARITY = 0.75


def handle_index(payload: dict) -> dict:
    storage_dir = payload["storageDir"]
    chunks = payload["chunks"]

    if not chunks:
        replace_all(storage_dir, [], [], [], [])
        return {"chunksIndexed": 0, "failedChunks": []}

    _validate_chunks(chunks)

    # Sanitize every chunk before embedding AND before storing.
    texts = [sanitize_text(c["code"]) for c in chunks]

    embeddings, failed_indices = embed_texts(texts)

    ids = [c["id"] for c in chunks]

    metadatas = [
        {
            "name": c["name"],
            "filePath": c["filePath"],
            "startLine": c["startLine"],
            "endLine": c["endLine"],
        }
        for c in chunks
    ]

    count = replace_all(storage_dir, ids, embeddings, metadatas, texts)

    failed_chunk_ids = [chunks[i]["id"] for i in failed_indices]

    return {
        "chunksIndexed": count,
        "failedChunks": failed_chunk_ids,
    }


def handle_check_duplicates(payload: dict) -> dict:
    storage_dir = payload["storageDir"]
    code = payload["code"]
    top_k = payload.get("topK", 5)

    if not isinstance(code, str):
        raise TypeError(
            f"expected 'code' to be a string, got {type(code).__name__}"
        )

    code = sanitize_text(code)

    embeddings, failed_indices = embed_texts([code])

    if failed_indices:
        raise ValueError(
            "Could not generate an embedding for the selected code, even after sanitization."
        )

    raw_matches = query(storage_dir, embeddings[0], top_k)

    return {
        "matches": filter_matches(raw_matches, MIN_SIMILARITY)
    }


def _validate_chunks(chunks: list) -> None:
    """
    Validates payload shape at this trust boundary.
    """
    for c in chunks:
        code = c.get("code")
        if not isinstance(code, str):
            raise TypeError(
                f"chunk '{c.get('id', '<unknown>')}' has code of type "
                f"{type(code).__name__}, expected str"
            )


def filter_matches(raw_matches: list, min_similarity: float) -> list:
    """
    Pure function, deliberately separated from handle_check_duplicates so
    it's unit-testable without touching chromadb or sentence-transformers.
    """
    return [
        m for m in raw_matches
        if m["similarity"] >= min_similarity
    ]