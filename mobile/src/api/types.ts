/**
 * 共享类型（各域模块引用；保持与后端 api_server.py / cloud_sync feed.json 对齐）
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
