/**
 * 全屏加载态（各屏通用的首载指示）
 */

import React from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { colors } from "../theme";

export function CenterLoading() {
  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={colors.accent} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
});
