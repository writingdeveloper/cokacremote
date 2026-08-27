import type { CallToolResult } from "@modelcontextprotocol/server";
import { errorMessage } from "./errors.js";

const SUMMARY_MAX_VALUE_CHARS = 160;
const SUMMARY_MAX_FIELDS = 8;

export interface SuccessResultOptions {
  text?: string;
}

function summarizeValue(value: unknown): string | undefined {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return '""';
    }
    const clipped = normalized.length > SUMMARY_MAX_VALUE_CHARS
      ? `${normalized.slice(0, SUMMARY_MAX_VALUE_CHARS - 1)}…`
      : normalized;
    return JSON.stringify(clipped);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>).length} fields}`;
  }
  return undefined;
}

export function summarizeStructuredResult(data: Record<string, unknown>): string {
  if (typeof data.output === "string" && data.output.length > 0) {
    return data.output;
  }
  if (typeof data.content === "string" && data.content.length > 0) {
    return data.content;
  }
  if (typeof data.message === "string" && data.message.length > 0) {
    return data.message;
  }

  const summary: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    const rendered = summarizeValue(value);
    if (rendered !== undefined) {
      summary.push(`${key}=${rendered}`);
    }
    if (summary.length >= SUMMARY_MAX_FIELDS) {
      break;
    }
  }
  return summary.join(" ");
}

export function successResult(
  data: Record<string, unknown>,
  options: SuccessResultOptions = {},
): CallToolResult {
  const text = options.text ?? summarizeStructuredResult(data);
  return {
    content: text ? [{ type: "text", text }] : [],
    structuredContent: data,
  };
}

export function errorResult(error: unknown): CallToolResult {
  const message = errorMessage(error);
  const data = { error: message };
  return {
    content: [{ type: "text", text: message }],
    structuredContent: data,
    isError: true,
  };
}

export async function runTool(
  operation: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    return successResult(await operation());
  } catch (error) {
    return errorResult(error);
  }
}
