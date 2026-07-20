export class DocumentationTemplateError extends Error {
  constructor(template: string) {
    super(`Unknown documentation template: ${template}`);
    this.name = 'DocumentationTemplateError';
  }
}

const templates: Readonly<Record<string, string>> = {
  'feature-design': `# Feature Design

## Problem

## Goals

## Non-goals

## Functional rules

## Acceptance criteria
`,
  'generic-markdown': '# Document\n',
};

export function resolveDocumentationTemplate(template: string): string {
  const content = Object.hasOwn(templates, template)
    ? templates[template]
    : undefined;
  if (!content) {
    throw new DocumentationTemplateError(template);
  }
  return content;
}
