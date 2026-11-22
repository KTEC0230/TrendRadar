/**
 * 热榜屏幕：今日全网热榜浏览（上游 TrendRadar 核心功能的 App 化）
 *
 * - 按平台分组卡片（GroupCardShell，默认展开），条目行 = 排名徽章 + 标题 + 趋势标
 * - 前 3 名橙色强调；趋势：🔺上升 🔻下降 🆕新上榜 · 持平灰
 * - 点条目 → App 内文章页（mobile_url 优先）
 * - 「报告」按钮 → 历史报告列表（Modal）→ 点选进文章页阅读
 */

import React, { memo, useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { HotlistPlatform, ReportInfo, fetchHotlist, fetchReports, Settings } from "../api";
import { colors } from "../theme";
import { useOpenArticle } from "../article";
import { CenterLoading } from "../components/CenterLoading";
import { GroupCardShell } from "../components/GroupCardShell";

interface HotlistScreenProps {
  settings: Settings;
}

const TREND_MARKS: Record<string, { text: string; color: string }> = {
  up: { text: "🔺", color: colors.danger },
  down: { text: "🔻", color: colors.success },
  new: { text: "🆕", color: colors.accentDark },
  flat: { text: "·", color: colors.faint },
};

function RankBadge({ rank }: { rank: number }) {
  const top = rank <= 3;
  return (
    <View style={[styles.rankBadge, top && styles.rankBadgeTop]}>
      <Text style={[styles.rankText, top && styles.rankTextTop]}>{rank}</Text>
    </View>
  );
}

const PlatformCard = memo(function PlatformCard({
  platform,
}: {
  platform: HotlistPlatform;
}) {
  const openArticle = useOpenArticle();
  const [expanded, setExpanded] = useState(true);
  return (
    <GroupCardShell
      platform={platform.name}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      badgeCount={platform.items.length}
    >
      {platform.items.map((item) => (
        <TouchableOpacity
          key={`${item.rank}-${item.title}`}
          style={styles.row}
          activeOpacity={0.6}
          onPress={() => {
            const url = item.mobile_url || item.url;
            if (url) openArticle(url, item.title);
          }}
        >
          <RankBadge rank={item.rank} />
          <Text style={styles.rowTitle} numberOfLines={2}>
            {item.title}
          </Text>
          <Text style={[styles.trend, { color: TREND_MARKS[item.trend]?.color ?? colors.faint }]}>
            {TREND_MARKS[item.trend]?.text ?? "·"}
            {item.trend !== "flat" && item.trend !== "new" && item.delta !== 0
              ? ` ${Math.abs(item.delta)}`
              : ""}
          </Text>
        </TouchableOpacity>
      ))}
    </GroupCardShell>
  );
});

export function HotlistScreen({ settings }: HotlistScreenProps) {
  const openArticle = useOpenArticle();
  const [platforms, setPlatforms] = useState<HotlistPlatform[]>([]);
  const [date, setDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reportsVisible, setReportsVisible] = useState(false);
  const [reports, setReports] = useState<ReportInfo[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchHotlist(settings);
      setPlatforms(data.platforms ?? []);
      setDate(data.date ?? "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [settings.baseUrl, settings.authToken]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  const openReports = useCallback(async () => {
    setReportsVisible(true);
    setReportsLoading(true);
    try {
      const data = await fetchReports(settings);
      setReports(data.reports ?? []);
    } catch (e) {
      setReports([]);
    } finally {
      setReportsLoading(false);
    }
  }, [settings.baseUrl, settings.authToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const openReportFile = useCallback(
    (r: ReportInfo) => {
      const base = settings.baseUrl.replace(/\/+$/, "");
      setReportsVisible(false);
      openArticle(`${base}/report/file/${r.name}?token=${encodeURIComponent(settings.authToken)}`, `${r.date} ${r.time} 报告`);
    },
    [settings.baseUrl, settings.authToken, openArticle]
  );

  const renderPlatform = useCallback(
    ({ item }: { item: HotlistPlatform }) => <PlatformCard platform={item} />,
    []
  );

  if (loading && platforms.length === 0) {
    return <CenterLoading />;
  }

  return (
    <View style={styles.flex1}>
      <View style={styles.toolbar}>
        <Text style={styles.dateText}>{date ? `数据日期 ${date}` : ""}</Text>
        <TouchableOpacity style={styles.reportBtn} onPress={openReports}>
          <Ionicons name="document-text-outline" size={14} color={colors.accentDark} />
          <Text style={styles.reportBtnText}>报告</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={platforms}
        keyExtractor={(p) => p.id}
        renderItem={renderPlatform}
        removeClippedSubviews
        ListEmptyComponent={
          <Text style={styles.empty}>
            {error || "云端暂无热榜数据——等下一轮管道运行后就有了"}
          </Text>
        }
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.accent} colors={[colors.accent]} />
        }
      />

      {/* 历史报告列表 */}
      <Modal visible={reportsVisible} transparent animationType="slide" onRequestClose={() => setReportsVisible(false)}>
        <View style={styles.modalMask}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>历史报告</Text>
              <TouchableOpacity onPress={() => setReportsVisible(false)} hitSlop={{ top: 10, right: 10, bottom: 10 }}>
                <Ionicons name="close" size={22} color={colors.secondary} />
              </TouchableOpacity>
            </View>
            {reportsLoading ? (
              <View style={styles.modalLoading}>
                <ActivityIndicator color={colors.accent} />
              </View>
            ) : (
              <FlatList
                data={reports}
                keyExtractor={(r) => r.name}
                renderItem={({ item }) => (
                  <TouchableOpacity style={styles.reportRow} onPress={() => openReportFile(item)}>
                    <Ionicons name="document-text-outline" size={17} color={colors.accentDark} />
                    <Text style={styles.reportRowText}>{item.date} {item.time}</Text>
                    <Text style={styles.reportRowSize}>{Math.round(item.size / 1024)} KB</Text>
                  </TouchableOpacity>
                )}
                ListEmptyComponent={<Text style={styles.emptySmall}>云端还没有历史报告——每轮管道运行后自动积累</Text>}
              />
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  list: { flex: 1 },
  listContent: { paddingBottom: 20 },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  dateText: { fontSize: 12, color: colors.faint },
  reportBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  reportBtnText: { fontSize: 13, color: colors.accentDark, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 8, marginTop: 2 },
  rankBadge: {
    width: 26,
    height: 26,
    borderRadius: 8,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  rankBadgeTop: { backgroundColor: colors.accent },
  rankText: { fontSize: 12, fontWeight: "700", color: colors.secondary },
  rankTextTop: { color: "#fff" },
  rowTitle: { flex: 1, fontSize: 14, color: colors.text, lineHeight: 19, marginHorizontal: 10 },
  trend: { fontSize: 12, fontWeight: "600", minWidth: 34, textAlign: "right" },
  empty: { textAlign: "center", marginTop: 60, color: colors.faint, paddingHorizontal: 20, lineHeight: 22 },
  modalMask: { flex: 1, backgroundColor: "rgba(31,30,29,0.45)", justifyContent: "flex-end" },
  modalCard: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "70%",
    padding: 18,
  },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  modalTitle: { fontSize: 16, fontWeight: "700", color: colors.text },
  modalLoading: { paddingVertical: 40, alignItems: "center" },
  reportRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  reportRowText: { flex: 1, fontSize: 14, color: colors.text, fontWeight: "500" },
  reportRowSize: { fontSize: 12, color: colors.faint },
  emptySmall: { fontSize: 12, color: colors.faint, textAlign: "center", paddingVertical: 24 },
});
