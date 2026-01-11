"""Documentation endpoints."""

from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

# Base path for documentation files
DOCS_BASE_PATH = Path(__file__).parent.parent.parent.parent.parent.parent / "documents"


class DocSection(BaseModel):
    """Documentation section model."""

    id: str
    title: str
    path: str
    children: List["DocSection"] = []


class DocContent(BaseModel):
    """Documentation content model."""

    id: str
    title: str
    content: str
    last_modified: Optional[str] = None


@router.get("/sections", response_model=List[DocSection])
async def get_doc_sections() -> List[DocSection]:
    """Get documentation structure."""
    return [
        DocSection(
            id="spec",
            title="仕様",
            path="spec",
            children=[
                DocSection(id="passshare", title="PassShare", path="spec/passshare"),
            ],
        ),
        DocSection(
            id="setup",
            title="セットアップ",
            path="setup",
            children=[],
        ),
        DocSection(
            id="templates",
            title="テンプレート",
            path="templates",
            children=[],
        ),
    ]


@router.get("/content/{doc_id:path}", response_model=DocContent)
async def get_doc_content(doc_id: str) -> DocContent:
    """Get documentation content by ID."""
    # Map doc_id to file path
    file_mapping = {
        "passshare/readme": "spec/passshare/README.md",
        "passshare/cli": "spec/passshare/cli.md",
        "passshare/features": "spec/passshare/features.md",
        "passshare/storage": "spec/passshare/storage.md",
        "passshare/crypto": "spec/passshare/crypto.md",
        "passshare/config": "spec/passshare/config.md",
        "passshare/api": "spec/passshare/api.md",
    }

    file_path = file_mapping.get(doc_id)
    if not file_path:
        raise HTTPException(status_code=404, detail="Document not found")

    full_path = DOCS_BASE_PATH / file_path
    if not full_path.exists():
        raise HTTPException(status_code=404, detail="Document file not found")

    try:
        content = full_path.read_text(encoding="utf-8")

        # Extract title from first heading
        title = doc_id
        for line in content.split("\n"):
            if line.startswith("# "):
                title = line[2:].strip()
                break

        return DocContent(
            id=doc_id,
            title=title,
            content=content,
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read document: {e}")


@router.get("/search")
async def search_docs(q: str) -> List[dict]:
    """Search documentation."""
    results = []

    if not q or len(q) < 2:
        return results

    q_lower = q.lower()

    # Search through spec files
    spec_path = DOCS_BASE_PATH / "spec" / "passshare"
    if spec_path.exists():
        for file_path in spec_path.glob("*.md"):
            try:
                content = file_path.read_text(encoding="utf-8")
                if q_lower in content.lower():
                    # Extract title
                    title = file_path.stem
                    for line in content.split("\n"):
                        if line.startswith("# "):
                            title = line[2:].strip()
                            break

                    # Find matching lines
                    matches = []
                    for i, line in enumerate(content.split("\n")):
                        if q_lower in line.lower():
                            matches.append({
                                "line": i + 1,
                                "text": line[:200],
                            })
                            if len(matches) >= 3:
                                break

                    results.append({
                        "id": f"passshare/{file_path.stem}",
                        "title": title,
                        "path": str(file_path.relative_to(DOCS_BASE_PATH)),
                        "matches": matches,
                    })

            except Exception:
                continue

    return results[:10]  # Limit results
