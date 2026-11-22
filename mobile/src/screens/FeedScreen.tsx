/**
 * 推送流屏幕 v3：信息源分组 + 翻页式阅读 + 内置浏览器
 *
 * - 相同信息源（platform_name）聚合成组卡，组序按最新内容时间
 * - 组卡折叠态显示最新一条摘要；展开后组内横向翻页（滑动=翻书），页脚页码
 * - 「打开原文链接」走 expo-web-browser（Chrome Custom Tabs 内嵌，不跳出 App）
 * - v0.4.1：组卡外壳/加载态抽到 components/，重卡片 memo 化
 */

import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { Contract, Settings, fetchRecentContracts as fetchRecent, sendFeedback } from "../api";
import { colors, confidenceStyles } from "../theme";
import { useOpenArticle } from "../article";
import { CenterLoading } from "../components/CenterLoading";
import { GroupCardShell } from "../components/GroupCardShell";

interface FeedScreenProps {
  settings: Settings;
  refreshToken: number;
}

interface ContractGroup {
  key: string;
  platform: string;
  items: Contract[];
}

function groupBySource(contracts: Contract[]): ContractGroup[] {
  const order: string[] = [];
  const map = new Map<string, Contract[]>();
  for (const c of contracts) {
    const name = c.source_attribution?.platform_name || c.source_attribution?.source_type || "未知来源";
    if (!map.has(name)) {
      map.set(name, []);
      order.push(name);
    }
    map.get(name)!.push(c);
  }
  return order.map((name) => ({ key: name, platform: name, items: map.get(name)! }));
}

