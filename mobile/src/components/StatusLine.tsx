/**
 * 状态提示行（保存/连接/操作结果的统一展示）
 */

import React from "react";
import { StyleSheet, Text } from "react-native";

import { colors } from "../theme";

export function StatusLine({
  kind,
  message,
  faintText,
}: {
  kind: "idle" | "ok" | "error";
  message: string;
  /** idle 时的弱化占位文案（可选） */
  faintText?: string;
}) {
  if (!message) {
    return faintText ? <Text style={styles.faint}>{faintText}</Text> : null;
  }
  return (
    <Text style={[styles.base, kind === "error" ? styles.error : styles.ok]}>
      {kind === "error" ? "✗ " : "✓ "}
      {message}
    </Text>
  );
}

const styles = StyleSheet.create({
  base: { fontSize: 13, lineHeight: 18, marginTop: 10 },
  faint: { fontSize: 12, color: colors.faint, textAlign: "center", marginTop: 10 },
  ok: { color: colors.success },
  error: { color: colors.danger },
});
