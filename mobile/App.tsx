/**
 * 静流 App 入口：设置/推送流两屏切换 + 设置持久化
 */

import React, { useCallback, useEffect, useState } from "react";
import { SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { StatusBar } from "expo-status-bar";

import { Settings } from "./src/api";
import { loadSettings, saveSettings } from "./src/settings";
import { FeedScreen } from "./src/screens/FeedScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";

type Tab = "feed" | "settings";

export default function App() {
  const [settings, setSettings] = useState<Settings>({
    baseUrl: "",
    authToken: "",
    deviceName: "我的安卓手机",
    projectId: "",
  });
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("feed");
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    loadSettings().then((loaded) => {
      setSettings(loaded);
      setReady(true);
    });
  }, []);

  const handleSettingsChange = useCallback(async (next: Settings) => {
    setSettings(next);
    await saveSettings(next);
  }, []);

  const handleRegistered = useCallback(() => {
    setRefreshToken((n) => n + 1);
    setTab("feed");
  }, []);

  if (!ready) {
    return <View style={styles.container} />;
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Text style={styles.title}>静流</Text>
        <Text style={styles.subtitle}>推送即契约 · 每条推送都告诉你为什么</Text>
      </View>

      <View style={styles.body}>
        {tab === "feed" ? (
          <FeedScreen settings={settings} refreshToken={refreshToken} />
        ) : (
          <SettingsScreen settings={settings} onChange={handleSettingsChange} onRegistered={handleRegistered} />
        )}
      </View>

      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tabItem, tab === "feed" && styles.tabActive]}
          onPress={() => setTab("feed")}
        >
          <Text style={[styles.tabText, tab === "feed" && styles.tabTextActive]}>推送流</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabItem, tab === "settings" && styles.tabActive]}
          onPress={() => setTab("settings")}
        >
          <Text style={[styles.tabText, tab === "settings" && styles.tabTextActive]}>设置</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F5F6F8" },
  header: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6, backgroundColor: "#F5F6F8" },
  title: { fontSize: 22, fontWeight: "700", color: "#111" },
  subtitle: { fontSize: 12, color: "#999", marginTop: 2 },
  body: { flex: 1 },
  tabBar: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: "#E5E5E5",
    backgroundColor: "#fff",
  },
  tabItem: { flex: 1, alignItems: "center", paddingVertical: 14 },
  tabActive: { borderTopColor: "#2B6CB0" },
  tabText: { fontSize: 14, color: "#888" },
  tabTextActive: { color: "#2B6CB0", fontWeight: "600" },
});
