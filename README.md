# discord-user-mcp

A small remote MCP server on Cloudflare Workers that lets Claude read and act on Discord through a **burner Discord user account** (a self-bot, against Discord's terms; the account is disposable).

- Stateless Streamable HTTP at `/mcp`, built with `createMcpHandler` from the Cloudflare Agents SDK and the official MCP SDK v2 (`@modelcontextprotocol/server`). `McpAgent` is deprecated, so no Durable Objects are used.
- Plain `fetch` to `https://discord.com/api/v10`, with `Authorization: <user token>` (no `Bot ` prefix).
- Every request to `/mcp` must carry `Authorization: Bearer <SERVER_SECRET>`, checked in constant time. Anything else gets an empty `401`.
- No CORS headers at all, since only Claude's cloud calls this. No logging, and Workers Logs is turned off.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_guilds` | read-only | Servers the account is in (id, name). |
| `list_channels` | read-only | `guild_id` → text and announcement channels (id, name, type, category). |
| `list_dms` | read-only | DM and group DM channels, most recent first (channel id, recipients, last message id). Optional `limit` (default 50). |
| `read_messages` | read-only | `channel_id`, optional `limit` (25, max 100), optional `before`. Returns oldest → newest. Text over 700 chars is truncated. |
| `get_message` | read-only | One message, full text. |
| `send_message` | write | `channel_id`, `content` (≤ 2000), optional `reply_to`. Works for DM channel ids. |
| `edit_message` | write | Requires `expected_old_text_start`. Refused if it doesn't match the current text. |
| `delete_message` | write, destructive | Requires `expected_author` and `expected_text_start`. Refused if either doesn't match. |
| `add_reaction` | write | `emoji` is a unicode emoji or `name:id` for custom. |

The expected-text checks ignore whitespace differences and a trailing `...`. They need at least the first 15 characters, or the whole text if it is shorter. For a message with no text, pass an empty string.

How the server talks to Discord:
- On HTTP 429 it waits `retry_after` (up to 30 s) and retries once, then returns a clear error.
- Network failures are never retried. Sends also carry a nonce with `enforce_nonce`, so Discord drops a duplicate.
- If Discord returns a captcha or a non-JSON block page, the tool says so and stops. It does not try to work around it.

## Security model: read this

- **Approval prompts live in Claude, not in this server.** The server runs any tool call that carries the right bearer secret. Anyone who has `SERVER_SECRET` can post, edit, delete and react as the account directly, with no prompt. Treat it like a password.
- Secrets exist only as Worker secrets (`wrangler secret put`) and, for local dev, in `.dev.vars`, which is git-ignored. Neither value is in this repo.

## Setup

Requires Node 18+.

```sh
npm install
npm test          # unit tests with a mocked Discord
npx tsc --noEmit  # typecheck
```

### Local run (optional)

```sh
cp .dev.vars.example .dev.vars   # then edit .dev.vars in your editor and fill in both values
npm run dev                      # http://127.0.0.1:8787/mcp
```

Check it with curl. The first command should print `401`:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/mcp
```

With the right header, the second command should list nine tools:

```sh
SECRET=$(grep ^SERVER_SECRET= .dev.vars | cut -d= -f2-)
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8787/mcp --transport http \
  --header "Authorization: Bearer $SECRET" --method tools/list
unset SECRET
```

### Deploy

```sh
npx wrangler login                              # opens your browser
npx wrangler secret put DISCORD_USER_TOKEN      # paste the token at the prompt
SECRET=$(openssl rand -hex 32)
printf '%s' "$SECRET" | npx wrangler secret put SERVER_SECRET
echo "$SECRET"; unset SECRET                    # copy it now; you need it for Claude's connector
npx wrangler deploy
```

`wrangler deploy` prints the URL, `https://discord-user-mcp.<your-subdomain>.workers.dev`. The MCP endpoint is that URL plus `/mcp`.

If `wrangler secret put` runs before the first deploy, wrangler offers to create the Worker. Say yes.

### Connect to Claude

In claude.ai, go to Settings → Connectors → Add custom connector:

1. **URL:** `https://discord-user-mcp.<your-subdomain>.workers.dev/mcp`
2. "Couldn't check the server" at the sign-in step is expected: click Continue anyway.
3. **Authentication:** No sign-in. Add a request header named `Authorization` with the value `Bearer <SERVER_SECRET>`.
4. **Transport:** Streamable HTTP.
5. Open the connector's tool permissions. Check that `send_message`, `edit_message`, `delete_message` and `add_reaction` are under Write/delete, and set each to **needs approval**.

## Rotating secrets

**`SERVER_SECRET`** (do this if it might have leaked):

```sh
SECRET=$(openssl rand -hex 32)
printf '%s' "$SECRET" | npx wrangler secret put SERVER_SECRET
echo "$SECRET"; unset SECRET
```

The old value stops working as soon as the command finishes. Then update the `Authorization` header in Claude's connector settings.

**`DISCORD_USER_TOKEN`**: changing the account's password (or logging out of all sessions) invalidates the old token in Discord. Get the new token, then run:

```sh
npx wrangler secret put DISCORD_USER_TOKEN
```

## Removing it

```sh
npx wrangler delete
```

This deletes the Worker and its secrets. Then remove the connector in Claude, and change the Discord account's password to kill the token.

## Unverified against the live API

Discord's docs cover bots only. These behaviors were built from the bot docs and could not be checked against a real user account during development:

- `get_message` tries `GET /channels/{id}/messages/{id}` first. Historically that endpoint was bot-only, so on a 401 or 403 it falls back to `GET /channels/{id}/messages?around={id}&limit=1`, which is what the official client uses.
- `list_channels` returns whatever `GET /guilds/{id}/channels` returns for a user account. That may include channels the account cannot read.
