/**
 * 设置存储（AsyncStorage）
 *
 * baseUrl / authToken / deviceName / projectId —— App 的四个本地配置。
 * projectId 是 EAS 项目 ID（npx eas init 后获得），ExpoPushToken 获取必需。
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Settings } from "./api";

const KEY = "jingliu_settings_v1";

const DEFAULTS: Settings = {
  baseUrl: "",
  authToken: "",
  deviceName: "我的安卓手机",
  projectId: "",
};

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(settings));
}
