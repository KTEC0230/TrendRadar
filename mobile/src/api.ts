/**
 * 静流后端 API 客户端
 *
 * 对应 trendradar/jingliu/api_server.py 的端点。
 * baseUrl / authToken 来自设置存储（AsyncStorage）。
 */

export type Confidence = "high" | "medium" | "low";

export interface HitReason {
  kind: "keyword" | "ai" | "webpage_change" | "digest";
  text: string;
  detail: Record<string, unknown>;
}

export interface SourceAttribution {
  platform: string;
  platform_name: string;
  url: string;
  source_type: string;
}

export interface Contract {
  id: number;
  content_fingerprint: string;
  interest_id: string;
  hit_reason: HitReason;
  confidence: Confidence;
  source_attribution: SourceAttribution;
  payload: { title?: string; body?: string };
  pushed_at: string | null;
  channel: string;
  user_feedback: string;
  created_at: string;
}

export interface Settings {
  baseUrl: string;
  authToken: string;
  deviceName: string;
  projectId: string;
}

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

async function request<T>(
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

export function registerDevice(
  settings: Settings,
  channel: "expo",
  deviceToken: string
): Promise<{ id: number }> {
  return request(settings, "/devices", {
    method: "POST",
    body: JSON.stringify({
      channel,
      device_token: deviceToken,
      device_name: settings.deviceName,
    }),
  });
}

export function fetchRecentContracts(settings: Settings, limit = 50): Promise<{ contracts: Contract[] }> {
  return request(settings, `/contracts/recent?limit=${limit}`);
}

export function fetchPendingContracts(settings: Settings, limit = 50): Promise<{ contracts: Contract[] }> {
  return request(settings, `/contracts/pending?min_confidence=low&limit=${limit}`);
}

export function sendFeedback(
  settings: Settings,
  contractId: number,
  feedback: "useful" | "useless"
): Promise<{ updated: boolean }> {
  return request(settings, `/contracts/${contractId}/feedback`, {
    method: "POST",
    body: JSON.stringify({ feedback }),
  });
}

/** 今日热榜条目（cloud_sync 导出，Worker 透传） */
export interface HotlistItem {
  rank: number;
  title: string;
  url: string;
  mobile_url: string;
  trend: "up" | "down" | "flat" | "new";
  delta: number;
}

export interface HotlistPlatform {
  id: string;
  name: string;
  items: HotlistItem[];
}

export function fetchHotlist(settings: Settings): Promise<{ date: string; platforms: HotlistPlatform[] }> {
  return request(settings, "/hotlist");
}

/** 兴趣文件条目（后端 GET /api/interests 返回结构） */
export interface InterestFile {
  path: string;
  exists: boolean;
  content: string;
}

export type InterestTarget = "ai_interests" | "frequency_words";

export function fetchInterests(settings: Settings): Promise<Record<InterestTarget, InterestFile>> {
  return request(settings, "/interests");
}

export function saveInterests(
  settings: Settings,
  target: InterestTarget,
  content: string
): Promise<{ updated: boolean; target: InterestTarget; path: string }> {
  return request(settings, "/interests", {
    method: "PUT",
    body: JSON.stringify({ target, content }),
  });
}
