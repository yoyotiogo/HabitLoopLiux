export class BusinessError extends Error {
  constructor(public code: string, message: string, public details: Record<string, any> = {}, public retryable = false) { super(message); }
}
