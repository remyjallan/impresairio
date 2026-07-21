import type { WorkflowPrimitiveValue, WorkflowResult } from './workflow.schema';
import { validateParameterValue, WorkflowParameterError } from './workflow-parameters';

export class StructuredResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuredResultError';
  }
}

const resultBlockPattern = /```impresairio-result[ \t]*\r?\n([\s\S]*?)\r?\n```/g;

export function parseStructuredResult(
  markdown: string,
  declaration: WorkflowResult,
): Record<string, WorkflowPrimitiveValue> {
  const blocks = [...markdown.matchAll(resultBlockPattern)];
  if (blocks.length !== 1) {
    throw new StructuredResultError(`Expected exactly one impresairio-result block, found ${blocks.length}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(blocks[0][1]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid JSON';
    throw new StructuredResultError(`Invalid impresairio-result JSON: ${detail}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StructuredResultError('impresairio-result must be a JSON object');
  }
  const value = parsed as Record<string, unknown>;
  const expectedNames = Object.keys(declaration.fields);
  const actualNames = Object.keys(value);
  const missing = expectedNames.filter((name) => !Object.hasOwn(value, name));
  const unexpected = actualNames.filter((name) => !Object.hasOwn(declaration.fields, name));
  if (missing.length > 0) throw new StructuredResultError(`impresairio-result is missing fields: ${missing.join(', ')}`);
  if (unexpected.length > 0) throw new StructuredResultError(`impresairio-result has unknown fields: ${unexpected.join(', ')}`);
  const result: Record<string, WorkflowPrimitiveValue> = {};
  for (const [name, definition] of Object.entries(declaration.fields)) {
    try {
      result[name] = validateParameterValue(name, value[name], definition);
    } catch (error) {
      const detail = error instanceof WorkflowParameterError ? error.message : String(error);
      throw new StructuredResultError(`Invalid impresairio-result field: ${detail}`);
    }
  }
  return result;
}
