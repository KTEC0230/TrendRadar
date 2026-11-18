/**
 * 组卡外壳（推送流/热榜共用的分组卡片头部：头像圆标+标题+副标题/计数+折叠箭头）
 */

import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { colors } from "../theme";

export function GroupCardShell({
  platform,
  expanded,
  onToggle,
  badgeCount,
  summary,
  children,
}: {
  platform: string;
  expanded: boolean;
  onToggle: () => void;
  /** 折叠时右上角的条数徽章（1 条时不显示） */
  badgeCount?: number;
  /** 折叠时标题下的一行摘要 */
  summary?: string;
  children?: React.ReactNode;
}) {
  return (
    <View style={styles.card}>
      <TouchableOpacity style={styles.header} onPress={onToggle} activeOpacity={0.7}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{platform.slice(0, 1)}</Text>
        </View>
        <View style={styles.headerText}>
          <Text style={styles.platform}>{platform}</Text>
          {expanded ? (
            <Text style={styles.count}>{badgeCount ?? 0} 条</Text>
          ) : (
            summary ? <Text style={styles.summary} numberOfLines={1}>{summary}</Text> : null
          )}
        </View>
        <View style={styles.trailing}>
          {!expanded && badgeCount != null && badgeCount > 1 && (
            <Text style={styles.badge}>{badgeCount}</Text>
          )}
          <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={16} color={colors.faint} />
        </View>
      </TouchableOpacity>
      {expanded ? children : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    marginHorizontal: 14,
    marginTop: 10,
    padding: 14,
    overflow: "hidden",
  },
  header: { flexDirection: "row", alignItems: "center" },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 12,
    backgroundColor: colors.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 15, fontWeight: "700", color: colors.accentDark },
  headerText: { flex: 1, marginLeft: 10, marginRight: 6 },
  platform: { fontSize: 14, fontWeight: "700", color: colors.text },
  summary: { fontSize: 12, color: colors.secondary, marginTop: 2 },
  count: { fontSize: 12, color: colors.faint, marginTop: 2 },
  trailing: { flexDirection: "row", alignItems: "center", gap: 6 },
  badge: {
    backgroundColor: colors.accentSoft,
    color: colors.accentDark,
    fontSize: 12,
    fontWeight: "700",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: "hidden",
  },
});
