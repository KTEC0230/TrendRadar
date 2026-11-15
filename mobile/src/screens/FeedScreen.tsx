/**
 * 推送流屏幕：已推送契约列表 + 有用/无用反馈
 *
 * 卡片走 Claude 风：白底细边框圆角、置信度浅色 pill 徽章、陶土橙反馈高亮。
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
import { Ionicons } from "@expo/vector-icons";

import { Contract, Settings, fetchRecentContracts as fetchRecent, sendFeedback } from "../api";
import { colors, confidenceStyles } from "../theme";

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
    const conf = confidenceStyles[item.confidence] ?? confidenceStyles.low;
    const title = item.payload?.title?.trim();

    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.platformWrap}>
            <Ionicons name="pulse-outline" size={13} color={colors.secondary} />
            <Text style={styles.platform}>{attribution.platform_name || attribution.source_type || "未知来源"}</Text>
          </View>
          <View style={[styles.badge, { backgroundColor: conf.bg }]}>
            <Text style={[styles.badgeText, { color: conf.text }]}>{conf.label}</Text>
          </View>
        </View>
        {title ? <Text style={styles.title}>{title}</Text> : null}
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
            style={[styles.feedbackBtn, item.user_feedback === "useful" && styles.feedbackActiveUseful]}
            disabled={feedbackBusy === item.id}
            onPress={() => onFeedback(item, "useful")}
          >
            <Ionicons
              name={item.user_feedback === "useful" ? "thumbs-up" : "thumbs-up-outline"}
              size={13}
              color={item.user_feedback === "useful" ? colors.success : colors.secondary}
            />
            <Text
              style={[
                styles.feedbackText,
                item.user_feedback === "useful" && styles.feedbackTextUseful,
              ]}
            >
              有用
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.feedbackBtn, item.user_feedback === "useless" && styles.feedbackActiveUseless]}
            disabled={feedbackBusy === item.id}
            onPress={() => onFeedback(item, "useless")}
          >
            <Ionicons
              name={item.user_feedback === "useless" ? "thumbs-down" : "thumbs-down-outline"}
              size={13}
              color={item.user_feedback === "useless" ? colors.danger : colors.secondary}
            />
            <Text
              style={[
                styles.feedbackText,
                item.user_feedback === "useless" && styles.feedbackTextUseless,
              ]}
            >
              无用
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  if (loading && contracts.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.listContent}
      data={contracts}
      keyExtractor={(item) => String(item.id)}
      renderItem={renderItem}
      ListEmptyComponent={
        <Text style={styles.empty}>{error || "还没有推送记录——先让后端跑一轮吧"}</Text>
      }
      refreshControl={
        <RefreshControl
          refreshing={loading}
          onRefresh={load}
          tintColor={colors.accent}
          colors={[colors.accent]}
        />
      }
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  listContent: { paddingBottom: 20 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    marginHorizontal: 14,
    marginTop: 10,
    padding: 15,
  },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  platformWrap: { flexDirection: "row", alignItems: "center", gap: 5 },
  platform: { fontSize: 12, color: colors.secondary, fontWeight: "600", letterSpacing: 0.2 },
  badge: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  badgeText: { fontSize: 11, fontWeight: "600" },
  title: { fontSize: 15, fontWeight: "700", color: colors.text, marginTop: 9, lineHeight: 21 },
  reason: { fontSize: 14, lineHeight: 20, marginTop: 6, color: colors.secondary },
  meta: { fontSize: 12, color: colors.faint, marginTop: 8 },
  link: { fontSize: 13, color: colors.accentDark, marginTop: 8, fontWeight: "500" },
  feedbackRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  feedbackBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 6,
  },
  feedbackActiveUseful: { backgroundColor: colors.successSoft, borderColor: colors.success },
  feedbackActiveUseless: { backgroundColor: colors.dangerSoft, borderColor: colors.danger },
  feedbackText: { fontSize: 13, color: colors.secondary },
  feedbackTextUseful: { color: colors.success, fontWeight: "600" },
  feedbackTextUseless: { color: colors.danger, fontWeight: "600" },
  empty: { textAlign: "center", marginTop: 60, color: colors.faint, paddingHorizontal: 20, lineHeight: 22 },
});
