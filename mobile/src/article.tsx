/**
 * App 内文章页：全屏原生界面（顶栏返回 + 进度条 + WebView），替代浏览器跳转。
 *
 * 用法：App.tsx 持有 article 状态并包裹 <ArticleContext.Provider value={openArticle}>，
 * 任意屏幕 useContext(ArticleContext) 调 openArticle(url, title) 跳入；返回键/左上角关闭。
 */

import React, { createContext, useContext, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors } from "./theme";
import { openInBrowser } from "./browser";

export interface ArticleTarget {
  url: string;
  title: string;
}

export const ArticleContext = createContext<(url: string, title?: string) => void>(() => {});

export function useOpenArticle() {
  return useContext(ArticleContext);
}

export function ArticleScreen({ target, onClose }: { target: ArticleTarget; onClose: () => void }) {
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(true);
  const insets = useSafeAreaInsets();

  // 加载中时拦截返回键 → 关闭文章页
  useEffect(() => {
    const sub = require("react-native").BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>
          {target.title}
        </Text>
        <TouchableOpacity
          onPress={() => openInBrowser(target.url)}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="open-outline" size={19} color={colors.secondary} />
        </TouchableOpacity>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
      </View>
      {loading ? (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      ) : null}
      <WebView
        source={{ uri: target.url }}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        onProgress={(e: { nativeEvent: { progress: number } }) => setProgress(e.nativeEvent.progress)}
        setSupportMultipleWindows={false}
        allowsBackForwardNavigationGestures
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  title: { flex: 1, fontSize: 15, fontWeight: "600", color: colors.text },
  progressTrack: { height: 2, backgroundColor: colors.border },
  progressFill: { height: 2, backgroundColor: colors.accent },
  loadingOverlay: {
    position: "absolute",
    top: 60,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
});
