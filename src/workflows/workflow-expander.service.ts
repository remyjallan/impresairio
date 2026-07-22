import { Injectable } from '@nestjs/common';
import type {
  WorkflowCondition,
  WorkflowConditionOperand,
  WorkflowParameters,
  WorkflowPrimitiveValue,
  WorkflowResult,
  WorkflowPatch,
  WorkflowStep,
  WorkflowVerdictPolicy,
} from './workflow.schema';
import {
  type ResolvedWorkflow,
  type WorkflowSource,
  WorkflowError,
  WorkflowRegistryService,
} from './workflow-registry.service';
import { parameterValueType, resolveChildParameters, resolveRootParameters } from './workflow-parameters';

type WorkflowOutput = Extract<WorkflowStep, { readonly output: unknown }>['output'];

const MAX_COMPOSITION_DEPTH = 32;

export interface WorkflowDefinitionSnapshot {
  readonly instanceId: string;
  readonly workflowId: string;
  readonly source: WorkflowSource;
  readonly sha256: string;
}

interface ExpandedStepMetadata {
  readonly definition: ResolvedWorkflow;
  readonly originStepId: string;
}

interface ExpandedAgentStepBase extends ExpandedStepMetadata {
  readonly id: string;
  readonly type: 'agent';
  readonly actor: string;
  readonly output: WorkflowOutput;
  readonly effectiveParameters: Readonly<Record<string, WorkflowPrimitiveValue>>;
  readonly parameterDefinitions: WorkflowParameters | undefined;
  readonly result?: WorkflowResult;
  readonly when?: WorkflowCondition;
  readonly verdictPolicy?: WorkflowVerdictPolicy;
  readonly patch?: WorkflowPatch;
  readonly cycle?: {
    readonly id: string;
    readonly role: 'review' | 'consolidate';
    readonly iteration: number;
  };
}

export type ExpandedAgentStep = ExpandedAgentStepBase & (
  | { readonly capability: string }
  | { readonly promptFile: string }
);

export interface ExpandedGateStep extends ExpandedStepMetadata {
  readonly id: string;
  readonly type: 'gate';
  readonly artifact: string;
}

export interface ExpandedHostHandoffStep extends ExpandedStepMetadata {
  readonly id: string;
  readonly type: 'host-handoff';
  readonly promptFile: string;
  readonly inputs: readonly string[];
  readonly output: WorkflowOutput;
  readonly sideEffects: 'none';
}

export type ExpandedWorkflowStep = ExpandedAgentStep | ExpandedHostHandoffStep | ExpandedGateStep;

export interface ExpandedWorkflowPlan {
  readonly steps: readonly ExpandedWorkflowStep[];
  readonly definitions: readonly WorkflowDefinitionSnapshot[];
}

interface DefinitionNode {
  readonly resolved: ResolvedWorkflow;
  readonly instanceId: string;
  readonly namespace?: string;
  readonly children: ReadonlyMap<string, DefinitionNode>;
  readonly exposedRoles: ReadonlySet<string>;
  readonly effectiveParameters: Readonly<Record<string, WorkflowPrimitiveValue>>;
}

type MappedWorkflowStep =
  | ExpandedWorkflowStep
  | (ExpandedStepMetadata & {
      readonly id: string;
      readonly type: 'review-cycle';
      readonly actor: string;
      readonly reviewer: string;
      readonly capability: string;
      readonly reviewCapability: string;
      readonly maxIterations: number;
      readonly output: WorkflowOutput;
      readonly gateId: string;
      readonly effectiveParameters: Readonly<Record<string, WorkflowPrimitiveValue>>;
      readonly parameterDefinitions: WorkflowParameters | undefined;
    })
  | ExpandedHostHandoffStep;

@Injectable()
export class WorkflowExpanderService {
  constructor(private readonly registry: WorkflowRegistryService) {}

  expand(
    root: ResolvedWorkflow,
    repositoryDirectory: string,
    rootParameters = resolveRootParameters(root.workflow.parameters, {}),
  ): ExpandedWorkflowPlan {
    const definitions: WorkflowDefinitionSnapshot[] = [];
    const tree = this.buildTree(
      root,
      undefined,
      repositoryDirectory,
      [],
      definitions,
      rootParameters,
    );
    const mapped = this.flatten(tree, (role) => role);
    const steps = mapped.flatMap((step) => this.expandReviewCycle(step));
    this.validateExpandedPlan(steps);
    return { steps, definitions };
  }

