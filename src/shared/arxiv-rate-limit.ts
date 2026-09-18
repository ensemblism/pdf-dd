export class ArxivRateLimitError extends Error {
  constructor(readonly retryAfter: number) {
    super(`arXiv is rate limiting requests. Please try again in ${retryAfter} seconds.`);
  }
}

/** Pause only after a 429. No fixed delay and no automatic retry loop. */
export class ArxivRateLimit {
  private retryAt = 0;
  private failures = 0;
  check() {
    const remaining = Math.ceil((this.retryAt - Date.now()) / 1000);
    if (remaining > 0) throw new ArxivRateLimitError(remaining);
  }
  limited(header: string | null) {
    const parsed =
      header === null
        ? NaN
        : /^\d+(?:\.\d+)?$/.test(header.trim())
          ? Number(header)
          : (Date.parse(header) - Date.now()) / 1000;
    const seconds = Number.isFinite(parsed)
      ? Math.max(1, Math.ceil(parsed))
      : Math.min(15 * 2 ** this.failures, 120);
    this.failures = Math.min(this.failures + 1, 3);
    this.retryAt = Math.max(this.retryAt, Date.now() + seconds * 1000);
    return new ArxivRateLimitError(Math.ceil((this.retryAt - Date.now()) / 1000));
  }
  reset() {
    this.failures = 0;
    this.retryAt = 0;
  }
}
