import type {
  AcpToolCallSnapshot,
  AcpTransformer,
} from "@getpaseo/plugin/server/acp";
import type { ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";
import { z } from "zod";

const shellInput = z.object({ CommandLine: z.string() });
const shellOutput = z.object({
  output: z.string().optional(),
  exit_code: z.number().nullable().optional(),
});
const fileRead = z.object({
  Path: z.string().optional(),
  StartLine: z.int().positive().optional(),
  EndLine: z.int().positive().optional(),
});
const fileWrite = z.object({
  Path: z.string(),
  Content: z.string().optional(),
});
const webSearch = z.object({ query: z.string() });
const fileEdit = z.object({
  Path: z.string().optional(),
  Target: z.string().optional(),
  Replacement: z.string().optional(),
}).passthrough();

function outputText(output: AcpToolCallSnapshot["output"]): string | undefined {
  if (typeof output === "string") return output;
  const parsed = z.object({ content: z.string().optional(), text: z.string().optional() })
    .safeParse(output).data;
  return parsed?.content ?? parsed?.text;
}

export const mapToolCall: NonNullable<AcpTransformer["toolCall"]> = (
  call,
  context,
) => {
  if (call.name?.startsWith("mcp_")) {
    return mapMcpCall(call, call.name, context.mcpServerNames ?? []);
  }
  if (call.name === "edit_file") {
    const input = fileEdit.safeParse(call.input).data;
    if (input) {
      // Normalize only the presentation snapshot. Let each SDK prefer native
      // diff blocks; setting detail here would conceal them in 0.17.3.
      return { ...call, input: {
        ...(input.Path !== undefined ? { filePath: input.Path } : {}),
        ...(input.Target !== undefined ? { oldString: input.Target } : {}),
        ...(input.Replacement !== undefined ? { newString: input.Replacement } : {}),
        ...input,
      } };
    }
  }
  const detail = mapNativeDetail(call);
  return detail ? { ...call, detail } : call;
};

function mapNativeDetail(
  call: AcpToolCallSnapshot,
): ProviderToolCallDetail | undefined {
  switch (call.name) {
    case "run_command": {
      const input = shellInput.safeParse(call.input).data;
      if (!input) break;
      const output = shellOutput.safeParse(call.output).data;
      return {
        type: "shell",
        command: input.CommandLine,
        output: typeof call.output === "string" ? call.output : output?.output,
        exitCode: output?.exit_code,
      };
    }
    case "write_file": {
      const input = fileWrite.safeParse(call.input).data;
      if (input)
        return { type: "write", filePath: input.Path, content: input.Content };
      break;
    }
    case "search_web": {
      const input = webSearch.safeParse(call.input).data;
      if (input)
        return { type: "search", toolName: "web_search", query: input.query,
          content: outputText(call.output) };
      break;
    }
  }
  if (call.kind !== "read") return undefined;
  const input = fileRead.safeParse(call.input).data;
  const filePath = call.locations[0] ?? input?.Path;
  if (!filePath) return undefined;
  const { StartLine: offset, EndLine: end } = input ?? {};
  return {
    type: "read",
    filePath,
    content: outputText(call.output),
    offset,
    limit:
      offset !== undefined && end !== undefined && end >= offset
        ? end - offset + 1
        : undefined,
  };
}

function mapMcpCall(
  call: AcpToolCallSnapshot,
  wireName: string,
  serverNames: readonly string[],
): AcpToolCallSnapshot {
  const qualifiedName = wireName.slice("mcp_".length);
  // The wire uses the same separator inside names and between the server and tool.
  // Paseo's own server can also appear when replaying with MCP disabled.
  const matchingServers = [...new Set([...serverNames, "paseo"])].filter(
    (name) => qualifiedName.startsWith(`${name}_`),
  );
  const server = matchingServers.length === 1 ? matchingServers[0] : undefined;
  let input = call.input;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const { toolSummary: _summary, ...args } = input;
    input = args;
  }
  return {
    ...call,
    name: server
      ? `${server}.${qualifiedName.slice(server.length + 1)}`
      : wireName,
    detail: { type: "unknown", input, output: call.output },
  };
}
