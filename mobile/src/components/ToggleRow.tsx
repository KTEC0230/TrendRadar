/**
 * 开关行（源管理屏：平台/RSS 逐项开关，带可选右侧插槽如删除按钮）
 */

import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { colors } from "../theme";

export function ToggleRow({
  title,
  subtitle,
  value,
  onChange,
  right,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.textWrap}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
      <TouchableOpacity
        style={[styles.outer, value && styles.outerOn]}
        onPress={() => onChange(!value)}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <View style={[styles.knob, value && styles.knobOn]} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 9, gap: 10 },
  textWrap: { flex: 1 },
  title: { fontSize: 14, fontWeight: "600", color: colors.text },
  subtitle: { fontSize: 11, color: colors.faint, marginTop: 2 },
  outer: {
    width: 42,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.border,
    padding: 2,
    justifyContent: "center",
  },
  outerOn: { backgroundColor: colors.accent },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: "#fff" },
  knobOn: { alignSelf: "flex-end" },
});
