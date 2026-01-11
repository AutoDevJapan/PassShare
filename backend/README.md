# PassShare Backend

PassShare distribution website backend API.

**© 2026 株式会社BM1314. All rights reserved.**

## Requirements

- Python 3.11+
- uv (package manager)

## Setup

```bash
# Install dependencies
uv sync

# Copy environment file
cp .env.example .env
```

## Development

```bash
# Run development server
uv run uvicorn app.main:app --reload --port 8000
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

## License

MIT License
