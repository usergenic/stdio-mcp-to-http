import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { log } from "./logger.js";

/** How to spawn the wrapped stdio MCP server. */
export interface ChildSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface SessionManagerOptions {
  child: ChildSpec;
  /**
   * Milliseconds a session may go without JSON-RPC traffic before it is reaped
   * (its child process killed). 0 disables idle reaping.
   */
  idleTimeoutMs: number;
}

interface Session {
  /** Assigned once the Streamable HTTP transport initializes the session. */
  id?: string;
  http: StreamableHTTPServerTransport;
  child: StdioClientTransport;
  lastActivity: number;
  /** Guards against re-entrant teardown (close handlers call back into us). */
  closing: boolean;
}

/**
 * Owns the set of live proxy sessions. Each session pairs a Streamable HTTP
 * server transport (the client-facing side) with a freshly spawned stdio child
 * transport (the wrapped MCP server), relaying JSON-RPC messages verbatim in
 * both directions. The relay is intentionally transparent: it does not model
 * tools/resources/prompts, so it works with any MCP server.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  /** Sessions created but not yet assigned an id (mid-initialize). */
  private readonly pending = new Set<Session>();
  private sweeper?: NodeJS.Timeout;

  constructor(private readonly opts: SessionManagerOptions) {
    if (opts.idleTimeoutMs > 0) {
      // Sweep at a fraction of the timeout so reaping is reasonably prompt.
      const interval = Math.max(1000, Math.floor(opts.idleTimeoutMs / 4));
      this.sweeper = setInterval(() => this.reapIdle(), interval);
      this.sweeper.unref();
    }
  }

  get(sessionId: string): StreamableHTTPServerTransport | undefined {
    return this.sessions.get(sessionId)?.http;
  }

  get size(): number {
    return this.sessions.size + this.pending.size;
  }

  /**
   * Spawn a new child and create a Streamable HTTP transport for it. The caller
   * is expected to immediately drive the (initialize) request through the
   * returned transport's handleRequest; that is what assigns the session id.
   */
  async create(): Promise<StreamableHTTPServerTransport> {
    const child = new StdioClientTransport({
      command: this.opts.child.command,
      args: this.opts.child.args,
      env: this.opts.child.env,
      cwd: this.opts.child.cwd,
      // Let the child's stderr flow to ours so its logs remain visible.
      stderr: "inherit",
    });

    const http = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        session.id = id;
        this.pending.delete(session);
        this.sessions.set(id, session);
        log.info("session initialized", { session: id, pid: child.pid ?? undefined, live: this.size });
      },
      onsessionclosed: (id) => {
        log.info("session closed by client", { session: id });
        void this.destroy(session);
      },
    });

    const session: Session = {
      http,
      child,
      lastActivity: Date.now(),
      closing: false,
    };
    this.pending.add(session);

    // Relay: client -> child.
    http.onmessage = (msg: JSONRPCMessage) => {
      session.lastActivity = Date.now();
      child.send(msg).catch((err) => {
        log.error("failed forwarding to child", { session: session.id, error: err });
        void this.destroy(session);
      });
    };

    // Relay: child -> client.
    child.onmessage = (msg: JSONRPCMessage) => {
      session.lastActivity = Date.now();
      http.send(msg).catch((err) => {
        log.warn("failed forwarding to client", { session: session.id, error: err });
      });
    };

    // If either side ends, tear the whole session down.
    child.onclose = () => {
      log.info("child process exited", { session: session.id });
      void this.destroy(session);
    };
    child.onerror = (err) => {
      log.error("child transport error", { session: session.id, error: err });
    };
    http.onclose = () => {
      void this.destroy(session);
    };
    http.onerror = (err) => {
      log.warn("http transport error", { session: session.id, error: err });
    };

    // Spawn the child before we start handling requests through it.
    await child.start();
    await http.start();
    return http;
  }

  private async destroy(session: Session): Promise<void> {
    if (session.closing) return;
    session.closing = true;

    if (session.id) this.sessions.delete(session.id);
    this.pending.delete(session);

    // Closing one transport may trigger its onclose, which re-enters destroy();
    // the `closing` guard above makes that a no-op.
    await Promise.allSettled([session.child.close(), session.http.close()]);
    log.info("session destroyed", { session: session.id, live: this.size });
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (now - session.lastActivity >= this.opts.idleTimeoutMs) {
        log.info("reaping idle session", { session: session.id });
        void this.destroy(session);
      }
    }
  }

  /** Tear down every session and stop the idle sweeper. */
  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    const all = [...this.sessions.values(), ...this.pending];
    await Promise.allSettled(all.map((s) => this.destroy(s)));
  }
}
