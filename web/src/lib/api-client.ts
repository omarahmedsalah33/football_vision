/** Error returned by our API, with the server's user-safe message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function apiRequest<T>(method: "POST" | "PATCH" | "DELETE" | "GET", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? "unknown", data?.error?.message ?? "Request failed.");
  }
  return data as T;
}

export const apiPost = <T>(path: string, body?: unknown, signal?: AbortSignal) => apiRequest<T>("POST", path, body, signal);
