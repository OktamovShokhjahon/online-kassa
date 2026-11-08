export type ErrorParams = Record<string, string | number>;

/** Business/HTTP error. `code` is a stable English code; the message is translated per request. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly params?: ErrorParams,
    public readonly details?: unknown,
  ) {
    super(code);
    this.name = 'AppError';
  }
}

export const badRequest = (code = 'BAD_REQUEST', details?: unknown, params?: ErrorParams) =>
  new AppError(400, code, params, details);
export const unauthorized = (code = 'UNAUTHORIZED') => new AppError(401, code);
export const forbidden = (code = 'FORBIDDEN', params?: ErrorParams) =>
  new AppError(403, code, params);
export const notFound = (code = 'NOT_FOUND') => new AppError(404, code);
export const conflict = (code = 'DUPLICATE', details?: unknown) =>
  new AppError(409, code, undefined, details);
/** 422 - a business rule was violated (e.g. insufficient stock, price missing). */
export const unprocessable = (code: string, params?: ErrorParams, details?: unknown) =>
  new AppError(422, code, params, details);
export const tooMany = (code = 'RATE_LIMITED') => new AppError(429, code);
