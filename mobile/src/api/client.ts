/**
 * HTTP 客户端：统一请求封装（超时/Bearer 鉴权/错误归一化）
 */

import { Settings } from "./types";

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

export async function request<T>(
  settings: Settings,
  path: string,
  init: RequestInit = {},
  timeoutMs = 10000
): Promise<T> {
  const base = normalizeBaseUrl(settings.baseUrl);
  if (!base) throw new ApiError("请先在设置中填写后端地址");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.authToken}`,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new ApiError(data.error ?? `HTTP ${response.status}`, response.status);
    }
    return data as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if ((e as Error).name === "AbortError") throw new ApiError("请求超时");
    throw new ApiError(`网络错误: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

export function checkHealth(settings: Settings): Promise<{ status: string; backend: string }> {
  // health 免鉴权，便于在未配置 token 时先测连通性
  const base = normalizeBaseUrl(settings.baseUrl);
  if (!base) throw new ApiError("请先在设置中填写后端地址");
  return request(settings, "/health", {}, 5000);
}
