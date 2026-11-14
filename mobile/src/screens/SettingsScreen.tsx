/**
 * 设置屏幕：后端地址 / token / 设备名 + 通知开启 + 连接测试
 *
 * 推送架构（国内网络）：无远程推送依赖，改为
 * "通知权限 + WorkManager 后台轮询(15分钟) + 本地通知"，App 前台时实时拉取。
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

import { Settings, checkHealth } from "../api";
import { enableBackgroundPolling, pollingEnabled } from "../background";
import { checkForNewContracts, ensureNotificationReady } from "../notifications";

interface SettingsScreenProps {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onRefresh: () => void;
}

type StatusKind = "idle" | "ok" | "error";

export function SettingsScreen({ settings, onChange, onRefresh }: SettingsScreenProps) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [busy, setBusy] = useState<"save" | "notify" | "test" | null>(null);
  const [status, setStatus] = useState<{ kind: StatusKind; message: string }>({
    kind: "idle",
    message: "",
  });

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

  return (
    <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>后端地址</Text>
      <TextInput
        style={styles.input}
        value={draft.baseUrl}
        onChangeText={(v) => update({ baseUrl: v })}
        placeholder="https://xxx.trycloudflare.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <Text style={styles.hint}>API 服务地址，/api 会自动补全</Text>

      <Text style={styles.label}>Bearer Token</Text>
      <TextInput
        style={styles.input}
        value={draft.authToken}
        onChangeText={(v) => update({ authToken: v })}
        placeholder="start-api.bat 里的 token"
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
      />

      <View style={styles.buttonRow}>
        <TouchableOpacity style={[styles.button, styles.primary]} onPress={onSave} disabled={busy !== null}>
          {busy === "save" ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.primaryText}>保存设置</Text>}
        </TouchableOpacity>
        <TouchableOpacity style={styles.button} onPress={onTest} disabled={busy !== null}>
          {busy === "test" ? <ActivityIndicator size="small" /> : <Text style={styles.plainText}>测试连接</Text>}
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[styles.button, styles.registerBtn, busy !== null && styles.disabled]}
        onPress={onEnableNotifications}
        disabled={busy !== null}
      >
        {busy === "notify" ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : (
          <Text style={styles.primaryText}>🔔 开启通知 + 后台刷新</Text>
        )}
      </TouchableOpacity>
      <Text style={styles.hint}>
        推送机制（国内网络可用，无 Google 依赖）：App 前台实时拉取；后台由系统 WorkManager
        约每 15 分钟拉取一次，有新内容弹本地通知。首次开启只建基线不通知。
      </Text>

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
  scroll: { flex: 1, padding: 16 },
  label: { fontSize: 14, fontWeight: "600", marginTop: 14, color: "#222" },
  hint: { fontSize: 12, color: "#999", marginTop: 4, lineHeight: 17 },
  input: {
    borderWidth: 1,
    borderColor: "#CCC",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 6,
    backgroundColor: "#fff",
    fontSize: 14,
  },
  buttonRow: { flexDirection: "row", marginTop: 20 },
  button: {
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderWidth: 1,
    borderColor: "#CCC",
    backgroundColor: "#fff",
    marginRight: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  primary: { backgroundColor: "#2B6CB0", borderColor: "#2B6CB0", flex: 1 },
  registerBtn: { backgroundColor: "#1B8A3A", borderColor: "#1B8A3A", marginTop: 12, paddingVertical: 14 },
  disabled: { opacity: 0.6 },
  primaryText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  plainText: { color: "#333", fontSize: 15 },
  status: { marginTop: 16, fontSize: 13, lineHeight: 18 },
  ok: { color: "#1B8A3A" },
  error: { color: "#C53030" },
});
