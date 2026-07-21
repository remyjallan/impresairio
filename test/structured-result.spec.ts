import { describe, expect, it } from 'vitest';
import { workflowResultSchema } from '../src/workflows/workflow.schema';
import { parseStructuredResult, StructuredResultError } from '../src/workflows/structured-result';

const declaration = workflowResultSchema.parse({
  fields: {
    complexity: { type: 'enum', values: ['trivial', 'standard', 'complex'] },
    'isolate-worktree': { type: 'boolean' },
  },
});

describe('structured result parser', () => {
  it('extracts and validates exactly one declared JSON result block', () => {
    expect(parseStructuredResult([
      '# Classification', '', '```impresairio-result',
      '{"complexity":"standard","isolate-worktree":true}', '```', '',
    ].join('\n'), declaration)).toEqual({ complexity: 'standard', 'isolate-worktree': true });
  });

  it('rejects missing, duplicate, invalid, incomplete, and extra result blocks', () => {
    expect(() => parseStructuredResult('# no result', declaration)).toThrow('exactly one');
    expect(() => parseStructuredResult('```impresair-result\n{}\n```', declaration)).toThrow(StructuredResultError);
    expect(() => parseStructuredResult('```impresairio-result\nnot json\n```', declaration)).toThrow('Invalid impresairio-result JSON');
    expect(() => parseStructuredResult('```impresairio-result\n{"complexity":"standard"}\n```', declaration)).toThrow('missing fields');
    expect(() => parseStructuredResult('```impresairio-result\n{"complexity":"standard","isolate-worktree":true,"extra":1}\n```', declaration)).toThrow('unknown fields');
  });
});
