# realtime-service

Lightweight microservice daemon combining a WebSocket gateway and embedded Valhalla routing service.

## Prerequisites

- Docker
- Node.js 20+ (for local development)

## Quick Start (Docker)

```bash
docker build -t realtime-service .
docker run -p 3010:3010 --env-file .env realtime-service
```

## Environment Configuration

Create a `.env` file in the project root:

```env
PORT=3010
NODE_ENV=production
VALHALLA_URL=http://localhost:8002
DATABASE_URL=postgresql://...
JWT_SECRET=your_jwt_secret
INTERNAL_WS_SECRET=your_internal_secret
```

## Health Check

- `GET /health` -> Returns service health status and timestamp.
