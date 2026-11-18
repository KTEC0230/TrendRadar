/**
 * 内置浏览器打开（Chrome Custom Tabs，不跳出 App）；失败兜底系统浏览器。
 */

import * as WebBrowser from "expo-web-browser";
import { Linking } from "react-native";

export async function openInBrowser(url: string): Promise<void> {
  try {
    await WebBrowser.openBrowserAsync(url, { showTitle: true, enableBarCollapsing: true });
  } catch {
    Linking.openURL(url).catch(() => {});
  }
}
