# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is ding?

A minimalist Slack alternative. Simple social commenting with threaded replies and tags.

## Commands

```bash
# Development server (watches for changes)
deno serve --watch -A server.tsx

# Run tests (uses in-memory PGlite)
deno test -A

# Database setup
psql -d postgres -c "create database ding"
psql -d ding -x < db.sql
```

## Architecture

**Single-file server** (`server.tsx`, ~640 lines) using:
- **Hono** - HTTP framework with middleware chain
- **postgres.js** - SQL via template literals (`sql\`SELECT ...\``)
- **JSX** - Server-side rendered components (no frontend framework)
- **SendGrid** - Email delivery

**Database** (`db.sql`):
- `usr` - Users with bcrypt passwords, email verification, invitation limits
- `com` - Comments with threading (parent_cid), tags, full-text search

## Content Negotiation

Routes return different formats based on request:
- `api.ding.bar` subdomain or `Accept: application/json` → JSON
- Default → HTML

## Authentication

- Signed cookies for browser sessions
- Basic Auth for API access
- `authed` middleware protects private routes

## Key Patterns

SQL queries use postgres.js tagged templates:
```tsx
const users = await sql`SELECT * FROM usr WHERE uid = ${id}`
```

JSX components are pure functions:
```tsx
const Post = ({ post }: { post: Com }) => <article>...</article>
```

## Testing

Tests use PGlite (in-memory PostgreSQL) with mocked pgcrypto functions. The test file seeds its own database and doesn't require external PostgreSQL.
