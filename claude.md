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

# Enable pre-commit hook (one-time per clone)
git config core.hooksPath .githooks
```

## Architecture

**Single-file server** (`server.tsx`, ~1,100 lines) using:

- **Hono** - HTTP framework with middleware chain
- **postgres.js** - SQL via template literals (`sql\`SELECT ...\``)
- **JSX** - Server-side rendered components (no frontend framework)
- **SendGrid** - Email delivery

Server is organized with `//// SECTION ////` headers: IMPORTS, CONSTANTS, HELPERS, LABEL PARSING, EMAIL TOKEN, POSTGRES,
SENDGRID, COMPONENTS, HONO.

**Database** (`db.sql`):

- `usr` - Users with bcrypt passwords, email verification, org memberships (`orgs_r`/`orgs_w` arrays)
- `com` - Comments with threading (parent_cid), tags/orgs/usrs arrays, full-text search

**Bots** (`bots/`):

- Content aggregators (HN, Lobsters, arXiv, etc.) that POST via Basic Auth
- LLM persona bots (kenm, linkedin, bigfoot, caveman, critic) use `claude()` helper in `bots.ts` with Haiku 3; require
  `ANTHROPIC_API_KEY`
- Run every 5 minutes via GitHub Actions (`.github/workflows/bots.yml`)

## Label System

Search and tagging use a unified label syntax:

- `#tag` - public labels (stored in `tags` array, GIN indexed)
- `*org` - org/private labels (access controlled via user's `orgs_r`/`orgs_w`)
- `@user` - user mentions (stored in `usrs` array)
- `~domain` - synthetic label auto-extracted from every URL host in the body (stored in `domains` array, GIN indexed)

Exported functions: `parseLabels()`, `encodeLabels()`, `decodeLabels()`, `formatLabels()`

## Body Formatting

Post/comment bodies are rendered by `formatBody()` as lightweight markdown that **keeps the original symbols visible**
(e.g. `_foo_` renders as `<em>_foo_</em>`). Supported: `_italic_`, `**bold**`, `` `code` ``, `[text](https://...)`,
`# heading`, `> blockquote`, `- item` / `1. item` lists, fenced `` ``` `` and 4-space-indented code blocks. Only code
blocks render in monospace; prose uses the page font. `<div class="body">` wraps output; styles live in
`public/style.css` (`.body`, `.body pre`, `.body blockquote`, `.body-list`).

Post-detail view (`/c/:cid`) fetches two levels of comments so replies-to-replies render without click-through. Feed
view (`/`) stays one level deep.

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
const users = await sql`SELECT * FROM usr WHERE uid = ${id}`;
```

JSX components are pure functions:

```tsx
const Post = ({ post }: { post: Com }) => <article>...</article>;
```

## Testing

Tests use PGlite (in-memory PostgreSQL) with mocked pgcrypto functions. The test file seeds its own database and doesn't
require external PostgreSQL.
