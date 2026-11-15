/**
 * 后台保活跳转（厂商省电策略）
 *
 * OPPO/vivo 等深度定制系统默认冻结后台 App，WorkManager 轮询会被拦。
 * 这里封装两类跳转：
 *  1. 电池优化白名单——系统级弹窗，所有品牌通用（需 manifest 声明
 *     REQUEST_IGNORE_BATTERY_OPTIMIZATIONS 权限，见 app.json）
 *  2. 自启动管理页——按厂商尝试已知组件名，逐个兜底，最终落到应用详情页
 *
 * 无法从 JS 查询"是否已在白名单"（需原生模块），所以所有入口都是幂等的
 * 手动操作，用户重复点也无副作用。
 */

import * as IntentLauncher from "expo-intent-launcher";
import * as Device from "expo-device";
import { Linking, Platform } from "react-native";

const PACKAGE = "com.jingliu.app";

/** 厂商 → 自启动管理页候选组件（按命中概率排序） */
const AUTOSTART_CANDIDATES: Record<string, { pkg: string; act: string }[]> = {
  oppo: [
    { pkg: "com.coloros.safecenter", act: "com.coloros.safecenter.permission.startup.StartupAppListActivity" },
    { pkg: "com.coloros.safecenter", act: "com.coloros.safecenter.startup.StartupAppListActivity" },
    { pkg: "com.oppo.safe", act: "com.oppo.safe.permission.startup.StartupAppListActivity" },
    { pkg: "com.oplus.battery", act: "com.oplus.battery.startup.StartupAppListActivity" },
  ],
  vivo: [
    { pkg: "com.vivo.permissionmanager", act: "com.vivo.permissionmanager.activity.BgStartUpManagerActivity" },
    { pkg: "com.vivo.permissionmanager", act: "com.vivo.permissionmanager.activity.PurviewTabActivity" },
  ],
  huawei: [
    { pkg: "com.huawei.systemmanager", act: "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity" },
    { pkg: "com.huawei.systemmanager", act: "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity" },
  ],
  xiaomi: [
    { pkg: "com.miui.securitycenter", act: "com.miui.permcenter.autostart.AutoStartManagementActivity" },
  ],
};

/** 厂商名 → 候选分组键（expo-device 的 manufacturer 取 Build.MANUFACTURER） */
function vendorKey(): string {
  const m = (Device.manufacturer ?? "").toLowerCase();
  if (m.includes("oppo") || m.includes("oplus") || m.includes("realme") || m.includes("oneplus")) return "oppo";
  if (m.includes("vivo") || m.includes("iqoo")) return "vivo";
  if (m.includes("huawei") || m.includes("honor") || m.includes("hnic")) return "huawei";
  if (m.includes("xiaomi") || m.includes("redmi")) return "xiaomi";
  return "";
}

async function tryComponent(pkg: string, act: string): Promise<boolean> {
  try {
    // 显式组件启动：页面不存在/未导出时抛错 → 走下一个候选
    await IntentLauncher.startActivityAsync("android.intent.action.MAIN", {
      packageName: pkg,
      className: act,
    });
    return true;
  } catch {
    return false;
  }
}

async function openAppDetails(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await IntentLauncher.startActivityAsync("android.settings.APPLICATION_DETAILS_SETTINGS", {
      data: `package:${PACKAGE}`,
    });
  } catch {
    try {
      await Linking.openSettings();
    } catch {
      // 最终兜底失败只能提示用户手动去系统设置
    }
  }
}

/**
 * 请求加入电池优化白名单：直接弹系统确认对话框（最短路径）。
 * 对话框被厂商裁剪时退化为省电优化列表页，再退化为应用详情页。
 */
export async function openBatteryWhitelist(): Promise<string> {
  if (Platform.OS !== "android") return "此功能仅安卓可用";
  try {
    await IntentLauncher.startActivityAsync("android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS", {
      data: `package:${PACKAGE}`,
    });
    return "请在弹窗里选择「允许」";
  } catch {
    try {
      await IntentLauncher.startActivityAsync("android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS");
      return "请在列表里找到「静流」设为不优化";
    } catch {
      await openAppDetails();
      return "已打开应用详情页，请进入「电池」允许后台运行";
    }
  }
}

/**
 * 打开自启动管理页：优先当前厂商的候选组件，逐个尝试；
 * 全部失败落到应用详情页（ColorOS/OriginOS 的应用详情里也有自启动与耗电入口）。
 */
export async function openAutostartSettings(): Promise<string> {
  if (Platform.OS !== "android") return "此功能仅安卓可用";

  const key = vendorKey();
  const ordered = [
    ...(key ? (AUTOSTART_CANDIDATES[key] ?? []) : []),
    ...Object.entries(AUTOSTART_CANDIDATES)
      .filter(([k]) => k !== key)
      .flatMap(([, v]) => v),
  ];

  for (const { pkg, act } of ordered) {
    if (await tryComponent(pkg, act)) {
      return "请把「静流」的自启动开关打开";
    }
  }
  await openAppDetails();
  return "已打开应用详情页，请找到「自启动 / 耗电管理」";
}
