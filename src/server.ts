import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { SessionManager, type ChildSpec } from "./proxy.js";
import { log } from "./logger.js";

export interface ProxyServerOptions {
  host: string;
  port: number;
  /** The secret URL path that doubles as an API key, e.g. "/9f3a...". */
  secretPath: string;
  child: ChildSpec;
  idleTimeoutMs: number;
  /** Reject bodies larger than this many bytes. */
  maxBodyBytes: number;
}

const SESSION_HEADER = "mcp-session-id";

/** Constant-time path comparison so the secret path can't be probed by timing. */
function pathMatches(actual: string, secret: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class ProxyServer {
  private readonly server: http.Server;
  private readonly sessions: SessionManager;

  constructor(private readonly opts: ProxyServerOptions) {
    this.sessions = new SessionManager({
      child: opts.child,
      idleTimeoutMs: opts.idleTimeoutMs,
    });
    this.server = http.createServer((req, res) => {
      this.onRequest(req, res).catch((err) => {
        log.error("unhandled request error", { error: err });
        // Never leak an error page; behave like the request never happened.
        try {
          req.socket.destroy();
        } catch {
          /* ignore */
        }
      });
    });
    // Do not advertise a keep-alive banner or server identity anywhere.
    this.server.on("clientError", (_err, socket) => socket.destroy());
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    // Stealth gate: anything that is not exactly the secret path gets no HTTP
    // response at all. We destroy the socket so the port does not look like a
    // web server to a scanner that doesn't already know the secret path.
    if (!pathMatches(url.pathname, this.opts.secretPath)) {
      req.socket.destroy();
      return;
    }

    // From here on the caller has already proven knowledge of the secret path,
    // so ordinary MCP/HTTP protocol errors are acceptable and useful.
    switch (req.method) {
      case "POST":
        await this.handlePost(req, res);
        return;
      case "GET":
      case "DELETE":
        // No body; hand straight to the session's transport.
        await this.handleSessionRequest(req, res);
        return;
      default:
        // Unexpected method on the secret path: stay silent.
        req.socket.destroy();
        return;
    }
  }

  private async handlePost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await this.readJsonBody(req);
    } catch (err) {
      log.warn("bad request body", { error: err });
      writeJsonRpcError(res, 400, -32700, "Parse error");
      return;
    }

    const sessionId = headerValue(req, SESSION_HEADER);

    if (sessionId) {
      const transport = this.sessions.get(sessionId);
      if (!transport) {
        writeJsonRpcError(res, 404, -32001, "Session not found");
        return;
      }
      await transport.handleRequest(req, res, body);
      return;
    }

    // No session id: only an initialize request may open a new session.
    if (isInitializeRequest(body)) {
      const transport = await this.sessions.create();
      await transport.handleRequest(req, res, body);
      return;
    }

    writeJsonRpcError(res, 400, -32000, "Missing session ID");
  }

  private async handleSessionRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const sessionId = headerValue(req, SESSION_HEADER);
    if (!sessionId) {
      writeJsonRpcError(res, 400, -32000, "Missing session ID");
      return;
    }
    const transport = this.sessions.get(sessionId);
    if (!transport) {
      writeJsonRpcError(res, 404, -32001, "Session not found");
      return;
    }
    await transport.handleRequest(req, res);
  }

  private readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.opts.maxBodyBytes) {
          reject(new Error("request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw.length === 0) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", reject);
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.opts.port, this.opts.host, () => resolve());
    });
  }

  /** The actually-bound port. Useful when listening on port 0 (tests). */
  get boundPort(): number {
    const addr = this.server.address();
    if (addr && typeof addr === "object") return addr.port;
    throw new Error("server is not listening on a TCP port");
  }

  async close(): Promise<void> {
    await this.sessions.shutdown();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function headerValue(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function writeJsonRpcError(
  res: http.ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}
