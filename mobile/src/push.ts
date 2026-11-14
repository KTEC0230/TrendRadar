/**
 * 推送注册（Expo 通道）
 *
 * 流程：请求通知权限 → 获取 ExpoPushToken → POST /api/devices（channel=expo）
 * 后端将该 token 写入 state 库 devices 表，与静态配置合并后经 Expo push
 * 服务转发 FCM（免 Google service account 凭据）。
 *
 * 前置：app.json extra.eas.projectId 必须是真实 EAS 项目 ID（npx eas init 生成）。
 */

import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { Settings, registerDevice } from "./api";

// 前台运行时也展示通知横幅
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export interface RegisterResult {
  token: string;
  alreadyRegistered: boolean;
}

function resolveProjectId(settings: Settings): string {
  // 优先取设置中手填的 projectId，缺省回退 app.json 的 extra.eas.projectId
  const fromSettings = settings.projectId.trim();
  if (fromSettings) return fromSettings;
  const fromConfig = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? "";
  if (fromConfig && !fromConfig.startsWith("REPLACE_WITH")) return fromConfig;
  return "";
}

export async function registerPush(settings: Settings): Promise<RegisterResult> {
  if (!Device.isDevice) {
    throw new Error("推送需要真机（模拟器/Expo 网页预览不支持远程推送）");
  }

  const projectId = resolveProjectId(settings);
  if (!projectId) {
    throw new Error("缺少 EAS projectId：在设置中填写，或运行 npx eas init 后自动写入 app.json");
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== "granted") {
    const requested = await Notifications.requestPermissionsAsync();
    status = requested.status;
  }
  if (status !== "granted") {
    throw new Error("通知权限被拒绝，请在系统设置中开启");
  }

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("jingliu", {
      name: "静流推送",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#4A7DFF",
    });
  }

  const tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId });
  const token = tokenResponse.data;

  await registerDevice(settings, "expo", token);
  return { token, alreadyRegistered: false };
}
