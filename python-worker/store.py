"""
Wraps ChromaDB, scoped to one persistent collection per `storage_dir`.

Like embedder.py, chromadb is imported lazily inside _get_client() rather
than at module load — same reasoning: don't pay for it, and don't let a
missing/broken install take down the whole worker process.

One client is cached per storage_dir for the life of the process, since
opening a PersistentClient has real (if small) overhead we don't want to
repeat on every single request.
"""

from embedder import sanitize_text

_clients = {}  # storage_dir -> chromadb.PersistentClient
_COLLECTION_NAME = "chunks"


def _get_client(storage_dir: str):
    if storage_dir not in _clients:
        import chromadb  # lazy import

        _clients[storage_dir] = chromadb.PersistentClient(path=storage_dir)
    return _clients[storage_dir]


def replace_all(storage_dir: str, ids: list, embeddings: list, metadatas: list, documents: list) -> int:
    """
    Wipes and rebuilds the collection from scratch.
    """

    client = _get_client(storage_dir)

    try:
        client.delete_collection(_COLLECTION_NAME)
    except Exception:
        pass

    collection = client.create_collection(
        _COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )

    if ids:
        safe_documents = [sanitize_text(doc) for doc in documents]

        for i, doc in enumerate(safe_documents):
            try:
                doc.encode("utf-8")
            except UnicodeEncodeError as e:
                print(f"Document {i} still contains invalid Unicode")
                print(repr(doc[:500]))
                raise

        collection.add(
            ids=ids,
            embeddings=embeddings,
            metadatas=metadatas,
            documents=safe_documents,
        )

    return len(ids)


def query(storage_dir: str, embedding: list, top_k: int) -> list:
    """Returns up to top_k nearest chunks."""

    client = _get_client(storage_dir)

    try:
        collection = client.get_collection(_COLLECTION_NAME)
    except Exception:
        return []

    results = collection.query(
        query_embeddings=[embedding],
        n_results=top_k,
    )

    matches = []

    for id_, distance, metadata in zip(
        results["ids"][0],
        results["distances"][0],
        results["metadatas"][0],
    ):
        matches.append(
            {
                "id": id_,
                "similarity": distance_to_similarity(distance),
                **metadata,
            }
        )

    return matches


def distance_to_similarity(distance: float) -> float:
    """
    Cosine distance -> similarity.
    """
    return round(1 - distance, 4)