/**
 * 信息源域：源管理（热榜平台/RSS 开关 + 自定义 RSS，overlay 差异存储）
 */

import { request } from "./client";
import { Settings } from "./types";

export interface SourceCatalogPlatform {
  id: string;
  name: string;
}

export interface SourceCatalogFeed {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface SourceOverlay {
  disabled_platform_ids: string[];
  disabled_feed_ids: string[];
  extra_feeds: { id: string; name: string; url: string }[];
}

export function fetchSourcesConfig(
  settings: Settings
): Promise<{ catalog: { platforms: SourceCatalogPlatform[]; feeds: SourceCatalogFeed[] }; overlay: SourceOverlay }> {
  return request(settings, "/sources-config");
}

export function saveSourcesConfig(settings: Settings, overlay: SourceOverlay): Promise<{ updated: boolean }> {
  return request(settings, "/sources-config", {
    method: "PUT",
    body: JSON.stringify(overlay),
  });
}

/** 网页监控源（overlay = App 端期望清单；catalog = state.db 实况） */
export interface WebpageSourceEntry {
  uid: string;
  name: string;
  url: string;
  enabled: boolean;
  check_interval: number;
}

export interface WebpageSourceCatalogItem {
  id: number;
  name: string;
  url: string;
  status: string;
  check_interval: number;
}

export function fetchWebpageSources(
  settings: Settings
): Promise<{ catalog: WebpageSourceCatalogItem[]; overlay: { webpage_sources: WebpageSourceEntry[] } }> {
  return request(settings, "/webpage-sources");
}

export function saveWebpageSources(
  settings: Settings,
  webpageSources: WebpageSourceEntry[]
): Promise<{ updated: boolean }> {
  return request(settings, "/webpage-sources", {
    method: "PUT",
    body: JSON.stringify({ webpage_sources: webpageSources }),
  });
}