  private buildTree(
    resolved: ResolvedWorkflow,
    namespace: string | undefined,
    repositoryDirectory: string,
    stack: readonly ResolvedWorkflow[],
    definitions: WorkflowDefinitionSnapshot[],
    effectiveParameters: Readonly<Record<string, WorkflowPrimitiveValue>>,
  ): DefinitionNode {
    if (stack.length >= MAX_COMPOSITION_DEPTH) {
      throw new WorkflowError(`Workflow composition exceeds the maximum depth of ${MAX_COMPOSITION_DEPTH}`);
    }
    const cycleAt = stack.findIndex((candidate) => candidate.path === resolved.path);
    if (cycleAt >= 0) {
      const chain = [...stack.slice(cycleAt), resolved]
        .map((candidate) => candidate.workflow.id)
        .join(' -> ');
      throw new WorkflowError(`Workflow composition cycle detected: ${chain}`);
    }

    const instanceId = namespace === undefined ? 'root' : `mount:${namespace}`;
    const previousInstance = definitions.find((definition) => definition.instanceId === instanceId);
    if (previousInstance) {
      throw new WorkflowError(
        `Workflow instance ID collision "${instanceId}" between workflows "${previousInstance.workflowId}" and "${resolved.workflow.id}"`,
      );
    }

    definitions.push({
      instanceId,
      workflowId: resolved.workflow.id,
      source: resolved.source,
      sha256: resolved.sha256,
    });

    const children = new Map<string, DefinitionNode>();
    const exposedRoles = new Set<string>();
    const nextStack = [...stack, resolved];

    for (const step of resolved.workflow.steps) {
      if (!('uses' in step)) {
        for (const role of rolesForStep(step)) exposedRoles.add(role);
        continue;
      }

      const childWorkflowId = step.uses.slice('workflow:'.length);
      const childResolved = this.registry.resolve(childWorkflowId, repositoryDirectory);
      const child = this.buildTree(
        childResolved,
        namespace === undefined ? step.id : `${namespace}--${step.id}`,
        repositoryDirectory,
        nextStack,
        definitions,
        resolveChildParameters(
          childResolved.workflow.parameters,
          effectiveParameters,
          step.with,
        ),
      );
      children.set(step.id, child);

      for (const mappedRole of Object.keys(step.actors ?? {})) {
        if (!child.exposedRoles.has(mappedRole)) {
          throw new WorkflowError(
            `Workflow instance "${child.instanceId}" does not expose actor "${mappedRole}"`,
          );
        }
      }
      for (const childRole of child.exposedRoles) {
        exposedRoles.add(step.actors?.[childRole] ?? childRole);
      }
    }

    return {
      resolved,
      instanceId,
      ...(namespace === undefined ? {} : { namespace }),
      children,
      exposedRoles,
      effectiveParameters,
    };
  }

