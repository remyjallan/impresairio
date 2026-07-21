import { executionDirectory, extractContent, extractDeniedWriteContent } from '../src/commands/advance.command';
import { describe, expect, it } from 'vitest';

describe('advance command output recovery', () => {
  it('uses the frozen repository and preserves caller-CWD fallback for legacy runs', () => {
    expect(executionDirectory('/workspace/project', '/caller')).toBe('/workspace/project');
    expect(executionDirectory(undefined, '/caller')).toBe('/caller');
  });

  it('extracts a structured Claude response', () => {
    expect(extractContent(JSON.stringify({
      result: JSON.stringify({ markdown: '# Review', verdict: 'APPROVED' }),
    }))).toBe('# Review\n\nVERDICT: APPROVED');
  });

  it('recovers only content from a completed Claude Write denial', () => {
    expect(extractDeniedWriteContent(JSON.stringify({
      subtype: 'error_during_execution',
      permission_denials: [{ tool_name: 'Write', tool_input: { file_path: '/tmp/staging.md', content: '# Review\n\nVERDICT: APPROVED\n' } }],
    }), '/tmp/staging.md')).toBe('# Review\n\nVERDICT: APPROVED\n');
  });

  it('does not turn unrelated provider failures into artifact content', () => {
    expect(extractDeniedWriteContent(JSON.stringify({
      subtype: 'error_during_execution',
      permission_denials: [{ tool_name: 'Bash', tool_input: { file_path: '/tmp/staging.md', content: '# Not an artifact' } }],
    }), '/tmp/staging.md')).toBeUndefined();
  });

  it('does not recover a denied write for another path', () => {
    expect(extractDeniedWriteContent(JSON.stringify({
      subtype: 'error_during_execution',
      permission_denials: [{ tool_name: 'Write', tool_input: { file_path: '/tmp/other.md', content: '# Wrong artifact' } }],
    }), '/tmp/staging.md')).toBeUndefined();
  });
});
