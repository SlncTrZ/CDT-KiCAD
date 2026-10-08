/**
 * Windows-native MCP reconnect smoke for CDT-KiCAD.
 *
 * Requires a running HTTP provider and KICAD_MCP_TOKEN. It performs read-only
 * provider calls only: help, system_status, and get_backend_state.
 */

import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function parseTextResult(result, toolName) {
  const text = result?.content?.find((item) => item?.type === "text")?.text;
  if (typeof text !== "string") {
    throw new Error(`${toolName} returned no text result`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

const endpoint = argument("--endpoint", "http://127.0.0.1:3100/mcp");
const outputPath = argument("--output", "");
const token = process.env.KICAD_MCP_TOKEN;
if (!token) {
  throw new Error("KICAD_MCP_TOKEN must be provided through the environment.");
}

const client = new Client({ name: "cdt-kicad-native-acceptance", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  },
});

try {
  await client.connect(transport);
  const help = parseTextResult(await client.callTool({ name: "help", arguments: {} }), "help");
  const status = parseTextResult(
    await client.callTool({ name: "system_status", arguments: {} }),
    "system_status",
  );
  const backend = parseTextResult(
    await client.callTool({ name: "get_backend_state", arguments: {} }),
    "get_backend_state",
  );

  const evidence = {
    provider_name: help.provider_name ?? status.provider_name ?? null,
    provider_version: help.provider_version ?? status.provider_version ?? null,
    contract_version: help.contract_version ?? status.contract_version ?? null,
    contract_hash: help.contract_hash ?? status.contract_hash ?? null,
    protocol_version: help.protocol_version ?? null,
    backend,
    reconnected_at: new Date().toISOString(),
  };

  const serialized = JSON.stringify(evidence, null, 2);
  if (outputPath) {
    await writeFile(outputPath, serialized + "\n", "utf8");
  }
  process.stdout.write(serialized + "\n");
} finally {
  await client.close();
}
