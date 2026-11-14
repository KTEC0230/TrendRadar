/**
 * 设置屏幕：后端地址 / token / 设备名 / EAS projectId + 推送注册 + 连接测试
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
import { registerPush } from "../push";

interface SettingsScreenProps {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onRegistered: () => void; // 注册成功后刷新推送流
}

type StatusKind = "idle" | "ok" | "error";

export function SettingsScreen({ settings, onChange, onRegistered }: SettingsScreenProps) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [busy, setBusy] = useState<"save" | "register" | "test" | null>(null);
  const [status, setStatus] = useState<{ kind: StatusKind; message: string }>({
    kind: "idle",
    message: "",
  });

  const update = (patch: Partial<Settings>) => setDraft((prev) => ({ ...prev, ...patch }));

  const onSave = async () => {
    setBusy("save");
    try {
      await onChange(draft); // 父组件负责持久化
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

  const onRegister = async () => {
    setBusy("register");
    try {
      const saved = { ...draft };
      await onChange(saved); // 先持久化再注册
      const { token } = await registerPush(saved);
      setStatus({ kind: "ok", message: `注册成功！ExpoPushToken：${token.slice(0, 28)}…` });
      onRegistered();
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
        placeholder="http://192.168.1.10:8807"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <Text style={styles.hint}>API 服务地址（jingliu.api.host:port），/api 会自动补全</Text>

      <Text style={styles.label}>Bearer Token</Text>
      <TextInput
        style={styles.input}
        value={draft.authToken}
        onChangeText={(v) => update({ authToken: v })}
        placeholder="config.yaml 的 jingliu.api.auth_token"
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

      <Text style={styles.label}>EAS projectId</Text>
      <TextInput
        style={styles.input}
        value={draft.projectId}
        onChangeText={(v) => update({ projectId: v })}
        placeholder="npx eas init 后生成（留空则读 app.json）"
        autoCapitalize="none"
        autoCorrect={false}
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
        onPress={onRegister}
        disabled={busy !== null}
      >
        {busy === "register" ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : (
          <Text style={styles.primaryText}>🔔 注册到推送服务</Text>
        )}
      </TouchableOpacity>
      <Text style={styles.hint}>
        注册流程：通知权限 → 获取 ExpoPushToken → 写入后端 devices 表。后端推送时静态配置与注册设备自动合并。
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
