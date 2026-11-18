/**
 * 契约域：推送流查询 / 反馈
 */

import { request } from "./client";
import { Confidence, Contract, Settings } from "./types";

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

export type { Confidence, Contract };
