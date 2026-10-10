// =============================================================================
// Typed AI Provider & Validation Errors
// =============================================================================

export class ProviderTimeoutError extends Error {
  constructor(message = 'The AI service timed out while processing the request') {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

export class ProviderTransientError extends Error {
  public statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'ProviderTransientError';
    this.statusCode = statusCode;
  }
}

export class ProviderPermanentError extends Error {
  public statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'ProviderPermanentError';
    this.statusCode = statusCode;
  }
}

export class ValidationError extends Error {
  public issues?: unknown[];
  constructor(message: string, issues?: unknown[]) {
    super(message);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}
