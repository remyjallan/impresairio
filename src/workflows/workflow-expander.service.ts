import { Injectable } from '@nestjs/common';
import type { WorkflowStep, WorkflowVerdictPolicy } from './workflow.schema';
import {
  type ResolvedWorkflow,
  type WorkflowSource,
  WorkflowError,
  WorkflowRegistryService,
} from './workflow-registry.service';

type WorkflowOutput = Extract<WorkflowStep, { readonly type: 'agent' }>['output'];

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
  readonly verdictPolicy?: WorkflowVerdictPolicy;
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

export type ExpandedWorkflowStep = ExpandedAgentStep | ExpandedGateStep;

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
    });

@Injectable()
export class WorkflowExpanderService {
  constructor(private readonly registry: WorkflowRegistryService) {}

  expand(
    root: ResolvedWorkflow,
    repositoryDirectory: string,
  ): ExpandedWorkflowPlan {
    const definitions: WorkflowDefinitionSnapshot[] = [];
    const tree = this.buildTree(
      root,
      undefined,
      repositoryDirectory,
      [],
      definitions,
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
  ): DefinitionNode {
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
      const child = this.buildTree(
        this.registry.resolve(childWorkflowId, repositoryDirectory),
        namespace === undefined ? step.id : `${namespace}--${step.id}`,
        repositoryDirectory,
        nextStack,
        definitions,
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

    return { resolved, instanceId, ...(namespace === undefined ? {} : { namespace }), children, exposedRoles };
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
        }];
      }

      const common = {
        ...metadata,
        id: namespace(step.id),
        type: 'agent' as const,
        actor: mapRole(step.actor),
        output: { ...step.output, id: namespace(step.output.id) },
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
        cycle: { id: step.id, role: 'review', iteration },
        definition: step.definition,
        originStepId: reviewId,
      });
      if (iteration < step.maxIterations) {
        expanded.push({
          id: `${step.id}-consolidate-${iteration}`,
          type: 'agent',
          actor: step.actor,
          capability: step.capability,
          output: step.output,
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

      if (step.type !== 'agent') continue;
      const previousOutputOwner = outputOwners.get(step.output.id);
      if (previousOutputOwner && previousOutputOwner !== step.originStepId) {
        throw new WorkflowError(
          `Expanded output ID collision "${step.output.id}" between "${previousOutputOwner}" and "${step.originStepId}"`,
        );
      }
      outputOwners.set(step.output.id, step.originStepId);
    }
  }
}

function rolesForStep(step: Exclude<WorkflowStep, { readonly uses: string }>): readonly string[] {
  if (step.type === 'agent') return [step.actor];
  if (step.type === 'review-cycle') return [step.actor, step.reviewer];
  return [];
}
