# MCP Store Server

A small, production-minded [Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude, ChatGPT, Cursor and other AI assistants work with an online store's data **safely**.
It ships with a sample SQLite shop and shows the patterns a real business integration needs: scoped API tokens, dry-run + confirm for writes, masked customer data and a full audit trail.

[![CI](https://github.com/najathi/mcp-store-server/actions/workflows/ci.yml/badge.svg)](https://github.com/najathi/mcp-store-server/actions/workflows/ci.yml)
![Node 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-lightgrey)

## Architecture

```mermaid
flowchart LR
    subgraph Clients
        CD[Claude Desktop / Claude Code / Cursor]
        RC[Remote clients and agents]
    end

    CD -- stdio --> STDIO[stdio transport<br/>scopes from STDIO_SCOPES]
    RC -- "HTTPS + Bearer token" --> HTTP[Streamable HTTP transport<br/>Host check, bearer auth]

    STDIO --> GUARD
    HTTP --> GUARD

    subgraph Server["MCP server (official TypeScript SDK)"]
        GUARD[Tool guard<br/>rate limit, scope check, structured errors]
        GUARD --> TOOLS[6 tools with zod schemas]
        TOOLS --> CONFIRM[Confirm tokens<br/>single use, 2 min TTL]
        TOOLS --> MASK[PII masking]
        RES[Resource: store://policies]
        PROMPT[Prompt: weekly_sales_report]
    end

    TOOLS --> DB[(SQLite<br/>products, customers, orders)]
    GUARD --> AUDIT[(audit_log)]
    TOOLS --> AUDIT
```

## Features

- **Official SDK, current API.** `@modelcontextprotocol/sdk` 1.32 with `registerTool`, `registerResource` and `registerPrompt`; zod 4 input schemas.
- **Two transports.** stdio for local desktop clients, and stateless Streamable HTTP (Express) for remote use.
- **Scoped bearer tokens.** `read` and `write` scopes per token, verified by the SDK's own `requireBearerAuth` middleware. stdio is read-only unless you opt in.
- **Two-step writes.** `update_stock` returns a dry-run preview and a short-lived, single-use confirm token. Only a second call with the same arguments and the token changes data.
- **PII masking.** Orders show `Ava T.`, `a***@example.com`, `***-***-0107`. The model never receives full contact details.
- **Audit log.** Every write attempt (preview, applied, rejected) and every denied call is recorded with time, token name, tool, arguments (secrets redacted) and result. Readable through `get_audit_log`.
- **Guard rails.** Strict input validation, per-caller rate limit, parameterised SQL, optimistic concurrency on writes, DNS-rebinding protection, structured error codes.
- **Tested end to end.** 49 Vitest tests, including real stdio and HTTP sessions through the SDK client.
- **Ready to ship.** Multi-stage Dockerfile (non-root, health check), docker-compose, GitHub Actions CI.

## Quick start

Requires Node.js 20 or later.

```bash
git clone https://github.com/najathi/mcp-store-server.git
cd mcp-store-server
npm install
npm run build
npm run demo:stdio   # starts the server over stdio and calls every tool with the SDK client
```

The first start creates `data/store.db` and fills it with sample data (30 products, 20 customers, 60 orders over the last 60 days). Reset it at any time with `npm run seed`.

<details>
<summary>Sample <code>npm run demo:stdio</code> output</summary>

```text
Connected over stdio to mcp-store-server (dist)

Tools: search_products, get_order, list_low_stock, sales_summary, update_stock, get_audit_log

search_products "pour-over":
  GEAR-001  Pour-Over Dripper (Ceramic)  $28.00  stock 12
  GIFT-003  Pour-Over Starter Kit  $74.00  stock 4

get_order 1042: delivered, $187.00, customer {
  name: 'Maya P.',
  email: 'm***@example.com',
  phone: '***-***-0102',
  city: 'Seattle'
}

update_stock preview: 8 -> 32, applied=false, token cfm_kaHln9...
update_stock confirm: status=applied, new stock 32
update_stock replay:  CONFIRMATION_INVALID

get_audit_log:
  #3 demo-script update_stock rejected: CONFIRMATION_INVALID: Unknown or already used confirm_token. ...
  #2 demo-script update_stock applied: COF-002: 8 -> 32
  #1 demo-script update_stock preview: COF-002: 8 -> 32 (not applied)
```

</details>

### Run over HTTP

```bash
cp .env.example .env        # then replace the example tokens
export $(grep -v '^#' .env | xargs)
npm run start:http          # http://127.0.0.1:3000/mcp

# in another terminal
MCP_TOKEN=change-me-read-token-0001 npm run demo:http
```

Or with curl:

```bash
curl -s http://127.0.0.1:3000/mcp \
  -H 'Authorization: Bearer change-me-read-token-0001' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_products","arguments":{"query":"matcha"}}}'
```

A request without a token gets `401` with a `WWW-Authenticate: Bearer error="invalid_token"` header. A read-only token calling `update_stock` gets a `FORBIDDEN` tool error, which is written to the audit log.

### Run with Docker

```bash
cp .env.example .env        # set API_TOKENS
docker compose up --build   # http://127.0.0.1:3000/mcp, data kept in the store-data volume
```

Or without compose:

```bash
docker build -t mcp-store-server .
docker run --rm -p 127.0.0.1:3000:3000 \
  -e API_TOKENS='analyst:change-me-read-token-0001:read' \
  -v store-data:/data mcp-store-server
```

The image runs as the non-root `node` user, contains production dependencies only and has a `/healthz` health check.

## Connect an AI client

Build first (`npm run build`) and use absolute paths. Set `STDIO_SCOPES` to `read,write` only if you want the assistant to be able to change stock.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings > Developer > Edit Config):

```json
{
  "mcpServers": {
    "store": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-store-server/dist/index.js", "stdio"],
      "env": {
        "STDIO_ACTOR": "claude-desktop",
        "STDIO_SCOPES": "read"
      }
    }
  }
}
```

Restart Claude Desktop, then try: _"Which products need reordering, and how did each category sell in the last 30 days?"_ or pick the **weekly_sales_report** prompt.

### Claude Code

```bash
# local, over stdio
claude mcp add store -e STDIO_ACTOR=claude-code -e STDIO_SCOPES=read,write \
  -- node /absolute/path/to/mcp-store-server/dist/index.js stdio

# remote, over HTTP with a token
claude mcp add --transport http store http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer change-me-read-token-0001"
```

### Cursor

Add to `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "store": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-store-server/dist/index.js", "stdio"],
      "env": { "STDIO_SCOPES": "read" }
    },
    "store-remote": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer change-me-read-token-0001" }
    }
  }
}
```

### ChatGPT and other hosted clients

Hosted assistants connect to remote MCP servers over HTTPS. Deploy the HTTP transport behind TLS (for example a reverse proxy or a container platform) and check the client's current connector requirements. Several hosted clients expect OAuth rather than static bearer tokens; see [Adding OAuth 2.1](#adding-oauth-21).

## Tool reference

| Tool              | Scope   | What it does                                                                                                                                                                  |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_products` | `read`  | Search by text (name or SKU), category, price range and availability. Returns SKU, price, stock and a low-stock flag.                                                         |
| `get_order`       | `read`  | One order with line items, totals and status. Customer name, email and phone are masked.                                                                                      |
| `list_low_stock`  | `read`  | Products at or below their reorder level, lowest first, with a suggested reorder quantity.                                                                                    |
| `sales_summary`   | `read`  | Orders, units, revenue, average order value, revenue by category (with share) and top 5 products for a date range (max 366 days). Cancelled and refunded orders are excluded. |
| `update_stock`    | `write` | Set or adjust one product's stock. First call: dry-run preview + `confirm_token`. Second call with the same arguments and the token: applies the change.                      |
| `get_audit_log`   | `read`  | Recent audit entries, filterable by tool, outcome and caller.                                                                                                                 |

| Other    | Name                  | Purpose                                                                                  |
| -------- | --------------------- | ---------------------------------------------------------------------------------------- |
| Resource | `store://policies`    | Shipping, returns, stock and customer-data policies (Markdown) the assistant can cite.   |
| Prompt   | `weekly_sales_report` | Optional `week_start` (YYYY-MM-DD). Guides the assistant to build a week-on-week report. |

Every tool result has a JSON text block and `structuredContent`. Errors use `isError: true` and a stable shape:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "This tool requires the \"write\" scope.",
    "details": { "required_scope": "write", "granted_scopes": ["read"] }
  }
}
```

Error codes: `UNAUTHENTICATED`, `FORBIDDEN`, `RATE_LIMITED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `CONFIRMATION_INVALID`, `CONFLICT`, `INTERNAL`. Unexpected exceptions become `INTERNAL` with a generic message, so stack traces and SQL never reach the model.

