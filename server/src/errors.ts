/** Structured tool failure: code, message, hint, context. */
export class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
    public hint?: string,
    public context?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const fail = (code: string, message: string, hint?: string, context?: Record<string, unknown>): never => {
  throw new ToolError(code, message, hint, context);
};
