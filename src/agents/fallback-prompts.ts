import type { AgentAction } from './agent-provider';

// Serves frozen V0 runs only: legacy `{action}` run-state methods created before
// capabilities existed still resolve their prompt text from here at dispatch time.
// New runs resolve capability prompts through CapabilityResolverService at start.
const actionPrompts: Record<AgentAction, string> = {
  'feature-design': 'Develop a functional feature design. State goals, non-goals, rules, edge cases and open decisions.',
  'adversarial-review': 'Challenge the preceding artifact. Identify flawed assumptions, missing cases, risks and simpler alternatives.',
  specification: 'Write a precise implementation-neutral specification based on the approved design.',
  'spec-review': 'Review the specification for ambiguity, omitted acceptance criteria and inconsistencies with the design.',
  'integration-plan': 'Produce a detailed, testable integration plan with file-level tasks and verification steps.',
  'plan-review': 'Review the integration plan for sequencing, scope, risks and validation gaps.',
  implementation: 'Inspect the relevant source files and tests before implementing the approved plan. Report observed behavior, changed files, executed checks, and remaining limitations. Separate observed evidence (with file paths) from assumptions or open questions. Do not claim a check passed unless you ran it.',
  'final-review': 'Inspect the changed source files and relevant tests before reviewing the completed implementation. Report defects, regressions, or verification gaps. Separate observed evidence (with file paths) from assumptions or open questions. Do not claim a check passed unless you ran it.',
  'final-report': 'Summarize the completed workflow, decisions, validation and remaining follow-up.',
  investigate: 'Inspect relevant repository files and tests before making repository-specific claims. Reproduce the reported issue when possible and identify the smallest safe correction. Separate observed evidence (with file paths) from assumptions or open questions. Report executed checks and their actual results; do not claim a check passed unless you ran it.',
  implement: 'Inspect the relevant source files and tests before implementing the approved correction. Explain the observed behavior, changed files, and verification performed. Separate observed evidence (with file paths) from assumptions or open questions. Report executed checks and their actual results; do not claim a check passed unless you ran it.',
  verification: 'Inspect the changed source files and relevant tests before verifying the correction against its acceptance criteria. Separate observed evidence (with file paths) from assumptions or open questions. Report executed checks and their actual results; do not claim a check passed unless you ran it.',
};

export function fallbackPromptFor(action: AgentAction): string {
  return actionPrompts[action];
}
