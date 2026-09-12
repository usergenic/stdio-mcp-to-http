import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProxyServer } from "../src/server.js";
import { setLogLevel } from "../src/logger.js";

const here = dirname(fileURLToPath(import.meta.url));
const tsxBin = resolve(here, "../node_modules/.bin/tsx");
const fixture = resolve(here, "fixtures/echo-server.ts");
const SECRET = "/" + "a".repeat(48);

let server: ProxyServer;
let baseUrl: string;

beforeAll(async () => {
  setLogLevel("error"); // keep test output quiet
  process.env.FIXTURE_MARKER = "hello-from-env";
  server = new ProxyServer({
    host: "127.0.0.1",
    port: 0,
    secretPath: SECRET,
    idleTimeoutMs: 0,
    maxBodyBytes: 1024 * 1024,
    child: {
      command: tsxBin,
      args: [fixture],
      env: Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => typeof v === "string"),
      ) as Record<string, string>,
    },
  });
  await server.listen();
  baseUrl = `http://127.0.0.1:${server.boundPort}`;
});

afterAll(async () => {
  await server.close();
});

async function connectClient(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl + SECRET));
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

describe("stdio-mcp-to-http proxy", () => {
  it("relays initialize + tools/list through to the child", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["add", "whoami"]);
    await client.close();
  });

  it("relays a tools/call round trip", async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: "add", arguments: { a: 2, b: 40 } });
    expect((res.content as Array<{ type: string; text: string }>)[0].text).toBe("42");
    await client.close();
  });

  it("passes the parent environment through to the child", async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: "whoami", arguments: {} });
    expect((res.content as Array<{ type: string; text: string }>)[0].text).toBe("hello-from-env");
    await client.close();
  });

  it("gives each client its own session/child", async () => {
    const a = await connectClient();
    const b = await connectClient();
    // Both work independently.
    await expect(a.listTools()).resolves.toBeTruthy();
    await expect(b.listTools()).resolves.toBeTruthy();
    await a.close();
    // b keeps working after a closes.
    await expect(b.listTools()).resolves.toBeTruthy();
    await b.close();
  });

  it("silently drops connections to any non-secret path (no HTTP response)", async () => {
    await expect(fetch(baseUrl + "/")).rejects.toThrow();
    await expect(fetch(baseUrl + "/wrong")).rejects.toThrow();
    await expect(fetch(baseUrl + SECRET + "extra")).rejects.toThrow();
  });

  it("returns a JSON-RPC 404 for an unknown session on the secret path", async () => {
    const res = await fetch(baseUrl + SECRET, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": "does-not-exist",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});