  private flatten(
    node: DefinitionNode,
    mapRole: (role: string) => string,
  ): readonly MappedWorkflowStep[] {
    return node.resolved.workflow.steps.flatMap((step): readonly MappedWorkflowStep[] => {
      if ('uses' in step) {
        const child = node.children.get(step.id);
        if (!child) {
          throw new WorkflowError(`Workflow instance "${node.instanceId}" is missing child "${step.id}"`);
        }
        return this.flatten(
          child,
          (childRole) => mapRole(step.actors?.[childRole] ?? childRole),
        );
      }

      const namespace = (id: string): string => node.namespace === undefined
        ? id
        : `${node.namespace}--${id}`;
      const metadata: ExpandedStepMetadata = {
        definition: node.resolved,
        originStepId: namespace(step.id),
      };

      if (step.type === 'gate') {
        return [{
          ...metadata,
          id: namespace(step.id),
          type: 'gate',
          artifact: namespace(step.artifact),
        }];
      }

      if (step.type === 'review-cycle') {
        const actor = mapRole(step.actor);
        const reviewer = mapRole(step.reviewer);
        if (actor === reviewer) {
          throw new WorkflowError(
            `Workflow instance "${node.instanceId}" maps review-cycle "${step.id}" author and reviewer to actor "${actor}"`,
          );
        }
        return [{
          ...metadata,
          id: namespace(step.id),
          type: 'review-cycle',
          actor,
          reviewer,
          capability: step.capability,
          reviewCapability: step.reviewCapability,
          maxIterations: step.maxIterations,
          output: { ...step.output, id: namespace(step.output.id) },
          gateId: namespace(step.gateId),
          effectiveParameters: node.effectiveParameters,
          parameterDefinitions: node.resolved.workflow.parameters,
        }];
      }

      if (step.type === 'host-handoff') {
        return [{
          ...metadata,
          id: namespace(step.id),
          type: 'host-handoff',
          promptFile: step.promptFile,
          inputs: step.inputs.map(namespace),
          output: { ...step.output, id: namespace(step.output.id) },
          sideEffects: step.sideEffects,
        }];
      }

      const common = {
        ...metadata,
        id: namespace(step.id),
        type: 'agent' as const,
        actor: mapRole(step.actor),
        output: { ...step.output, id: namespace(step.output.id) },
        effectiveParameters: node.effectiveParameters,
        parameterDefinitions: node.resolved.workflow.parameters,
        ...(step.result ? { result: step.result } : {}),
        ...(step.when ? { when: namespaceCondition(step.when, namespace) } : {}),
        ...(step.verdictPolicy
          ? {
              verdictPolicy: {
                ...step.verdictPolicy,
                ...(step.verdictPolicy.changesRequested
                  ? {
                      changesRequested: {
                        ...step.verdictPolicy.changesRequested,
                        retryFrom: namespace(step.verdictPolicy.changesRequested.retryFrom),
                      },
                    }
                  : {}),
              },
            }
          : {}),
        ...(step.patch ? { patch: step.patch } : {}),
      };
      return ['capability' in step
        ? { ...common, capability: step.capability }
        : { ...common, promptFile: step.promptFile }];
    });
  }

  private expandReviewCycle(step: MappedWorkflowStep): readonly ExpandedWorkflowStep[] {
    if (step.type !== 'review-cycle') return [step];

    const expanded: ExpandedWorkflowStep[] = [{
      id: step.id,
      type: 'agent',
      actor: step.actor,
      capability: step.capability,
      output: step.output,
      effectiveParameters: step.effectiveParameters,
      parameterDefinitions: step.parameterDefinitions,
      definition: step.definition,
      originStepId: step.originStepId,
    }];
    for (let iteration = 1; iteration <= step.maxIterations; iteration += 1) {
      const reviewId = `${step.id}-review-${iteration}`;
      expanded.push({
        id: reviewId,
        type: 'agent',
        actor: step.reviewer,
        capability: step.reviewCapability,
        output: {
          id: reviewId,
          filename: `.review-${step.id}-${iteration}.md`,
          storage: 'internal',
        },
        effectiveParameters: step.effectiveParameters,
        parameterDefinitions: step.parameterDefinitions,
        cycle: { id: step.id, role: 'review', iteration },
        definition: step.definition,
        // A review is a distinct output producer. Author and consolidation
        // steps intentionally share the cycle origin because they rewrite the
        // same canonical artifact.
        originStepId: reviewId,
      });
      if (iteration < step.maxIterations) {
        expanded.push({
          id: `${step.id}-consolidate-${iteration}`,
          type: 'agent',
          actor: step.actor,
          capability: step.capability,
          output: step.output,
          effectiveParameters: step.effectiveParameters,
          parameterDefinitions: step.parameterDefinitions,
          cycle: { id: step.id, role: 'consolidate', iteration },
          definition: step.definition,
          originStepId: step.originStepId,
        });
      }
    }
    expanded.push({
      id: step.gateId,
      type: 'gate',
      artifact: step.output.id,
      definition: step.definition,
      originStepId: step.originStepId,
    });
    return expanded;
  }