/** 组内单页：一条契约的完整展示 */
const ContractPage = memo(function ContractPage({
  item,
  width,
  onFeedback,
  feedbackBusy,
}: {
  item: Contract;
  width: number;
  onFeedback: (c: Contract, f: "useful" | "useless") => void;
  feedbackBusy: number | null;
}) {
  const openArticle = useOpenArticle();
  const conf = confidenceStyles[item.confidence] ?? confidenceStyles.low;
  const reason = item.hit_reason?.text ?? "";
  const attribution = item.source_attribution ?? {};
  const title = item.payload?.title?.trim();

  return (
    <View style={[styles.page, { width }]}>
      <View style={styles.pageHeader}>
        <View style={[styles.badge, { backgroundColor: conf.bg }]}>
          <Text style={[styles.badgeText, { color: conf.text }]}>{conf.label}</Text>
        </View>
        <Text style={styles.meta}>
          {item.pushed_at ? item.pushed_at.replace("T", " ").slice(0, 16) : ""}
        </Text>
      </View>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      <Text style={styles.reason}>{reason}</Text>
      <Text style={styles.interest}>兴趣「{item.interest_id}」</Text>
      {Boolean(attribution.url) ? (
        <TouchableOpacity
          style={styles.linkBtn}
          onPress={() => openArticle(attribution.url, title || attribution.platform_name || "文章")}
        >
          <Ionicons name="document-text-outline" size={15} color={colors.accentDark} />
          <Text style={styles.linkText}>阅读原文</Text>
        </TouchableOpacity>
      ) : null}
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
          <Text style={[styles.feedbackText, item.user_feedback === "useful" && styles.feedbackTextUseful]}>有用</Text>
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
          <Text style={[styles.feedbackText, item.user_feedback === "useless" && styles.feedbackTextUseless]}>无用</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
});

/** 信息源组卡：折叠摘要 + 展开后横向翻页 */
const SourceGroupCard = memo(function SourceGroupCard({
  group,
  expanded,
  onToggle,
  onFeedback,
  feedbackBusy,
}: {
  group: ContractGroup;
  expanded: boolean;
  onToggle: () => void;
  onFeedback: (c: Contract, f: "useful" | "useless") => void;
  feedbackBusy: number | null;
}) {
  const [pageWidth, setPageWidth] = useState(0);
  const [page, setPage] = useState(0);
  const latest = group.items[0];
  const latestTitle = latest ? latest.payload?.title?.trim() || latest.hit_reason?.text || "" : "";

  const onScroll = useCallback((e: { nativeEvent: { contentOffset: { x: number } } }) => {
    if (!pageWidth) return;
    const idx = Math.round(e.nativeEvent.contentOffset.x / pageWidth);
    setPage(Math.max(0, Math.min(idx, group.items.length - 1)));
  }, [pageWidth, group.items.length]);

  return (
    <GroupCardShell
      platform={group.platform}
      expanded={expanded}
      onToggle={onToggle}
      badgeCount={group.items.length}
      summary={latestTitle}
    >
      <View onLayout={(e) => setPageWidth(e.nativeEvent.layout.width)}>
        {pageWidth > 0 ? (
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onScroll={(e) => onScroll(e)}
            scrollEventThrottle={32}
          >
            {group.items.map((item) => (
              <ContractPage
                key={item.id}
                item={item}
                width={pageWidth}
                onFeedback={onFeedback}
                feedbackBusy={feedbackBusy}
              />
            ))}
          </ScrollView>
        ) : null}
        {group.items.length > 1 && pageWidth > 0 ? (
          <View style={styles.pageIndicator}>
            <View style={[styles.pageArrow, page === 0 && styles.pageArrowDisabled]}>
              <Ionicons name="chevron-back" size={13} color={colors.faint} />
            </View>
            <Text style={styles.pageText}>
              {page + 1} / {group.items.length}
            </Text>
            <View style={styles.pageDots}>
              {group.items.slice(0, 8).map((_, i) => (
                <View key={i} style={[styles.dot, i === page && styles.dotActive]} />
              ))}
            </View>
            <View style={[styles.pageArrow, page >= group.items.length - 1 && styles.pageArrowDisabled]}>
              <Ionicons name="chevron-forward" size={13} color={colors.faint} />
            </View>
          </View>
        ) : null}
      </View>
    </GroupCardShell>
  );
});

export function FeedScreen({ settings, refreshToken }: FeedScreenProps) {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [feedbackBusy, setFeedbackBusy] = useState<number | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchRecent(settings);
      setContracts(data.contracts);
      // 首次加载：最新的一组默认展开
      const groups = groupBySource(data.contracts);
      setExpandedIds((prev) => {
        if (prev.size > 0) return prev;
        const first = groups[0]?.key;
        return first ? new Set([first]) : new Set();
      });
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

  const groups = useMemo(() => groupBySource(contracts), [contracts]);
  const allExpanded = groups.length > 0 && expandedIds.size >= groups.length;

  const toggleGroup = useCallback((key: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setExpandedIds((prev) => (prev.size >= groups.length ? new Set() : new Set(groups.map((g) => g.key))));
  }, [groups]);

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

  const renderGroup = useCallback(
    ({ item }: { item: ContractGroup }) => (
      <SourceGroupCard
        group={item}
        expanded={expandedIds.has(item.key)}
        onToggle={() => toggleGroup(item.key)}
        onFeedback={onFeedback}
        feedbackBusy={feedbackBusy}
      />
    ),
    [expandedIds, toggleGroup, onFeedback, feedbackBusy]
  );

  if (loading && contracts.length === 0) {
    return <CenterLoading />;
  }

  return (
    <View style={styles.flex1}>
      {groups.length > 1 ? (
        <View style={styles.toggleAll}>
          <TouchableOpacity onPress={toggleAll} hitSlop={{ top: 6, bottom: 6 }}>
            <Text style={styles.toggleAllText}>{allExpanded ? "全部折叠" : "全部展开"}</Text>
          </TouchableOpacity>
          <Text style={styles.toggleAllCount}>{contracts.length} 条 · {groups.length} 源</Text>
        </View>
      ) : null}
      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={groups}
        keyExtractor={(g) => g.key}
        renderItem={renderGroup}
        removeClippedSubviews
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
    </View>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  list: { flex: 1 },
  listContent: { paddingBottom: 20 },
  toggleAll: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  toggleAllText: { fontSize: 13, color: colors.accentDark, fontWeight: "600" },
  toggleAllCount: { fontSize: 12, color: colors.faint },
  page: { paddingHorizontal: 4, paddingTop: 12, paddingBottom: 6 },
  pageHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  badge: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3, alignSelf: "flex-start" },
  badgeText: { fontSize: 11, fontWeight: "600" },
  meta: { fontSize: 11, color: colors.faint },
  title: { fontSize: 15, fontWeight: "700", color: colors.text, marginTop: 9, lineHeight: 21 },
  reason: { fontSize: 14, lineHeight: 20, marginTop: 6, color: colors.secondary },
  interest: { fontSize: 12, color: colors.faint, marginTop: 8 },
  linkBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.accentSoft,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginTop: 10,
  },
  linkText: { fontSize: 13, color: colors.accentDark, fontWeight: "600" },
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
  pageIndicator: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingTop: 4,
    paddingBottom: 2,
  },
  pageArrow: { paddingHorizontal: 4 },
  pageArrowDisabled: { opacity: 0.3 },
  pageText: { fontSize: 12, color: colors.secondary, fontWeight: "600", minWidth: 40, textAlign: "center" },
  pageDots: { flexDirection: "row", gap: 4, alignItems: "center" },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.border },
  dotActive: { backgroundColor: colors.accent },
  empty: { textAlign: "center", marginTop: 60, color: colors.faint, paddingHorizontal: 20, lineHeight: 22 },
});
