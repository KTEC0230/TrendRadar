/**
 * 兴趣域：兴趣文件读取/编辑
 */

import { request } from "./client";
import { Settings } from "./types";

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
