import { describe, expect, it } from 'vitest';
import {
  parseParameterAssignments,
  resolveChildParameters,
  resolveRootParameters,
  WorkflowParameterError,
} from '../src/workflows/workflow-parameters';
import { workflowParametersSchema } from '../src/workflows/workflow.schema';

const definitions = workflowParametersSchema.parse({
  'quality-mode': { type: 'enum', values: ['light', 'strict'], default: 'light' },
  'isolate-worktree': { type: 'boolean', default: false },
  'max-files': { type: 'integer', minimum: 1, maximum: 100, default: 10 },
  summary: { type: 'string', minLength: 3, maxLength: 20 },
});

describe('workflow parameters', () => {
  it('parses explicit CLI values and applies defaults', () => {
    const raw = parseParameterAssignments(['quality-mode=strict', 'isolate-worktree=true', 'summary=Account merge']);
    expect(resolveRootParameters(definitions, raw)).toEqual({
      'quality-mode': 'strict', 'isolate-worktree': true, 'max-files': 10, summary: 'Account merge',
    });
  });

  it('rejects duplicate, unknown, malformed and missing values', () => {
    expect(() => parseParameterAssignments(['quality-mode=light', 'quality-mode=strict']))
      .toThrow('supplied more than once');
    expect(() => resolveRootParameters(definitions, { unknown: 'x', summary: 'valid' }))
      .toThrow('does not declare parameter "unknown"');
    expect(() => resolveRootParameters(definitions, { 'isolate-worktree': 'yes', summary: 'valid' }))
      .toThrow('exactly true or false');
    expect(() => resolveRootParameters(definitions, { summary: 'x' }))
      .toThrow('at least 3 characters');
    expect(() => resolveRootParameters(definitions, {})).toThrow('requires --param summary=<value>');
  });

  it('resolves typed child mappings and rejects unavailable or incompatible values', () => {
    const parent = { 'quality-mode': 'strict' as const, 'isolate-worktree': true, 'max-files': 10, summary: 'Account merge' };
    const child = workflowParametersSchema.parse({
      'quality-mode': { type: 'enum', values: ['light', 'strict'] },
      'isolate-worktree': { type: 'boolean', default: false },
    });
    expect(resolveChildParameters(child, parent, {
      'quality-mode': { fromParameter: 'quality-mode' },
    })).toEqual({ 'quality-mode': 'strict', 'isolate-worktree': false });
    expect(() => resolveChildParameters(child, parent, { 'quality-mode': { fromParameter: 'missing' } }))
      .toThrow('Cannot resolve parent parameter "missing"');
    expect(() => resolveChildParameters(child, parent, { 'quality-mode': true }))
      .toThrow('must be one of: light, strict');
    expect(() => resolveChildParameters(child, parent, { missing: 'value' } as never))
      .toThrow('does not declare parameter "missing"');
  });

  it('rejects dynamic or multiline strings', () => {
    expect(() => resolveRootParameters(definitions, { summary: '{{ unsafe }}' }))
      .toThrow(WorkflowParameterError);
    expect(() => resolveRootParameters(definitions, { summary: 'line\nbreak' }))
      .toThrow('single-line literal string');
  });
});
