/**
 * 本地通知 + 轮询核心（国内网络方案）
 *
 * 背景：FCM/Expo push 依赖 Google 服务器（firebaseinstallations / mtalk.google.com），
 * 大陆网络不可达，getToken 必然失败。本模块改用"后台轮询 + 本地通知"：
 * - WorkManager 后台任务周期性拉取 /api/contracts/recent
 * - 有新契约（fingerprint 未见过）→ 弹本地通知（Android NotificationManager，无 Google 依赖）
 * - 首次运行只建基线不通知（避免存量爆发，与后端网页监控同语义）
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { Contract, Settings, fetchRecentContracts } from "./api";

const SEEN_KEY = "jingliu_seen_fingerprints_v1";
const LAST_PULL_KEY = "jingliu_last_pull_at_v1";
const MAX_SEEN = 200;
const MAX_NOTIFY_PER_PULL = 5;

// 前台运行时也展示通知横幅
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** 请求通知权限并创建渠道（幂等，可重复调用） */
export async function ensureNotificationReady(): Promise<void> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.status !== "granted") {
    const requested = await Notifications.requestPermissionsAsync();
    if (requested.status !== "granted") {
      throw new Error("通知权限被拒绝，请在系统设置中开启");
    }
  }
  if (Platform.OS === "android") {
    // 只保留 name/importance：vibrationPattern/lightColor 在原生桥接触发 NPE
    await Notifications.setNotificationChannelAsync("jingliu", {
      name: "静流推送",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
}

async function loadSeen(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(SEEN_KEY);
    return new Set<string>(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set<string>();
  }
}

async function saveSeen(seen: Set<string>): Promise<void> {
  const trimmed = Array.from(seen).slice(-MAX_SEEN);
  await AsyncStorage.setItem(SEEN_KEY, JSON.stringify(trimmed));
}

async function isFirstPull(): Promise<boolean> {
  return (await AsyncStorage.getItem(LAST_PULL_KEY)) === null;
}

async function markPullDone(): Promise<void> {
  await AsyncStorage.setItem(LAST_PULL_KEY, new Date().toISOString());
}

function contractToNotification(contract: Contract): {
  title: string;
  body: string;
  url: string;
} {
  const attribution = contract.source_attribution ?? ({} as Contract["source_attribution"]);
  return {
    title: `${contract.payload?.title ?? "静流"} · ${attribution.platform_name ?? ""}`.trim(),
    body: contract.hit_reason?.text ?? "",
    url: attribution.url ?? "",
  };
}

/**
 * 拉取推送流并对比已见指纹，弹本地通知。
 *
 * Returns:
 *   本次新发现的契约数（0 = 无新内容 / 无权限 / 首次建基线）
 */
export async function checkForNewContracts(settings: Settings): Promise<number> {
  const permission = await Notifications.getPermissionsAsync();
  if (permission.status !== "granted") return 0;

  const { contracts } = await fetchRecentContracts(settings, 20);
  const seen = await loadSeen();
  const fresh = contracts.filter((c) => !seen.has(c.content_fingerprint));

  if (await isFirstPull()) {
    // 首次运行：只建基线，不通知
    for (const c of contracts) seen.add(c.content_fingerprint);
    await saveSeen(seen);
    await markPullDone();
    return 0;
  }

  let notified = 0;
  for (const contract of fresh) {
    seen.add(contract.content_fingerprint);
    if (notified >= MAX_NOTIFY_PER_PULL) continue;
    const item = contractToNotification(contract);
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: item.title || "静流",
          body: item.body,
          data: { url: item.url },
        },
        trigger: null,
      });
      notified += 1;
    } catch (e) {
      console.warn("本地通知发送失败:", (e as Error).message);
    }
  }

  await saveSeen(seen);
  await markPullDone();
  return fresh.length;
}
