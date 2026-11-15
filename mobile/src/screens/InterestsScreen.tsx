/**
 * 兴趣屏幕：手机上直接编辑后端的兴趣文件
 *
 * ai_interests.txt  = AI 兴趣描述（AI 筛选按这段话判断相关性）
 * frequency_words.txt = 关键词匹配（命中即推送）
 *
 * 后端写入前会自动备份 .bak；下次管道运行即生效（云端 = 下一次 GH Actions）。
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { InterestTarget, fetchInterests, saveInterests, Settings } from "../api";
import { colors } from "../theme";

interface InterestsScreenProps {
  settings: Settings;
}

type StatusKind = "idle" | "ok" | "error";

const SECTIONS: {
  target: InterestTarget;
  title: string;
  hint: string;
  placeholder: string;
}[] = [
  {
    target: "ai_interests",
    title: "AI 兴趣描述",
    hint: "自然语言描述你关心的内容，AI 筛选按此判断（每行一条）",
    placeholder: "例如：\n关注 AI 编程工具的新版本发布\n关注独立游戏开发者的动态",
  },
  {
    target: "frequency_words",
    title: "关键词匹配",
    hint: "标题命中关键词直接推送，不经过 AI（每行一个词）",
    placeholder: "例如：\nExpo\nClaude\nRust",
  },
];

export function InterestsScreen({ settings }: InterestsScreenProps) {
  const [files, setFiles] = useState<Record<InterestTarget, string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingTarget, setSavingTarget] = useState<InterestTarget | null>(null);
  const [status, setStatus] = useState<{ kind: StatusKind; message: string }>({ kind: "idle", message: "" });
  const [dirty, setDirty] = useState<Record<InterestTarget, boolean>>({
    ai_interests: false,
    frequency_words: false,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchInterests(settings);
      setFiles({
        ai_interests: data.ai_interests?.content ?? "",
        frequency_words: data.frequency_words?.content ?? "",
      });
      setDirty({ ai_interests: false, frequency_words: false });
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [settings.baseUrl, settings.authToken]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  const onSave = async (target: InterestTarget) => {
    if (!files) return;
    setSavingTarget(target);
    try {
      await saveInterests(settings, target, files[target]);
      setDirty((prev) => ({ ...prev, [target]: false }));
      setStatus({ kind: "ok", message: "已保存，下次后端运行时生效" });
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message });
    } finally {
      setSavingTarget(null);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
    >
      {SECTIONS.map((section) => (
        <View key={section.target} style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>{section.title}</Text>
            <TouchableOpacity
              style={[
                styles.saveBtn,
                (!files || savingTarget !== null) && styles.saveBtnDisabled,
                dirty[section.target] && styles.saveBtnDirty,
              ]}
              disabled={!files || savingTarget !== null}
              onPress={() => onSave(section.target)}
            >
              {savingTarget === section.target ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.saveBtnText}>{dirty[section.target] ? "保存" : "已同步"}</Text>
              )}
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.editor}
            value={files?.[section.target] ?? ""}
            onChangeText={(v) => {
              setFiles((prev) => (prev ? { ...prev, [section.target]: v } : prev));
              setDirty((prev) => ({ ...prev, [section.target]: true }));
            }}
            placeholder={section.placeholder}
            placeholderTextColor={colors.faint}
            multiline
            textAlignVertical="top"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.hint}>{section.hint}</Text>
        </View>
      ))}

      {status.message ? (
        <Text style={[styles.status, status.kind === "error" ? styles.error : styles.ok]}>
          {status.kind === "error" ? "✗ " : "✓ "}
          {status.message}
        </Text>
      ) : (
        <Text style={styles.statusFaint}>修改会实时写入后端；建议保留每行一条的格式</Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 32 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: 16,
    marginBottom: 14,
  },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
  saveBtn: {
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 14,
    backgroundColor: colors.accent,
    minWidth: 64,
    alignItems: "center",
  },
  saveBtnDisabled: { backgroundColor: colors.borderStrong },
  saveBtnDirty: {},
  saveBtnText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  editor: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 12,
    backgroundColor: colors.bg,
    fontSize: 14,
    lineHeight: 20,
    color: colors.text,
    minHeight: 120,
  },
  hint: { fontSize: 12, color: colors.secondary, marginTop: 8, lineHeight: 17 },
  status: { marginTop: 4, fontSize: 13, lineHeight: 18 },
  statusFaint: { marginTop: 4, fontSize: 12, color: colors.faint, textAlign: "center" },
  ok: { color: colors.success },
  error: { color: colors.danger },
});
