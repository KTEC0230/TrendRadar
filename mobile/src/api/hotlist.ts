/**
 * 热榜域：今日热榜快照（cloud_sync 导出，Worker 透传）
 */

import { request } from "./client";
import { Settings } from "./types";

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
