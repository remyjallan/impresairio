import { Injectable } from '@nestjs/common';
import type {
  WorkflowCondition,
  WorkflowConditionOperand,
  WorkflowPrimitiveValue,
} from './workflow.schema';
import type { RunState } from '../runs/run-state.schema';

@Injectable()
export class ConditionEvaluatorService {
  evaluate(
    condition: WorkflowCondition,
    state: RunState,
    parameters: Readonly<Record<string, WorkflowPrimitiveValue>> | undefined,
  ): boolean {
    if ('equals' in condition) {
      const left = this.operand(condition.equals.left, state, parameters);
      const right = this.operand(condition.equals.right, state, parameters);
      return left !== undefined && right !== undefined && left === right;
    }
    if ('notEquals' in condition) {
      const left = this.operand(condition.notEquals.left, state, parameters);
      const right = this.operand(condition.notEquals.right, state, parameters);
      return left !== undefined && right !== undefined && left !== right;
    }
    if ('all' in condition) return condition.all.every((child) => this.evaluate(child, state, parameters));
    if ('any' in condition) return condition.any.some((child) => this.evaluate(child, state, parameters));
    return !this.evaluate(condition.not, state, parameters);
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
