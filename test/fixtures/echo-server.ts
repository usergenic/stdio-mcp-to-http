/**
 * Trivial stdio MCP server used as the wrapped child in proxy tests.
 * Exposes:
 *   - "add"    -> sums two numbers
 *   - "whoami" -> echoes the FIXTURE_MARKER env var (to prove env passthrough)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "echo-fixture", version: "0.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "add",
      description: "Add two numbers",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    },
    {
      name: "whoami",
      description: "Echo the FIXTURE_MARKER environment variable",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "add") {
    const a = Number((args as Record<string, unknown>).a);
    const b = Number((args as Record<string, unknown>).b);
    return { content: [{ type: "text", text: String(a + b) }] };
  }
  if (name === "whoami") {
    return { content: [{ type: "text", text: process.env.FIXTURE_MARKER ?? "unset" }] };
  }
  throw new Error(`unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
