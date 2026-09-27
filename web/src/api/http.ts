import type { ApiResponse } from '@ai-measurement/shared';

/** 서버가 돌려준 오류. code로 분기하고 message를 화면에 보여준다 */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function parseEnvelope<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: ApiResponse<T>;
  try {
    body = JSON.parse(text) as ApiResponse<T>;
  } catch {
    throw new ApiError(response.status, 'invalid_response', `서버 응답을 읽을 수 없습니다(HTTP ${response.status})`);
  }
  if (!body.ok) throw new ApiError(response.status, body.error.code, body.error.message, body.error.details);
  return body.data;
}

export async function apiRequest<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'network_error', '서버에 연결하지 못했습니다. 네트워크를 확인하십시오');
  }
  return parseEnvelope<T>(response);
}

export async function apiUpload<T>(path: string, file: Blob, contentType: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': contentType }, body: file });
  } catch {
    throw new ApiError(0, 'network_error', '서버에 연결하지 못했습니다. 네트워크를 확인하십시오');
  }
  return parseEnvelope<T>(response);
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
