/** Safe error categories: never serialize upstream messages, headers or credentials. */
export class ProviderFailure extends Error {
  constructor(
    public code: string,
    public status: number,
    public retryable: boolean,
    public upstreamStatus?: number,
    public retryAfter?: number,
  ) { super(code); }
}

export function responseFailure(response: Response): ProviderFailure {
  const status = response.status;
  const value = Number(response.headers.get("retry-after"));
  const after = Number.isFinite(value) && value > 0 ? Math.min(60, Math.ceil(value)) : undefined;
  if (status === 429) return new ProviderFailure("ai_rate_limited", 429, true, status, after);
  if (status === 408 || status === 504) return new ProviderFailure("ai_provider_timeout", 504, true, status);
  if (status === 413) return new ProviderFailure("ai_input_limit", 413, false, status);
  if (status === 401 || status === 403) return new ProviderFailure("ai_provider_credentials", 502, false, status);
  if (status === 404) return new ProviderFailure("ai_provider_model", 502, false, status);
  if (status === 400 || status === 422) return new ProviderFailure("ai_request_invalid", 422, false, status);
  if (status >= 500) return new ProviderFailure("ai_provider_unavailable", 503, true, status);
  return new ProviderFailure("ai_provider_error", 502, false, status);
}

export function networkFailure(error: unknown): ProviderFailure {
  const name = error instanceof Error ? error.name : "";
  return new ProviderFailure(
    name === "TimeoutError" || name === "AbortError" ? "ai_provider_timeout" : "ai_provider_unavailable",
    name === "TimeoutError" || name === "AbortError" ? 504 : 503, true,
  );
}
