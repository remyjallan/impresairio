import type { AgentAction } from './agent-provider';

const actionPrompts: Record<AgentAction, string> = {
  'feature-design': 'Develop a functional feature design. State goals, non-goals, rules, edge cases and open decisions.',
  'adversarial-review': 'Challenge the preceding artifact. Identify flawed assumptions, missing cases, risks and simpler alternatives. End the Markdown response with exactly one of: VERDICT: APPROVED, VERDICT: CHANGES_REQUESTED, or VERDICT: BLOCKED.',
  specification: 'Write a precise implementation-neutral specification based on the approved design.',
  'spec-review': 'Review the specification for ambiguity, omitted acceptance criteria and inconsistencies with the design. End the Markdown response with exactly one of: VERDICT: APPROVED, VERDICT: CHANGES_REQUESTED, or VERDICT: BLOCKED.',
  'integration-plan': 'Produce a detailed, testable integration plan with file-level tasks and verification steps.',
  'plan-review': 'Review the integration plan for sequencing, scope, risks and validation gaps. End the Markdown response with exactly one of: VERDICT: APPROVED, VERDICT: CHANGES_REQUESTED, or VERDICT: BLOCKED.',
  implementation: 'Implement the approved plan, run the applicable checks and report changed behavior.',
  'final-review': 'Review the completed implementation and report defects, regressions or verification gaps.',
  'final-report': 'Summarize the completed workflow, decisions, validation and remaining follow-up.',
  investigate: 'Investigate the reported issue, reproduce it when possible and identify the smallest safe correction.',
  implement: 'Implement the approved correction and explain the verification performed.',
  verification: 'Verify the correction against its acceptance criteria and report the result.',
};

export function fallbackPromptFor(action: AgentAction): string {
  return actionPrompts[action];
}
