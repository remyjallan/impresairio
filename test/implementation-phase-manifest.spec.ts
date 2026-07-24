import { describe, expect, it } from 'vitest';
import {
  ImplementationPhaseManifestError,
  parseImplementationPhaseManifest,
} from '../src/workflows/implementation-phase-manifest';

function manifest(value: string): string {
  return `# Approved implementation plan\n\n\`\`\`impresairio-phase-manifest\n${value}\n\`\`\`\n`;
}

describe('implementation phase manifest parser', () => {
  it('parses a bounded, ordered, data-only phase manifest', () => {
    expect(parseImplementationPhaseManifest(manifest(JSON.stringify({
      phases: [
        {
          id: 'storage', objective: 'Add durable storage.', scope: ['state schema', 'migration'],
          dependsOn: [], verification: ['Run storage unit tests.'], retryBudget: 1,
        },
        {
          id: 'locking', objective: 'Add locking around the new state.', scope: ['run lock'],
          dependsOn: ['storage'], verification: ['Run lock integration tests.'], retryBudget: 2, gate: true,
        },
      ],
    })))).toEqual({
      phases: [
        {
          id: 'storage', objective: 'Add durable storage.', scope: ['state schema', 'migration'],
          dependsOn: [], verification: ['Run storage unit tests.'], retryBudget: 1, gate: false,
        },
        {
          id: 'locking', objective: 'Add locking around the new state.', scope: ['run lock'],
          dependsOn: ['storage'], verification: ['Run lock integration tests.'], retryBudget: 2, gate: true,
        },
      ],
    });
  });

  it('rejects missing, duplicate, executable, oversized, and unordered manifests', () => {
    expect(() => parseImplementationPhaseManifest('# no manifest')).toThrow('exactly one');
    expect(() => parseImplementationPhaseManifest(`${manifest('{"phases":[]}')}\n${manifest('{"phases":[]}')}`)).toThrow('exactly one');
    expect(() => parseImplementationPhaseManifest(manifest(JSON.stringify({
      phases: [{
        id: 'unsafe', objective: 'Run {{ command }}.', scope: ['shell'], dependsOn: [],
        verification: ['Do it.'], retryBudget: 0,
      }],
    })))).toThrow('plain text');
    expect(() => parseImplementationPhaseManifest(manifest(JSON.stringify({
      phases: [{
        id: 'later', objective: 'Later.', scope: ['scope'], dependsOn: ['earlier'],
        verification: ['Check it.'], retryBudget: 0,
      }],
    })))).toThrow('preceding phase ID');
    expect(() => parseImplementationPhaseManifest(manifest(JSON.stringify({
      phases: [
        {
          id: 'storage', objective: 'Add storage.', scope: ['state'], dependsOn: [],
          verification: ['Run storage tests.'], retryBudget: 0,
        },
        {
          id: 'storage', objective: 'Add another storage step.', scope: ['migration'], dependsOn: [],
          verification: ['Run migration tests.'], retryBudget: 0,
        },
      ],
    })))).toThrow('duplicate phase ID');
    expect(() => parseImplementationPhaseManifest(manifest(JSON.stringify({
      phases: Array.from({ length: 7 }, (_value, index) => ({
        id: `phase-${index}`, objective: 'Bounded phase.', scope: ['scope'], dependsOn: [],
        verification: ['Check it.'], retryBudget: 0,
      })),
    })))).toThrow('expected array to have <=6 items');
  });

  it('reports malformed phase-manifest JSON as a typed error', () => {
    expect(() => parseImplementationPhaseManifest(manifest('{not JSON}')))
      .toThrow(ImplementationPhaseManifestError);
  });
});
