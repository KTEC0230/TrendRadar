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

/** 历史报告索引（cloud_sync 导出，Worker 透传） */
export interface ReportInfo {
  name: string;
  date: string;
  time: string;
  size: number;
}

export function fetchReports(settings: Settings): Promise<{ reports: ReportInfo[] }> {
  return request(settings, "/reports");
}
