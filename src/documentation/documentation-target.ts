export interface PreparedDocumentationOutput {
  readonly id: string;
  readonly targetRoot: string;
  readonly directory: string;
  readonly path: string;
  readonly format: 'markdown';
}

export interface CompletedDocumentationOutput {
  readonly id: string;
  readonly path: string;
  readonly format: 'markdown';
  readonly sha256: string;
}

export interface DocumentationTarget {
  ensureDirectory(output: PreparedDocumentationOutput): void;
  initializeIfAbsent(output: PreparedDocumentationOutput, content: string): void;
  writeVerifiedMarkdown(output: PreparedDocumentationOutput, content: string): void;
  removeVerifiedMarkdown(output: PreparedDocumentationOutput): void;
  readVerifiedMarkdown(output: PreparedDocumentationOutput): string;
}