## Security design

**Authentication and scopes.** On HTTP, every `POST /mcp` needs `Authorization: Bearer <token>`. Tokens come from `API_TOKENS` as `name:token:scopes`. Only SHA-256 digests are kept in memory and comparison is constant-time. The token name is the caller's identity in the audit log. stdio has no token (the caller is whoever launched the process), so it takes its identity and scopes from `STDIO_ACTOR` and `STDIO_SCOPES`, which default to read-only.

**Every call goes through one guard** (`src/tools/shared.ts`): resolve caller, then rate limit, then scope check, then validated handler, then structured result. A new tool cannot skip it.

**Dry-run and confirm.** `update_stock` never writes on the first call. It returns the before and after values and a confirm token that is:

- single use (consumed on the first attempt, even a failed one),
- short-lived (`CONFIRM_TTL_SECONDS`, default 120),
- bound to the caller and a hash of the exact arguments, so it cannot be reused for another product, another quantity or by another token.

When the change is applied, the update only succeeds if stock still equals the previewed value. If someone else changed it in between, the call fails with `CONFLICT` and nothing is written. The tool description tells the model to show the preview to the user and ask before confirming; the annotations mark it `destructiveHint: true` so clients can ask for approval too.

**Data minimisation.** Customer PII is masked inside the server before anything is returned. Search results contain no customer data at all.

