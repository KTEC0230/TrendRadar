/**
 * 后台轮询任务（WorkManager，国内网络可用）
 *
 * 系统 WorkManager 最低间隔 15 分钟，Doze 模式下可能更久；
 * App 前台时由 App.tsx 另行实时拉取，本任务只负责后台兜底。
 */

import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { loadSettings } from "./settings";
import { checkForNewContracts } from "./notifications";

export const BACKGROUND_POLL_TASK = "jingliu-background-poll";

if (!TaskManager.isTaskDefined(BACKGROUND_POLL_TASK)) {
  TaskManager.defineTask(BACKGROUND_POLL_TASK, async () => {
    try {
      const settings = await loadSettings();
      if (!settings.baseUrl || !settings.authToken) {
        return BackgroundTask.BackgroundTaskResult.Success;
      }
      await checkForNewContracts(settings);
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch (e) {
      console.warn("后台轮询失败:", (e as Error).message);
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

/** 开启后台轮询（幂等）。前置：通知权限已授予。 */
export async function enableBackgroundPolling(): Promise<void> {
  await BackgroundTask.registerTaskAsync(BACKGROUND_POLL_TASK, {
    minimumInterval: 15, // 分钟（WorkManager 系统下限）
  });
}

export async function pollingEnabled(): Promise<boolean> {
  try {
    return await TaskManager.isTaskRegisteredAsync(BACKGROUND_POLL_TASK);
  } catch {
    return false;
  }
}
