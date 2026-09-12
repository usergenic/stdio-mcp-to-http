#!/usr/bin/env node
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProxyServer } from "./server.js";
import { log, setLogLevel } from "./logger.js";

const USAGE = `stdio-mcp-to-http — expose a stdio MCP server over Streamable HTTP

Usage:
  stdio-mcp-to-http [options] -- <command> [args...]

The MCP server command and its arguments come after a literal "--".
Every request that does not match the secret --path gets no HTTP response
at all (the TCP connection is silently dropped), so the port does not look
like a web server to anyone who does not already know the path.

Options:
  --path <path>          Secret URL path that doubles as an API key
                         (must start with "/"). If omitted, a random one is
                         generated and printed at startup.
  --host <host>          Interface to bind (default: 0.0.0.0)
  --port <port>          Port to listen on (default: 8080)
  --idle-timeout <secs>  Kill a session's child after this many seconds with no
                         JSON-RPC traffic. 0 disables. (default: 600)
  --cwd <dir>            Working directory for the child process
  --safe-env             Only pass a safe subset of env vars to the child,
                         instead of inheriting the full environment
  --max-body <bytes>     Max accepted request body size (default: 4194304)
  --log-level <level>    debug | info | warn | error (default: info)
  -h, --help             Show this help

Examples:
  stdio-mcp-to-http --port 8080 --path /$(openssl rand -hex 24) -- \\
    npx -y @modelcontextprotocol/server-filesystem /data

  stdio-mcp-to-http -- uvx mcp-server-git --repository /repo
`;

function fail(message: string): never {
  process.stderr.write(message + "\n\n");
  process.stderr.write(USAGE);
  process.exit(2);
}

function splitArgv(argv: string[]): { own: string[]; child: string[] } {
  const idx = argv.indexOf("--");
  if (idx === -1) return { own: argv, child: [] };
  return { own: argv.slice(0, idx), child: argv.slice(idx + 1) };
}

function parsePositiveInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) fail(`--${name} must be a non-negative integer, got: ${value}`);
  return n;
}

function buildChildEnv(safe: boolean): Record<string, string> {
  if (safe) return getDefaultEnvironment();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  return env;
}

async function main(): Promise<void> {
  const { own, child } = splitArgv(process.argv.slice(2));

  let parsed;
  try {
    parsed = parseArgs({
      args: own,
      allowPositionals: false,
      options: {
        path: { type: "string" },
        host: { type: "string" },
        port: { type: "string" },
        "idle-timeout": { type: "string" },
        cwd: { type: "string" },
        "safe-env": { type: "boolean" },
        "max-body": { type: "string" },
        "log-level": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    fail((err as Error).message);
  }

  const { values } = parsed;

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (values["log-level"]) {
    const lvl = values["log-level"];
    if (lvl !== "debug" && lvl !== "info" && lvl !== "warn" && lvl !== "error") {
      fail(`--log-level must be one of debug|info|warn|error, got: ${lvl}`);
    }
    setLogLevel(lvl);
  }

  if (child.length === 0) {
    fail('No MCP command given. Put it after "--", e.g. -- npx -y some-mcp-server');
  }

  let secretPath = values.path;
  let generated = false;
  if (!secretPath) {
    secretPath = "/" + randomBytes(24).toString("hex");
    generated = true;
  }
  if (!secretPath.startsWith("/")) {
    fail(`--path must start with "/", got: ${secretPath}`);
  }

  const host = values.host ?? "0.0.0.0";
  const port = values.port ? parsePositiveInt("port", values.port) : 8080;
  const idleTimeoutMs =
    (values["idle-timeout"] ? parsePositiveInt("idle-timeout", values["idle-timeout"]) : 600) * 1000;
  const maxBodyBytes = values["max-body"] ? parsePositiveInt("max-body", values["max-body"]) : 4 * 1024 * 1024;

  const server = new ProxyServer({
    host,
    port,
    secretPath,
    idleTimeoutMs,
    maxBodyBytes,
    child: {
      command: child[0],
      args: child.slice(1),
      env: buildChildEnv(Boolean(values["safe-env"])),
      cwd: values.cwd,
    },
  });

  await server.listen();

  log.info("listening", { host, port, command: child.join(" ") });
  if (generated) {
    log.warn("no --path given; generated an ephemeral secret path (changes on restart)");
  }
  // The full endpoint is the one thing worth printing plainly to stderr so the
  // operator can copy it. It is a secret; treat these logs as sensitive.
  process.stderr.write(`\n  MCP endpoint: http://${host}:${port}${secretPath}\n\n`);

  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    server
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal", { error: err });
  process.exit(1);
});