**Audit trail.** `audit_log` records preview, applied, rejected and denied events with timestamp, caller, tool, arguments and outcome. Confirm tokens are redacted before storage.

**Input handling.** All arguments are validated with zod (types, ranges, SKU and date formats, string lengths) before the handler runs. SQL uses bound parameters only; `LIKE` wildcards in search text are escaped.

**Transport hardening.** Requests with an unexpected `Host` header are rejected (DNS-rebinding protection from the SDK). `/healthz` is the only unauthenticated route and returns nothing but status. The Docker image runs as a non-root user.

**Limits of this demo.** Confirm tokens and rate-limit counters live in process memory, so run a single replica or move them to Redis. The rate limiter is a simple fixed window; put a gateway limit in front of anything internet-facing. Terminate TLS in front of the HTTP server.

### Adding OAuth 2.1

The HTTP transport uses the SDK's `requireBearerAuth` with a custom `OAuthTokenVerifier` (`StaticTokenVerifier` in `src/security/auth.ts`). To use OAuth 2.1 with an identity provider (Auth0, Okta, Entra ID, Keycloak, Cognito):

1. Replace `StaticTokenVerifier` with a verifier that validates the provider's JWT access tokens (for example with `jose` and the provider's JWKS) or calls its introspection endpoint, and maps the token's scopes to `read` and `write`.
2. Pass `expectedResource` to `requireBearerAuth` so only tokens issued for this server are accepted.
3. Serve OAuth Protected Resource Metadata (the SDK has `mcpAuthMetadataRouter`) and set `resourceMetadataUrl`, so clients can discover the authorization server.

