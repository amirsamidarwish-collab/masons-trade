import { vi } from 'vitest';

export type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

/** Stubs global fetch and returns the mock with `mock.calls` correctly typed. */
export function stubFetch(handler: FetchHandler) {
  const mock = vi.fn(handler);
  vi.stubGlobal('fetch', mock);
  return mock;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
