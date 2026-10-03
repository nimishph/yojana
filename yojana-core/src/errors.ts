/**
 * Error types. Every error carries a stable `code` so the CLI and MCP server can report it
 * without parsing messages.
 */

export class YojanaError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, options?: { hint?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'YojanaError';
    this.code = code;
    this.hint = options?.hint;
  }
}

export class InvalidArgumentError extends YojanaError {
  constructor(name: string, expected: string, got: unknown) {
    super('INVALID_ARGUMENT', `${name}: expected ${expected}, got ${JSON.stringify(got)}`);
    this.name = 'InvalidArgumentError';
  }
}
