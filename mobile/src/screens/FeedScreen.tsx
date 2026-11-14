/**
 * 推送流屏幕：已推送契约列表 + 有用/无用反馈
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { Confidence, Contract, Settings, fetchRecentContracts as fetchRecent, sendFeedback } from "../api";

const CONFIDENCE_COLORS: Record<Confidence, string> = {
  high: "#1B8A3A",
  medium: "#B8860B",
  low: "#8A8A8A",
};

const CONFIDENCE_LABELS: Record<Confidence, string> = {
  high: "高置信",
  medium: "中置信",
  low: "低置信",
};

interface FeedScreenProps {
  settings: Settings;
  refreshToken: number;
}

export function FeedScreen({ settings, refreshToken }: FeedScreenProps) {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [feedbackBusy, setFeedbackBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchRecent(settings);
      setContracts(data.contracts);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.baseUrl, settings.authToken, refreshToken]);

  useEffect(() => {
    load();
  }, [load]);

  const onFeedback = useCallback(
    async (contract: Contract, feedback: "useful" | "useless") => {
      setFeedbackBusy(contract.id);
      try {
        await sendFeedback(settings, contract.id, feedback);
        setContracts((prev) =>
          prev.map((c) => (c.id === contract.id ? { ...c, user_feedback: feedback } : c))
        );
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setFeedbackBusy(null);
      }
    },
    [settings]
  );

  const renderItem = ({ item }: { item: Contract }) => {
    const reason = item.hit_reason?.text ?? "";
    const attribution = item.source_attribution ?? {};
    const hasUrl = Boolean(attribution.url);
    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.platform}>{attribution.platform_name || attribution.source_type || "未知来源"}</Text>
          <View style={[styles.badge, { backgroundColor: CONFIDENCE_COLORS[item.confidence] ?? "#8A8A8A" }]}>
            <Text style={styles.badgeText}>{CONFIDENCE_LABELS[item.confidence] ?? item.confidence}</Text>
          </View>
        </View>
        <Text style={styles.reason}>{reason}</Text>
        <Text style={styles.meta}>
          {item.pushed_at ? item.pushed_at.replace("T", " ").slice(0, 16) : ""} · 兴趣「{item.interest_id}」
        </Text>
        {hasUrl && (
          <Text style={styles.link} onPress={() => Linking.openURL(attribution.url)}>
            打开原文链接 ↗
          </Text>
        )}
        <View style={styles.feedbackRow}>
          <TouchableOpacity
            style={[styles.feedbackBtn, item.user_feedback === "useful" && styles.feedbackActive]}
            disabled={feedbackBusy === item.id}
            onPress={() => onFeedback(item, "useful")}
          >
            <Text style={styles.feedbackText}>👍 有用</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.feedbackBtn, item.user_feedback === "useless" && styles.feedbackActive]}
            disabled={feedbackBusy === item.id}
            onPress={() => onFeedback(item, "useless")}
          >
            <Text style={styles.feedbackText}>👎 无用</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  if (loading && contracts.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.list}
      data={contracts}
      keyExtractor={(item) => String(item.id)}
      renderItem={renderItem}
      ListEmptyComponent={
        <Text style={styles.empty}>{error || "还没有推送记录——先让后端跑一轮吧"}</Text>
      }
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
    />
  );
}

// fetchRecent 为 fetchRecentContracts 的局部别名（见顶部 import）

const styles = StyleSheet.create({
  list: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    marginHorizontal: 12,
    marginTop: 10,
    padding: 14,
    elevation: 2,
  },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  platform: { fontSize: 13, color: "#666", fontWeight: "600" },
  badge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { color: "#fff", fontSize: 11 },
  reason: { fontSize: 15, lineHeight: 21, marginTop: 8, color: "#111" },
  meta: { fontSize: 12, color: "#999", marginTop: 6 },
  link: { fontSize: 13, color: "#2B6CB0", marginTop: 6 },
  feedbackRow: { flexDirection: "row", marginTop: 10 },
  feedbackBtn: {
    borderWidth: 1,
    borderColor: "#DDD",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginRight: 8,
  },
  feedbackActive: { backgroundColor: "#E8F0FE", borderColor: "#2B6CB0" },
  feedbackText: { fontSize: 13, color: "#333" },
  empty: { textAlign: "center", marginTop: 60, color: "#999", paddingHorizontal: 20 },
});
