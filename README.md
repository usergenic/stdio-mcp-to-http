# stdio-mcp-to-http

Run a **stdio-based MCP server** on a remote host and reach it from remote MCP
clients over the HTTP transport they already speak.

`stdio-mcp-to-http` spawns your stdio MCP server as a child process and exposes
it over the MCP **Streamable HTTP** transport at a secret URL path. There is no
config file: you give it the child command and a secret path on the command
line.

## Why

Most MCP servers only speak stdio. If you want to use one from a laptop, a
phone client, or several machines, you need an HTTP endpoint. This is a thin,
**generic** proxy that turns any stdio MCP server into an HTTP one — it relays
JSON-RPC verbatim, so it works with servers it knows nothing about.

## Two ideas that make it usable on the open internet

1. **The URL path is the API key.** You pick a long, random path (e.g.
   `/8418321e02fcdab7c4edef1dedc0bf9d49172dee5e3847c9`). Knowing the path is the
   only thing that gets you to the MCP endpoint.
2. **It doesn't look like a web server.** Any request that isn't exactly the
   secret path gets **no HTTP response at all** — the TCP connection is silently
   dropped. A scanner hitting `/`, `/admin`, `/.env`, etc. sees an empty reply,
   as if nothing is listening. Only requests to the secret path get a real
   response.

> This is obscurity, not a substitute for transport security. See
> [Security notes](#security-notes).

## Install

```bash
npm install
npm run build
# optional: make it available on your PATH
npm link
```

Requires Node.js >= 20.

## Usage

```
stdio-mcp-to-http [options] -- <command> [args...]
```

Everything after the literal `--` is the MCP server command and its arguments.

```bash
# Filesystem MCP server, on a random secret path (printed at startup)
stdio-mcp-to-http --port 8080 -- npx -y @modelcontextprotocol/server-filesystem /data

# Pin your own secret path (recommended: keep it stable across restarts)
stdio-mcp-to-http \
  --port 8080 \
  --path "/$(openssl rand -hex 24)" \
  -- npx -y @modelcontextprotocol/server-filesystem /data

# A git MCP server via uv
stdio-mcp-to-http --port 8080 -- uvx mcp-server-git --repository /repo
```

At startup it prints the full endpoint to stderr:

```
  MCP endpoint: http://0.0.0.0:8080/8418321e02fcdab7c4edef1dedc0bf9d49172dee5e3847c9
```

Point your MCP client's **Streamable HTTP** transport at that URL.

### Options

| Flag | Default | Description |
| --- | --- | --- |
| `--path <path>` | random | Secret URL path (must start with `/`). Doubles as the API key. If omitted, a random ephemeral one is generated and printed. |
| `--host <host>` | `0.0.0.0` | Interface to bind. |
| `--port <port>` | `8080` | Port to listen on. |
| `--idle-timeout <secs>` | `600` | Kill a session's child process after this many seconds with no JSON-RPC traffic. `0` disables. |
| `--cwd <dir>` | inherited | Working directory for the child process. |
| `--safe-env` | off | Pass only a safe subset of environment variables to the child, instead of inheriting the full environment. |
| `--max-body <bytes>` | `4194304` | Reject request bodies larger than this. |
| `--log-level <level>` | `info` | `debug` / `info` / `warn` / `error`. Logs go to stderr. |
| `-h`, `--help` | | Show help. |

## How it works

- **One child per session.** When a client sends an MCP `initialize` request, the
  proxy spawns a fresh instance of your stdio MCP server and assigns a session id
  (`Mcp-Session-Id`). That client's requests are routed to that child. When the
  session is closed (client `DELETE`, disconnect, idle timeout, or the child
  exiting) the child process is killed. This gives each client clean, isolated
  state and safe behavior with multiple or reconnecting clients.
- **Transparent relay.** The proxy wires the HTTP transport directly to the
  child's stdio transport and forwards JSON-RPC messages verbatim in both
  directions. It does not interpret tools, resources, or prompts, so it works
  with any MCP server.
- **Environment.** By default the child inherits the proxy's full environment (so
  the MCP server sees the API keys etc. you set on the host). Use `--safe-env` to
  restrict this.

## Security notes

- **The path is a bearer secret.** Anyone who learns it has full access to the
  MCP server. Treat the endpoint URL — and any logs containing it — as a
  credential. Prefer a stable, high-entropy `--path` (24+ random bytes).
- **The stealth drop only holds if this process is what's exposed.** If you put a
  TLS-terminating reverse proxy (nginx, Caddy, Cloudflare) in front of it, *that*
  is the web server an attacker sees — it will answer 404s, serve its own error
  pages, and leak `Server:` headers. To preserve the "not a web server"
  property, expose this process directly.
- **Use TLS for confidentiality.** The path travels in the request line. Over
  plaintext HTTP it is visible to anyone on the wire, which defeats the point of
  a secret path. Terminate TLS in front of it (accepting the reverse-proxy caveat
  above) or run it somewhere the transport is already encrypted (e.g. a
  Tailscale/WireGuard network, an SSH tunnel).
- **This is obscurity, layered — not authentication.** It raises the bar against
  untargeted scanning; it is not a replacement for a real auth layer if you need
  one.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest: end-to-end proxy + stealth tests
npm run dev -- --port 8080 --path /dev -- npx -y @modelcontextprotocol/server-everything
```

## License

MIT
