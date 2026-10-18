export class DomainError extends Error {
  readonly status: number;
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
    public retryable = false,
  ) {
    super(message);
    this.name = "DomainError";
    this.status =
      code === "NOT_FOUND"
        ? 404
        : code === "MISSING_SCOPE"
          ? 403
          : [
                "VERSION_CONFLICT",
                "PLACE_RESERVED",
                "REVIEW_ALREADY_SAVED",
                "IDEMPOTENCY_KEY_REUSED",
              ].includes(code)
            ? 409
            : 400;
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
    };
  }
}
