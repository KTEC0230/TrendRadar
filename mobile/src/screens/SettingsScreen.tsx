/**
 * 设置屏幕：连接 / 通知 / 后台保活 三组卡片
 *
 * 推送架构（国内网络）：无远程推送依赖，改为
 * "通知权限 + WorkManager 后台轮询(15分钟) + 本地通知"，App 前台时实时拉取。
 * 后台保活：OPPO/vivo 等厂商系统需要手动加白名单，这里提供直达跳转。
 */

import React, { useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { Settings, checkHealth } from "../api";
import { enableBackgroundPolling, pollingEnabled } from "../background";
import { checkForNewContracts, ensureNotificationReady } from "../notifications";
import { openAutostartSettings, openBatteryWhitelist } from "../keepalive";
import { colors } from "../theme";

interface SettingsScreenProps {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onRefresh: () => void;
}

type StatusKind = "idle" | "ok" | "error";

export function SettingsScreen({ settings, onChange, onRefresh }: SettingsScreenProps) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [busy, setBusy] = useState<"save" | "notify" | "test" | "battery" | "autostart" | null>(null);
  const [status, setStatus] = useState<{ kind: StatusKind; message: string }>({
    kind: "idle",
    message: "",
  });
  const [keepaliveHint, setKeepaliveHint] = useState("");

  const update = (patch: Partial<Settings>) => setDraft((prev) => ({ ...prev, ...patch }));

  const onSave = async () => {
    setBusy("save");
    try {
      await onChange(draft);
      setStatus({ kind: "ok", message: "设置已保存" });
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const onTest = async () => {
    setBusy("test");
    try {
      const health = await checkHealth(draft);
      setStatus({ kind: "ok", message: `连接正常（后端: ${health.backend}）` });
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const onEnableNotifications = async () => {
    setBusy("notify");
    try {
      const saved = { ...draft };
      await onChange(saved); // 先持久化再拉取
      await ensureNotificationReady();
      await enableBackgroundPolling();
      const fresh = await checkForNewContracts(saved); // 立即拉一次验证 + 建基线
      const registered = await pollingEnabled();
      setStatus({
        kind: "ok",
        message: `通知已开启，后台轮询${
          registered ? "已注册（约 15 分钟一次）" : "注册待系统生效"
        }。${fresh > 0 ? `本次发现 ${fresh} 条新内容。` : ""}App 在前台时会实时拉取。`,
      });
      onRefresh();
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const onBattery = async () => {
    setBusy("battery");
    try {
      const hint = await openBatteryWhitelist();
      setKeepaliveHint(hint);
    } finally {
      setBusy(null);
    }
  };

  const onAutostart = async () => {
    setBusy("autostart");
    try {
      const hint = await openAutostartSettings();
      setKeepaliveHint(hint);
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
      {/* 连接 */}
      <Text style={styles.sectionTitle}>连接</Text>
      <View style={styles.card}>
        <Text style={styles.label}>后端地址</Text>
        <TextInput
          style={styles.input}
          value={draft.baseUrl}
          onChangeText={(v) => update({ baseUrl: v })}
          placeholder="https://jingliu.example.com"
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Text style={styles.hint}>固定公网地址，/api 自动补全；填一次就不用再改</Text>

        <Text style={styles.label}>Bearer Token</Text>
        <TextInput
          style={styles.input}
          value={draft.authToken}
          onChangeText={(v) => update({ authToken: v })}
          placeholder="部署时设置的访问令牌"
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />

        <Text style={styles.label}>设备名称</Text>
        <TextInput
          style={styles.input}
          value={draft.deviceName}
          onChangeText={(v) => update({ deviceName: v })}
          placeholder="我的安卓手机"
          placeholderTextColor={colors.faint}
        />

        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.primaryBtn, busy !== null && styles.disabled]}
            onPress={onSave}
            disabled={busy !== null}
          >
            {busy === "save" ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.primaryBtnText}>保存设置</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.ghostBtn} onPress={onTest} disabled={busy !== null}>
            {busy === "test" ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <Text style={styles.ghostBtnText}>测试连接</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* 通知 */}
      <Text style={styles.sectionTitle}>通知</Text>
      <View style={styles.card}>
        <TouchableOpacity
          style={[styles.primaryBtnFull, busy !== null && styles.disabled]}
          onPress={onEnableNotifications}
          disabled={busy !== null}
        >
          {busy === "notify" ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <View style={styles.btnWithIcon}>
              <Ionicons name="notifications-outline" size={17} color="#fff" />
              <Text style={styles.primaryBtnText}>开启通知 + 后台刷新</Text>
            </View>
          )}
        </TouchableOpacity>
        <Text style={styles.hint}>
          前台实时拉取；后台由系统约每 15 分钟拉一次，有新内容弹本地通知。首次开启只建基线不通知。
        </Text>
      </View>

      {/* 后台保活 */}
      <Text style={styles.sectionTitle}>后台保活</Text>
      <View style={styles.card}>
        <Text style={styles.keepaliveIntro}>
          OPPO/vivo 等手机默认冻结后台应用，不加白名单的话推送会延迟或收不到。两项都建议开启：
        </Text>
        <View style={styles.keepaliveRow}>
          <View style={styles.keepaliveTextWrap}>
            <Text style={styles.keepaliveTitle}>电池优化白名单</Text>
            <Text style={styles.keepaliveDesc}>弹系统确认框，允许静流后台运行（全品牌通用）</Text>
          </View>
          <TouchableOpacity
            style={[styles.keepaliveBtn, busy === "battery" && styles.disabled]}
            onPress={onBattery}
            disabled={busy !== null}
          >
            {busy === "battery" ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.keepaliveBtnText}>去开启</Text>
            )}
          </TouchableOpacity>
        </View>
        <View style={[styles.keepaliveRow, styles.keepaliveRowLast]}>
          <View style={styles.keepaliveTextWrap}>
            <Text style={styles.keepaliveTitle}>自启动权限</Text>
            <Text style={styles.keepaliveDesc}>跳转系统自启动/耗电管理页（按手机品牌尝试）</Text>
          </View>
          <TouchableOpacity
            style={[styles.keepaliveBtn, busy === "autostart" && styles.disabled]}
            onPress={onAutostart}
            disabled={busy !== null}
          >
            {busy === "autostart" ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.keepaliveBtnText}>去开启</Text>
            )}
          </TouchableOpacity>
        </View>
        {keepaliveHint ? <Text style={styles.keepaliveHint}>{keepaliveHint}</Text> : null}
      </View>

      {status.message ? (
        <Text style={[styles.status, status.kind === "error" ? styles.error : styles.ok]}>
          {status.kind === "error" ? "✗ " : "✓ "}
          {status.message}
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 32 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.secondary,
    letterSpacing: 1,
    marginBottom: 8,
    marginTop: 4,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: 16,
    marginBottom: 16,
  },
  label: { fontSize: 14, fontWeight: "600", marginTop: 12, color: colors.text },
  hint: { fontSize: 12, color: colors.secondary, marginTop: 6, lineHeight: 17 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 6,
    backgroundColor: colors.bg,
    fontSize: 14,
    color: colors.text,
  },
  buttonRow: { flexDirection: "row", gap: 10, marginTop: 18 },
  primaryBtn: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 18,
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnFull: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  btnWithIcon: { flexDirection: "row", alignItems: "center", gap: 6 },
  ghostBtn: {
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  ghostBtnText: { color: colors.text, fontSize: 15 },
  disabled: { opacity: 0.55 },
  keepaliveIntro: { fontSize: 13, lineHeight: 19, color: colors.secondary },
  keepaliveRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: 12,
  },
  keepaliveRowLast: {},
  keepaliveTextWrap: { flex: 1 },
  keepaliveTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  keepaliveDesc: { fontSize: 12, color: colors.secondary, marginTop: 3, lineHeight: 16 },
  keepaliveBtn: {
    backgroundColor: colors.accentSoft,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  keepaliveBtnText: { color: colors.accentDark, fontSize: 13, fontWeight: "600" },
  keepaliveHint: { fontSize: 12, color: colors.accentDark, marginTop: 10, lineHeight: 17 },
  status: { marginTop: 4, fontSize: 13, lineHeight: 18 },
  ok: { color: colors.success },
  error: { color: colors.danger },
});