  private validateExpandedPlan(steps: readonly ExpandedWorkflowStep[]): void {
    const stepOwners = new Map<string, string>();
    const outputOwners = new Map<string, string>();
    for (const step of steps) {
      const previousStepOwner = stepOwners.get(step.id);
      if (previousStepOwner) {
        throw new WorkflowError(
          `Expanded step ID collision "${step.id}" between "${previousStepOwner}" and "${step.originStepId}"`,
        );
      }
      stepOwners.set(step.id, step.originStepId);

      if (step.type !== 'agent' && step.type !== 'host-handoff') continue;
      const previousOutputOwner = outputOwners.get(step.output.id);
      if (previousOutputOwner && previousOutputOwner !== step.originStepId) {
        throw new WorkflowError(
          `Expanded output ID collision "${step.output.id}" between "${previousOutputOwner}" and "${step.originStepId}"`,
        );
      }
      outputOwners.set(step.output.id, step.originStepId);
    }
    steps.forEach((step, index) => {
      if (step.type !== 'agent' || !step.when) return;
      validateCondition(step.when, step, index, steps);
    });
  }
}

function namespaceCondition(condition: WorkflowCondition, namespace: (id: string) => string): WorkflowCondition {
  if ('equals' in condition) return { equals: {
    left: namespaceOperand(condition.equals.left, namespace), right: namespaceOperand(condition.equals.right, namespace),
  } };
  if ('notEquals' in condition) return { notEquals: {
    left: namespaceOperand(condition.notEquals.left, namespace), right: namespaceOperand(condition.notEquals.right, namespace),
  } };
  if ('all' in condition) return { all: condition.all.map((child) => namespaceCondition(child, namespace)) };
  if ('any' in condition) return { any: condition.any.map((child) => namespaceCondition(child, namespace)) };
  return { not: namespaceCondition(condition.not, namespace) };
}

function namespaceOperand(
  operand: WorkflowConditionOperand,
  namespace: (id: string) => string,
): WorkflowConditionOperand {
  if (typeof operand !== 'object' || operand === null || Array.isArray(operand)) return operand;
  if ('result' in operand) {
    return { result: { ...operand.result, step: namespace(operand.result.step) } };
  }
  return operand;
}

function validateCondition(
  condition: WorkflowCondition,
  target: ExpandedAgentStep,
  targetIndex: number,
  steps: readonly ExpandedWorkflowStep[],
): void {
  if ('equals' in condition || 'notEquals' in condition) {
    const comparison = 'equals' in condition ? condition.equals : condition.notEquals;
    const leftType = operandType(comparison.left, target, targetIndex, steps);
    const rightType = operandType(comparison.right, target, targetIndex, steps);
    if (leftType !== rightType) {
      throw new WorkflowError(`Condition on step "${target.id}" compares incompatible ${leftType} and ${rightType} values`);
    }
    return;
  }
  if ('all' in condition) return void condition.all.forEach((child) => validateCondition(child, target, targetIndex, steps));
  if ('any' in condition) return void condition.any.forEach((child) => validateCondition(child, target, targetIndex, steps));
  validateCondition(condition.not, target, targetIndex, steps);
}

function operandType(
  operand: WorkflowConditionOperand,
  target: ExpandedAgentStep,
  targetIndex: number,
  steps: readonly ExpandedWorkflowStep[],
): 'string' | 'boolean' | 'integer' {
  if (typeof operand === 'string') return 'string';
  if (typeof operand === 'boolean') return 'boolean';
  if (typeof operand === 'number') return 'integer';
  if ('parameter' in operand) {
    const definition = target.parameterDefinitions?.[operand.parameter];
    if (!definition) throw new WorkflowError(`Condition on step "${target.id}" references unknown parameter "${operand.parameter}"`);
    return parameterValueType(definition);
  }
  const sourceIndex = steps.findIndex((step) => step.type === 'agent' && step.id === operand.result.step);
  if (sourceIndex < 0 || sourceIndex >= targetIndex) {
    throw new WorkflowError(`Condition on step "${target.id}" must reference an earlier agent result, received "${operand.result.step}"`);
  }
  const source = steps[sourceIndex];
  if (source.type !== 'agent') throw new WorkflowError(`Condition source "${operand.result.step}" is not an agent step`);
  const definition = source.result?.fields[operand.result.field];
  if (!definition) {
    throw new WorkflowError(`Condition on step "${target.id}" references undeclared result field "${operand.result.step}.${operand.result.field}"`);
  }
  return parameterValueType(definition);
}

function rolesForStep(step: Exclude<WorkflowStep, { readonly uses: string }>): readonly string[] {
  if (step.type === 'agent') return [step.actor];
  if (step.type === 'review-cycle') return [step.actor, step.reviewer];
  return [];
}
