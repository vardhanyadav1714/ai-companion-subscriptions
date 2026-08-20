export type ErrorCode =
  | "BAD_REQUEST"
  | "AUTHENTICATION_REQUIRED"
  | "NOT_FOUND"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_SERVER_ERROR";

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;
  public readonly isOperational = true;

  public constructor(message: string, code: ErrorCode, statusCode: number, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  public static badRequest(message = "Bad request", details?: unknown): AppError {
    return new AppError(message, "BAD_REQUEST", 400, details);
  }

  public static authenticationRequired(message = "Authentication required"): AppError {
    return new AppError(message, "AUTHENTICATION_REQUIRED", 401);
  }

  public static notFound(message = "Resource not found"): AppError {
    return new AppError(message, "NOT_FOUND", 404);
  }

  public static serviceUnavailable(message = "Service unavailable", details?: unknown): AppError {
    return new AppError(message, "SERVICE_UNAVAILABLE", 503, details);
  }
}