Tools, scopes, the confirm flow and the audit log stay the same.

## Configuration

| Variable                | Default           | Description                                                                               |
| ----------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| `DATABASE_PATH`         | `./data/store.db` | SQLite file. Created and seeded on first start.                                           |
| `API_TOKENS`            | (none)            | `name:token:scopes` entries, comma-separated, scopes joined with `\|`. Required for HTTP. |
| `HTTP_HOST`             | `127.0.0.1`       | Bind address. Docker image uses `0.0.0.0`.                                                |
| `HTTP_PORT`             | `3000`            | HTTP port.                                                                                |
| `ALLOWED_HOSTS`         | (none)            | Extra allowed `Host` names (no port) when binding to `0.0.0.0`.                           |
| `STDIO_ACTOR`           | `stdio`           | Caller name recorded in the audit log for stdio sessions.                                 |
| `STDIO_SCOPES`          | `read`            | Scopes for stdio sessions: `read` or `read,write`.                                        |
| `RATE_LIMIT_PER_MINUTE` | `60`              | Tool calls per caller per minute.                                                         |
| `CONFIRM_TTL_SECONDS`   | `120`             | Lifetime of a confirm token.                                                              |

## Development

```bash
npm run dev          # stdio server from source (tsx)
npm run dev:http     # HTTP server from source
npm test             # Vitest
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
npm run format       # Prettier
npm run check        # lint + typecheck + tests
```

Test suite (`test/`):

| File                | Covers                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `security.test.ts`  | Masking, confirm-token store (single use, expiry, binding), rate limiter, config parsing, token verifier.  |
| `tools.test.ts`     | Tool, resource and prompt listing; every read tool's results, filters and validation errors.               |
| `writeFlow.test.ts` | Scope denial and auditing, preview then confirm, replay, tampered args, expiry, other caller, stale stock. |
| `http.test.ts`      | 401 without or with a bad token, Host check, 405, read vs write tokens, full confirm flow over HTTP.       |
| `stdio.test.ts`     | Spawns the real server as a child process and talks to it with the SDK's stdio client.                     |

### Project layout

```text
src/
  index.ts              CLI entry: stdio | http | seed
  config.ts             Environment parsing and validation (zod)
  server.ts             Builds the McpServer: tools, resource, prompt
  db.ts, seed.ts        SQLite schema and deterministic sample data
  audit.ts              Audit log writer and reader
  errors.ts             ToolError and structured results
  security/             auth (token verifier), confirmations, masking, rate limit
  tools/                One file per tool + shared guard
  transports/           stdio.ts, http.ts
content/store-policies.md
scripts/                demo-stdio.ts, demo-http.ts
test/                   Vitest suites
```

## Adapting it to your business

The store is a stand-in. The structure carries over to any system you want an assistant to use:

- **Different database.** Swap `better-sqlite3` for Postgres or MySQL in `db.ts` and the tool queries. The guard, confirm flow and audit log do not change.
- **An existing API instead of a database.** Tool handlers can call Shopify, WooCommerce, Stripe, HubSpot, an ERP or your own REST API. Keep secrets on the server; the model only sees tool results.
- **More write actions.** Refunds, price changes or order-status updates follow the `update_stock` pattern: validate, preview, issue a confirm token, re-check state, apply in a transaction, audit.
- **Your own auth.** Map your users or service accounts to scopes, or plug in OAuth 2.1 as described above.

### Need one for your business?

I build custom MCP servers that connect Claude, ChatGPT and Cursor to your data and tools, with the same focus on permissions, safe writes and auditability.
See my work and get in touch through GitHub: **[github.com/najathi](https://github.com/najathi)**.

## License

[MIT](LICENSE) © Mohamed Najathi
