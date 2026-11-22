/**
 * 静流 App 入口：推送流/兴趣/设置三屏 + 设置持久化 + 前台实时拉取
 *
 * 安全区：SafeAreaProvider + useSafeAreaInsets（edge-to-edge 下 RN 内置
 * SafeAreaView 不生效），头部按状态栏高度留白、底部按手势条抬高。
 * 外观：Claude 现代风（米白底 + 陶土橙点缀），色值统一走 src/theme.ts。
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  BackHandler,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { ArticleContext, ArticleScreen, ArticleTarget } from "./src/article";
import { Settings } from "./src/api";
import { loadSettings, saveSettings } from "./src/settings";
import { checkForNewContracts } from "./src/notifications";
import { openAutostartSettings, openBatteryWhitelist } from "./src/keepalive";
import { colors } from "./src/theme";
import { FeedScreen } from "./src/screens/FeedScreen";
import { HotlistScreen } from "./src/screens/HotlistScreen";
import { SourcesScreen } from "./src/screens/SourcesScreen";
import { InterestsScreen } from "./src/screens/InterestsScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";

type Tab = "feed" | "hotlist" | "sources" | "interests" | "settings";

const FOREGROUND_POLL_MS = 30 * 1000;
const BATTERY_PROMPT_KEY = "jingliu_battery_prompt_v1";

const TABS: { key: Tab; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: "feed", label: "推送流", icon: "newspaper-outline" },
  { key: "hotlist", label: "热榜", icon: "flame-outline" },
  { key: "sources", label: "源", icon: "list-outline" },
  { key: "interests", label: "兴趣", icon: "sparkles-outline" },
  { key: "settings", label: "设置", icon: "settings-outline" },
];

function Shell() {
  const [settings, setSettings] = useState<Settings>({
    baseUrl: "",
    authToken: "",
    deviceName: "我的安卓手机",
    projectId: "",
  });
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("feed");
  const [refreshToken, setRefreshToken] = useState(0);
  const [batteryPrompt, setBatteryPrompt] = useState(false);
  const [article, setArticle] = useState<ArticleTarget | null>(null);
  const settingsRef = useRef(settings);
  const tabRef = useRef<Tab>("feed");
  const articleRef = useRef<ArticleTarget | null>(null);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  useEffect(() => {
    articleRef.current = article;
  }, [article]);

  const openArticle = useCallback((url: string, title?: string) => {
    setArticle({ url, title: title || "文章" });
  }, []);

  useEffect(() => {
    loadSettings().then((loaded) => {
      settingsRef.current = loaded;
      setSettings(loaded);
      setReady(true);
      AsyncStorage.getItem(BATTERY_PROMPT_KEY)
        .then((seen) => {
          if (!seen) setBatteryPrompt(true);
        })
        .catch(() => {});
    });
  }, []);

  // 前台实时拉取：回到前台立即一次 + 每 30 秒轮询（后台交给 WorkManager）
  useEffect(() => {
    if (!ready) return;

    const pull = () => {
      const current = settingsRef.current;
      if (!current.baseUrl || !current.authToken) return;
      checkForNewContracts(current)
        .then((fresh) => {
          if (fresh > 0) setRefreshToken((n) => n + 1);
        })
        .catch(() => {});
    };

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") pull();
    });
    pull();
    const timer = setInterval(pull, FOREGROUND_POLL_MS);

    // 安卓返回键：文章页先关文章 → 非推送流 Tab 回推送流 → 推送流再按才退出
    const backSubscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (articleRef.current) {
        setArticle(null);
        return true;
      }
      if (tabRef.current !== "feed") {
        setTab("feed");
        return true;
      }
      return false;
    });

    return () => {
      subscription.remove();
      backSubscription.remove();
      clearInterval(timer);
    };
  }, [ready]);

  const handleSettingsChange = useCallback(async (next: Settings) => {
    settingsRef.current = next;
    setSettings(next);
    await saveSettings(next);
  }, []);

  const handleRefresh = useCallback(() => {
    setRefreshToken((n) => n + 1);
    setTab("feed");
  }, []);

  const dismissBatteryPrompt = useCallback(() => {
    setBatteryPrompt(false);
    AsyncStorage.setItem(BATTERY_PROMPT_KEY, "done").catch(() => {});
  }, []);

  if (!ready) {
    return <View style={styles.container} />;
  }

  return (
    <View style={styles.container}>
      <StatusBar style="dark" />

      {/* 头部：insets.top 保证不被状态栏遮挡 */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.title}>静流</Text>
        <Text style={styles.subtitle}>推送即契约 · 每条推送都告诉你为什么</Text>
      </View>

      <View style={styles.body}>
        <ArticleContext.Provider value={openArticle}>
          {tab === "feed" ? (
            <FeedScreen settings={settings} refreshToken={refreshToken} />
          ) : tab === "hotlist" ? (
            <HotlistScreen settings={settings} />
          ) : tab === "sources" ? (
            <SourcesScreen settings={settings} />
          ) : tab === "interests" ? (
            <InterestsScreen settings={settings} />
          ) : (
            <SettingsScreen settings={settings} onChange={handleSettingsChange} onRefresh={handleRefresh} />
          )}
        </ArticleContext.Provider>
      </View>

      {/* 底部 Tab：insets.bottom 保证不被手势条/返回键区域遮挡 */}
      <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {TABS.map((item) => {
          const active = tab === item.key;
          return (
            <Pressable key={item.key} style={styles.tabItem} onPress={() => setTab(item.key)}>
              <Ionicons name={item.icon} size={21} color={active ? colors.accent : colors.faint} />
              <Text style={[styles.tabText, active && styles.tabTextActive]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* 首启弹窗：厂商省电策略提醒（只弹一次，设置页可随时再进） */}
      <Modal visible={batteryPrompt} transparent animationType="fade" onRequestClose={dismissBatteryPrompt}>
        <View style={styles.modalMask}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>让静流在后台也能提醒你</Text>
            <Text style={styles.modalBody}>
              OPPO/vivo 等手机默认会冻结后台应用，导致推送延迟甚至收不到。建议给静流开启：
            </Text>
            <Text style={styles.modalList}>① 自启动权限{"\n"}② 电池优化白名单（允许后台运行）</Text>
            <View style={styles.modalButtons}>
              <Pressable style={styles.modalGhostBtn} onPress={dismissBatteryPrompt}>
                <Text style={styles.modalGhostText}>暂不</Text>
              </Pressable>
              <Pressable
                style={styles.modalPrimaryBtn}
                onPress={async () => {
                  dismissBatteryPrompt();
                  await openBatteryWhitelist();
                }}
              >
                <Text style={styles.modalPrimaryText}>去开启</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* App 内文章页：全屏覆盖（含 Tab 栏），返回键/左上角关闭 */}
      {article ? (
        <ArticleScreen target={article} onClose={() => setArticle(null)} />
      ) : null}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 10,
    backgroundColor: colors.bg,
  },
  title: { fontSize: 24, fontWeight: "700", color: colors.text, letterSpacing: 0.3 },
  subtitle: { fontSize: 12, color: colors.secondary, marginTop: 3 },
  body: { flex: 1 },
  tabBar: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingTop: 8,
  },
  tabItem: { flex: 1, alignItems: "center", gap: 2 },
  tabText: { fontSize: 11, color: colors.faint },
  tabTextActive: { color: colors.accent, fontWeight: "600" },
  modalMask: { flex: 1, backgroundColor: "rgba(31,30,29,0.45)", justifyContent: "center", paddingHorizontal: 28 },
  modalCard: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    padding: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  modalTitle: { fontSize: 18, fontWeight: "700", color: colors.text },
  modalBody: { fontSize: 14, lineHeight: 21, color: colors.secondary, marginTop: 10 },
  modalList: { fontSize: 14, lineHeight: 22, color: colors.text, marginTop: 6, fontWeight: "500" },
  modalButtons: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 20 },
  modalGhostBtn: { borderRadius: 12, paddingVertical: 10, paddingHorizontal: 18 },
  modalGhostText: { color: colors.secondary, fontSize: 15 },
  modalPrimaryBtn: {
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 20,
    backgroundColor: colors.accent,
  },
  modalPrimaryText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
