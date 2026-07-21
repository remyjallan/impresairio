import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fallbackPromptFor } from '../src/agents/fallback-prompts';

const evidenceRequirement = 'Separate observed evidence';
const inspectedPromptFiles = [
  ['change-classification', 'change-classification.md'],
  ['investigate', 'investigate.md'],
  ['implement', 'implement.md'],
  ['implementation', 'implementation.md'],
  ['final-review', 'final-review.md'],
  ['verification', 'verification.md'],
] as const;

describe('fallback prompts', () => {
  it.each(inspectedPromptFiles)('requires repository evidence for %s', (action, filename) => {
    const packaged = readFileSync(join(__dirname, '..', 'src', 'prompts', 'builtins', filename), 'utf8');
    const legacy = action === 'change-classification' ? undefined : fallbackPromptFor(action);

    expect(packaged).toContain('Inspect');
    expect(packaged).toContain(evidenceRequirement);
    expect(packaged).toMatch(/do not claim a check passed unless you ran it\./i);
    if (legacy !== undefined) {
      expect(legacy).toContain('Inspect');
      expect(legacy).toContain(evidenceRequirement);
      expect(legacy).toMatch(/do not claim a check passed unless you ran it\./i);
    }
  });
});
