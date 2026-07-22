import { Injectable } from '@nestjs/common';
import type {
  WorkflowCondition,
  WorkflowConditionOperand,
  WorkflowPrimitiveValue,
} from './workflow.schema';
import type { RunState } from '../runs/run-state.schema';

interface ConditionEvaluation {
  readonly value: boolean;
  readonly unresolved: boolean;
}

@Injectable()
export class ConditionEvaluatorService {
  evaluate(
    condition: WorkflowCondition,
    state: RunState,
    parameters: Readonly<Record<string, WorkflowPrimitiveValue>> | undefined,
  ): boolean {
    return this.evaluateCondition(condition, state, parameters).value;
  }

  /**
   * Missing parameters/results are unknown, not values. Unknown operands make
   * the whole condition false, including through `not`, so a workflow never
   * runs a step merely because a prerequisite result is unavailable.
   */
  private evaluateCondition(
    condition: WorkflowCondition,
    state: RunState,
    parameters: Readonly<Record<string, WorkflowPrimitiveValue>> | undefined,
  ): ConditionEvaluation {
    if ('equals' in condition) {
      const left = this.operand(condition.equals.left, state, parameters);
      const right = this.operand(condition.equals.right, state, parameters);
      const unresolved = left === undefined || right === undefined;
      return { value: !unresolved && left === right, unresolved };
    }
    if ('notEquals' in condition) {
      const left = this.operand(condition.notEquals.left, state, parameters);
      const right = this.operand(condition.notEquals.right, state, parameters);
      const unresolved = left === undefined || right === undefined;
      return { value: !unresolved && left !== right, unresolved };
    }
    if ('all' in condition) {
      const children = condition.all.map((child) => this.evaluateCondition(child, state, parameters));
      const unresolved = children.some((child) => child.unresolved);
      return { value: !unresolved && children.every((child) => child.value), unresolved };
    }
    if ('any' in condition) {
      const children = condition.any.map((child) => this.evaluateCondition(child, state, parameters));
      const unresolved = children.some((child) => child.unresolved);
      return { value: !unresolved && children.some((child) => child.value), unresolved };
    }
    const child = this.evaluateCondition(condition.not, state, parameters);
    return { value: !child.unresolved && !child.value, unresolved: child.unresolved };
  }

  private operand(
    operand: WorkflowConditionOperand,
    state: RunState,
    parameters: Readonly<Record<string, WorkflowPrimitiveValue>> | undefined,
  ): WorkflowPrimitiveValue | undefined {
    if (typeof operand === 'string' || typeof operand === 'boolean' || typeof operand === 'number') return operand;
    if ('parameter' in operand) return parameters?.[operand.parameter];
    const source = state.steps.find((step): step is Extract<RunState['steps'][number], { readonly kind: 'agent' }> => (
      step.kind === 'agent' && step.id === operand.result.step
    ));
    return source?.result?.value[operand.result.field];
  }
}
