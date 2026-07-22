import type {
  WorkflowParameterDefinition,
  WorkflowParameters,
  WorkflowPrimitiveValue,
} from './workflow.schema';

export class WorkflowParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowParameterError';
  }
}

function containsForbiddenLiteralCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f) return true;
    if (code === 0x7f) return true;
    if (code === 0x2028) return true;
    if (code === 0x2029) return true;
  }
  return false;
}

export function parseParameterAssignments(assignments: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf('=');
    if (separator <= 0) {
      throw new WorkflowParameterError(`--param expects <name>=<value>, received "${assignment}"`);
    }
    const name = assignment.slice(0, separator);
    const value = assignment.slice(separator + 1);
    if (values[name] !== undefined) {
      throw new WorkflowParameterError(`Parameter "${name}" was supplied more than once`);
    }
    values[name] = value;
  }
  return values;
}

export function resolveRootParameters(
  definitions: WorkflowParameters | undefined,
  rawValues: Readonly<Record<string, string>>,
): Record<string, WorkflowPrimitiveValue> {
  const parameters = definitions ?? {};
  for (const name of Object.keys(rawValues)) {
    if (!parameters[name]) {
      throw new WorkflowParameterError(`Workflow does not declare parameter "${name}"`);
    }
  }
  const resolved: Record<string, WorkflowPrimitiveValue> = {};
  for (const [name, definition] of Object.entries(parameters)) {
    if (rawValues[name] !== undefined) {
      resolved[name] = parseCliValue(name, rawValues[name], definition);
      continue;
    }
    if (definition.default !== undefined) {
      resolved[name] = definition.default;
      continue;
    }
    throw new WorkflowParameterError(`Workflow requires --param ${name}=<value>`);
  }
  return resolved;
}

export function resolveChildParameters(
  childDefinitions: WorkflowParameters | undefined,
  parentValues: Readonly<Record<string, WorkflowPrimitiveValue>>,
  bindings: Readonly<Record<string, WorkflowPrimitiveValue | { readonly fromParameter: string }>> | undefined,
): Record<string, WorkflowPrimitiveValue> {
  const definitions = childDefinitions ?? {};
  for (const name of Object.keys(bindings ?? {})) {
    if (!definitions[name]) {
      throw new WorkflowParameterError(`Child workflow does not declare parameter "${name}"`);
    }
  }
  const resolved: Record<string, WorkflowPrimitiveValue> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const binding = bindings?.[name];
    if (binding !== undefined) {
      const value = isFromParameter(binding)
        ? parentValues[binding.fromParameter]
        : binding;
      if (value === undefined) {
        const source = isFromParameter(binding) ? `parent parameter "${binding.fromParameter}"` : `parameter "${name}"`;
        throw new WorkflowParameterError(`Cannot resolve ${source} for child parameter "${name}"`);
      }
      resolved[name] = validateParameterValue(name, value, definition);
      continue;
    }
    if (definition.default !== undefined) {
      resolved[name] = definition.default;
      continue;
    }
    throw new WorkflowParameterError(`Child workflow requires parameter "${name}" through its uses.with mapping`);
  }
  return resolved;
}

export function validateParameterValue(
  name: string,
  value: unknown,
  definition: WorkflowParameterDefinition,
): WorkflowPrimitiveValue {
  switch (definition.type) {
    case 'string': {
      if (typeof value !== 'string') {
        throw new WorkflowParameterError(`Parameter "${name}" must be a single-line literal string`);
      }
      if (value.includes('{{') || value.includes('}}')) {
        throw new WorkflowParameterError(`Parameter "${name}" must be a single-line literal string`);
      }
      if (containsForbiddenLiteralCharacter(value)) {
        throw new WorkflowParameterError(`Parameter "${name}" must be a single-line literal string`);
      }
      if (definition.minLength !== undefined && value.length < definition.minLength) {
        throw new WorkflowParameterError(`Parameter "${name}" must contain at least ${definition.minLength} characters`);
      }
      if (definition.maxLength !== undefined && value.length > definition.maxLength) {
        throw new WorkflowParameterError(`Parameter "${name}" must contain at most ${definition.maxLength} characters`);
      }
      return value;
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw new WorkflowParameterError(`Parameter "${name}" must be boolean`);
      return value;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new WorkflowParameterError(`Parameter "${name}" must be an integer`);
      }
      if (definition.minimum !== undefined && value < definition.minimum) {
        throw new WorkflowParameterError(`Parameter "${name}" must be at least ${definition.minimum}`);
      }
      if (definition.maximum !== undefined && value > definition.maximum) {
        throw new WorkflowParameterError(`Parameter "${name}" must be at most ${definition.maximum}`);
      }
      return value;
    case 'enum':
      if (typeof value !== 'string' || !definition.values.includes(value)) {
        throw new WorkflowParameterError(`Parameter "${name}" must be one of: ${definition.values.join(', ')}`);
      }
      return value;
  }
}

export function parameterValueType(definition: WorkflowParameterDefinition): 'string' | 'boolean' | 'integer' {
  return definition.type === 'enum' ? 'string' : definition.type;
}

function parseCliValue(
  name: string,
  rawValue: string,
  definition: WorkflowParameterDefinition,
): WorkflowPrimitiveValue {
  switch (definition.type) {
    case 'string': return validateParameterValue(name, rawValue, definition);
    case 'boolean':
      if (rawValue !== 'true' && rawValue !== 'false') {
        throw new WorkflowParameterError(`Parameter "${name}" must be exactly true or false`);
      }
      return validateParameterValue(name, rawValue === 'true', definition);
    case 'integer':
      if (!/^-?(?:0|[1-9][0-9]*)$/.test(rawValue)) {
        throw new WorkflowParameterError(`Parameter "${name}" must be a base-10 integer`);
      }
      return validateParameterValue(name, Number(rawValue), definition);
    case 'enum': return validateParameterValue(name, rawValue, definition);
  }
}

function isFromParameter(
  value: WorkflowPrimitiveValue | { readonly fromParameter: string },
): value is { readonly fromParameter: string } {
  return typeof value === 'object' && value !== null && 'fromParameter' in value;
}
