# PassShare Backend

PassShare distribution website backend API.

**© 2026 株式会社BM1314. All rights reserved.**

## Requirements

- Python 3.11+
- uv (package manager)
- PostgreSQL 16+

## Setup

```bash
# Install dependencies
uv sync

# Copy environment file
cp .env.example .env
```

## Database

### PostgreSQL

```bash
# Start PostgreSQL (Docker)
docker compose up -d postgres

# Run migrations
uv run alembic upgrade head
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | localhost | PostgreSQL host |
| `DB_PORT` | 5432 | PostgreSQL port |
| `DB_USER` | passshare | Database user |
| `DB_PASSWORD` | password | Database password |
| `DB_NAME` | passshare_db | Database name |
| `DATABASE_URL` | - | Full database URL (overrides above) |

## Development

```bash
# Run development server
uv run uvicorn app.main:app --reload --port 8000

# Create new migration
uv run alembic revision --autogenerate -m "description"

# Run migrations
uv run alembic upgrade head

# Rollback migration
uv run alembic downgrade -1
```

## API Endpoints

### Health Check

- `GET /health` - Health check

### Releases

- `GET /api/v1/releases/latest` - Get latest release
- `GET /api/v1/releases/versions` - Get latest versions
- `GET /api/v1/releases` - Get all releases

### Downloads

- `GET /api/v1/downloads/stats` - Get download statistics
- `GET /api/v1/downloads/packages` - Get package information

### Documentation

- `GET /api/v1/docs/sections` - Get documentation structure
- `GET /api/v1/docs/content/{doc_id}` - Get documentation content
- `GET /api/v1/docs/search?q=query` - Search documentation

## Tech Stack

- **Framework**: FastAPI
- **Database**: PostgreSQL 16
- **ORM**: SQLAlchemy 2.0 (async)
- **Migrations**: Alembic
- **Validation**: Pydantic v2

## License

MIT License
