export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
export const unauthorized = (message = "Unauthorized") => new HttpError(401, message);
export const notFound = (message = "Not found") => new HttpError(404, message);
export const serviceUnavailable = (message: string, details?: unknown) =>
  new HttpError(503, message, details);
