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

# Run a specific bot manually
deno run -A bots/hn.ts

# Database setup
psql -d postgres -c "create database ding"
psql -d ding -x < db.sql
```

## Architecture

**Single-file server** (`server.tsx`, ~1,100 lines) using:
- **Hono** - HTTP framework with middleware chain
- **postgres.js** - SQL via template literals (`sql\`SELECT ...\``)
- **JSX** - Server-side rendered components (no frontend framework)
- **SendGrid** - Email delivery

Server is organized with `//// SECTION ////` headers: IMPORTS, CONSTANTS, HELPERS, LABEL PARSING, EMAIL TOKEN, POSTGRES, SENDGRID, COMPONENTS, HONO.

**Database** (`db.sql`):
- `usr` - Users with bcrypt passwords, email verification, org memberships (`orgs_r`/`orgs_w` arrays)
- `com` - Comments with threading (parent_cid), tags/orgs/usrs arrays, full-text search

**Bots** (`bots/`):
- Content aggregators (HN, Lobsters, arXiv, etc.) that POST via Basic Auth
- Run every 5 minutes via GitHub Actions (`.github/workflows/bots.yml`)

## Label System

Search and tagging use a unified label syntax:
- `#tag` - public labels (stored in `tags` array, GIN indexed)
- `*org` - org/private labels (access controlled via user's `orgs_r`/`orgs_w`)
- `@user` - user mentions (stored in `usrs` array)
- `~domain` - domain filter (search only, not stored)

Exported functions: `parseLabels()`, `encodeLabels()`, `decodeLabels()`, `formatLabels()`

## Content Negotiation

Routes return different formats based on subdomain or Accept header:
- `api.ding.bar` or `Accept: application/json` → JSON
- `rss.ding.bar` or `Accept: application/xml` → RSS/XML
- Default → HTML

## Authentication

- Signed cookies for browser sessions
- Basic Auth for API access (used by bots)
- `authed` middleware protects private routes
- `some()` combinator allows either auth method

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
