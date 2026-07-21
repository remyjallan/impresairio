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
  specification: `# Specification

## Scope

## Requirements

## Acceptance criteria
`,
  'integration-plan': `# Integration Plan

## Tasks

## Verification
`,
  'final-report': `# Final Report

## Delivered

## Verification
`,
};

export function isKnownDocumentationTemplate(template: string): boolean {
  return Object.hasOwn(templates, template);
}

export function resolveDocumentationTemplate(template: string): string {
  const content = isKnownDocumentationTemplate(template)
    ? templates[template]
    : undefined;
  if (!content) {
    throw new DocumentationTemplateError(template);
  }
  return content;
}
