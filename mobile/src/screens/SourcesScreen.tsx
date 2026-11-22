/**
 * 源管理屏幕：自助管理信息源（上游 config.yaml 的 App 化）
 *
 * - 热榜平台：Switch 开关（关 = 停用该平台的抓取/热榜/推送）
 * - RSS 订阅：内置源开关 + 自定义源（可删除）+ 添加表单
 * - 保存 → PUT /api/sources-config（KV overlay）→ 下一轮管道生效
 * - catalog（全集）来自管道导出；overlay 为差异，删 overlay 即恢复默认
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import {
  SourceCatalogFeed,
  SourceCatalogPlatform,
  SourceOverlay,
  WebpageSourceEntry,
  fetchSourcesConfig,
  fetchWebpageSources,
  saveSourcesConfig,
  saveWebpageSources,
  Settings,
} from "../api";
import { colors } from "../theme";
import { CenterLoading } from "../components/CenterLoading";
import { ToggleRow } from "../components/ToggleRow";

interface SourcesScreenProps {
  settings: Settings;
}

export function SourcesScreen({ settings }: SourcesScreenProps) {
  const [platforms, setPlatforms] = useState<SourceCatalogPlatform[]>([]);
  const [feeds, setFeeds] = useState<SourceCatalogFeed[]>([]);
  const [disabledPlatforms, setDisabledPlatforms] = useState<Set<string>>(new Set());
  const [disabledFeeds, setDisabledFeeds] = useState<Set<string>>(new Set());
  const [extraFeeds, setExtraFeeds] = useState<{ id: string; name: string; url: string }[]>([]);
  const [webpageEntries, setWebpageEntries] = useState<WebpageSourceEntry[]>([]);
  const [webpageBusy, setWebpageBusy] = useState(false);
  const [wpName, setWpName] = useState("");
  const [wpUrl, setWpUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "idle" | "ok" | "error"; message: string }>({
    kind: "idle",
    message: "",
  });
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchSourcesConfig(settings);
      setPlatforms(data.catalog?.platforms ?? []);
      setFeeds(data.catalog?.feeds ?? []);
      const o = data.overlay ?? { disabled_platform_ids: [], disabled_feed_ids: [], extra_feeds: [] };
      setDisabledPlatforms(new Set(o.disabled_platform_ids ?? []));
      setDisabledFeeds(new Set(o.disabled_feed_ids ?? []));
      setExtraFeeds(o.extra_feeds ?? []);
      setStatus({ kind: "idle", message: "" });
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [settings.baseUrl, settings.authToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // 网页监控独立加载（保存后即时刷新实况）
  const loadWebpage = useCallback(async () => {
    try {
      const data = await fetchWebpageSources(settings);
      setWebpageEntries(data.overlay?.webpage_sources ?? []);
    } catch {
      setWebpageEntries([]);
    }
  }, [settings.baseUrl, settings.authToken]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadWebpage();
  }, [loadWebpage]);

  useEffect(() => {
    load();
  }, [load]);

  const togglePlatform = (id: string) => {
    setDisabledPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleFeed = (id: string) => {
    setDisabledFeeds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const slugify = (name: string, url: string) => {
    const base = name.trim() || url.replace(/^https?:\/\//, "").split("/")[0] || "feed";
    const slug = base.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "");
    return `custom-${slug || Math.random().toString(36).slice(2, 8)}`;
  };

  const addFeed = () => {
    const url = newUrl.trim();
    if (!url) return;
    const id = slugify(newName, url);
    if (extraFeeds.some((f) => f.id === id) || feeds.some((f) => f.id === id)) {
      setStatus({ kind: "error", message: "已存在同名/同 id 的订阅源" });
      return;
    }
    setExtraFeeds((prev) => [...prev, { id, name: newName.trim() || "自定义源", url }]);
    setNewName("");
    setNewUrl("");
    setStatus({ kind: "idle", message: "" });
  };

  const onSave = async () => {
    setSaving(true);
    try {
      const overlay: SourceOverlay = {
        disabled_platform_ids: Array.from(disabledPlatforms),
        disabled_feed_ids: Array.from(disabledFeeds),
        extra_feeds: extraFeeds,
      };
      await saveSourcesConfig(settings, overlay);
      setStatus({ kind: "ok", message: "已保存——下一轮管道运行时生效（约 1 小时内）" });
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const addWebpage = async () => {
    const url = wpUrl.trim();
    if (!url) return;
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      setStatus({ kind: "error", message: "网址需以 http:// 或 https:// 开头" });
      return;
    }
    if (webpageEntries.some((e) => e.url === url)) {
      setStatus({ kind: "error", message: "该网址已在监控列表里" });
      return;
    }
    const next = [
      ...webpageEntries,
      {
        uid: `wp-${Date.now()}`,
        name: wpName.trim() || "网页监控",
        url,
        enabled: true,
        check_interval: 30,
      },
    ];
    setWebpageEntries(next);
    setWpName("");
    setWpUrl("");
    setWebpageBusy(true);
    try {
      await saveWebpageSources(settings, next);
      setStatus({ kind: "ok", message: "网页监控已保存——下一轮管道运行时开始盯它" });
      loadWebpage();
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message });
    } finally {
      setWebpageBusy(false);
    }
  };

  const toggleWebpage = async (uid: string) => {
    const next = webpageEntries.map((e) => (e.uid === uid ? { ...e, enabled: !e.enabled } : e));
    setWebpageEntries(next);
    setWebpageBusy(true);
    try {
      await saveWebpageSources(settings, next);
      setStatus({ kind: "ok", message: "已保存——下一轮管道运行时生效" });
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message });
    } finally {
      setWebpageBusy(false);
    }
  };

  const deleteWebpage = async (uid: string) => {
    const next = webpageEntries.filter((e) => e.uid !== uid);
    setWebpageEntries(next);
    setWebpageBusy(true);
    try {
      await saveWebpageSources(settings, next);
      setStatus({ kind: "ok", message: "已删除——下一轮管道运行时移除监控" });
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message });
    } finally {
      setWebpageBusy(false);
    }
  };

  if (loading) {
    return <CenterLoading />;
  }

  const enabledCount = (n: number, disabledCount: number) => `${n - disabledCount} 开 / ${disabledCount} 关`;

  return (
    <FlatList
      style={styles.scroll}
      data={[]}
      renderItem={() => null}
      contentContainerStyle={styles.scrollContent}
      ListHeaderComponent={
        <View>
          <Text style={styles.sectionTitle}>热榜平台</Text>
          <View style={styles.card}>
            {platforms.map((p) => (
              <ToggleRow
                key={p.id}
                title={p.name}
                subtitle={p.id}
                value={!disabledPlatforms.has(p.id)}
                onChange={() => togglePlatform(p.id)}
              />
            ))}
            {platforms.length === 0 ? <Text style={styles.emptyLine}>暂无目录数据——等下一轮管道运行</Text> : null}
            {platforms.length > 0 ? (
              <Text style={styles.countHint}>{enabledCount(platforms.length, disabledPlatforms.size)}</Text>
            ) : null}
          </View>

          <Text style={styles.sectionTitle}>RSS 订阅</Text>
          <View style={styles.card}>
            {feeds.map((f) => (
              <ToggleRow
                key={f.id}
                title={f.name}
                subtitle={f.url}
                value={!disabledFeeds.has(f.id)}
                onChange={() => toggleFeed(f.id)}
              />
            ))}
            {extraFeeds.map((f) => (
              <ToggleRow
                key={f.id}
                title={f.name}
                subtitle={f.url}
                value
                onChange={() => {}}
                right={
                  <TouchableOpacity
                    onPress={() => setExtraFeeds((prev) => prev.filter((x) => x.id !== f.id))}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Ionicons name="trash-outline" size={17} color={colors.danger} />
                  </TouchableOpacity>
                }
              />
            ))}
            <View style={styles.addForm}>
              <TextInput
                style={styles.input}
                value={newName}
                onChangeText={setNewName}
                placeholder="订阅名称（可选）"
                placeholderTextColor={colors.faint}
              />
              <TextInput
                style={styles.input}
                value={newUrl}
                onChangeText={setNewUrl}
                placeholder="RSS/Atom 地址，如 https://example.com/feed.xml"
                placeholderTextColor={colors.faint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
              <TouchableOpacity style={styles.addBtn} onPress={addFeed}>
                <Ionicons name="add" size={16} color={colors.accentDark} />
                <Text style={styles.addBtnText}>添加订阅</Text>
              </TouchableOpacity>
            </View>
            {feeds.length + extraFeeds.length > 0 ? (
              <Text style={styles.countHint}>
                {enabledCount(feeds.length + extraFeeds.length, disabledFeeds.size)} · 自定义 {extraFeeds.length} 个
              </Text>
            ) : null}
          </View>

          <Text style={styles.sectionTitle}>网页监控</Text>
          <View style={styles.card}>
            <Text style={styles.webpageIntro}>
              盯住任意网页的内容变化（如博客更新页、公告栏），变化即推送。每 30 分钟检查一次。
            </Text>
            {webpageEntries.map((e) => (
              <ToggleRow
                key={e.uid}
                title={e.name}
                subtitle={e.url}
                value={e.enabled}
                onChange={() => toggleWebpage(e.uid)}
                right={
                  <TouchableOpacity
                    onPress={() => deleteWebpage(e.uid)}
                    disabled={webpageBusy}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Ionicons name="trash-outline" size={17} color={colors.danger} />
                  </TouchableOpacity>
                }
              />
            ))}
            {webpageEntries.length === 0 ? (
              <Text style={styles.emptyLine}>还没有监控的网页——添加一个试试</Text>
            ) : null}
            <View style={styles.addForm}>
              <TextInput
                style={styles.input}
                value={wpName}
                onChangeText={setWpName}
                placeholder="名称（可选，如：我的博客）"
                placeholderTextColor={colors.faint}
              />
              <TextInput
                style={styles.input}
                value={wpUrl}
                onChangeText={setWpUrl}
                placeholder="网页地址，如 https://example.com/posts"
                placeholderTextColor={colors.faint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
              <TouchableOpacity style={styles.addBtn} disabled={webpageBusy} onPress={addWebpage}>
                {webpageBusy ? (
                  <ActivityIndicator size="small" color={colors.accentDark} />
                ) : (
                  <>
                    <Ionicons name="add" size={16} color={colors.accentDark} />
                    <Text style={styles.addBtnText}>添加监控</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      }
      ListFooterComponent={
        <View>
          <TouchableOpacity
            style={[styles.saveBtn, saving && styles.disabled]}
            disabled={saving}
            onPress={onSave}
          >
            {saving ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.saveBtnText}>保存（下一轮管道生效）</Text>
            )}
          </TouchableOpacity>
          {status.message ? (
            <Text style={[styles.status, status.kind === "error" ? styles.error : styles.ok]}>
              {status.kind === "error" ? "✗ " : "✓ "}
              {status.message}
            </Text>
          ) : (
            <Text style={styles.statusFaint}>关闭的平台/订阅不再抓取和推送；删除 overlay 即恢复上游默认</Text>
          )}
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 32 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
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
    padding: 14,
    marginBottom: 16,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 9,
    gap: 10,
  },
  rowTextWrap: { flex: 1 },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  rowSubtitle: { fontSize: 11, color: colors.faint, marginTop: 2 },
  switchOuter: {
    width: 42,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.border,
    padding: 2,
    justifyContent: "center",
  },
  switchOuterOn: { backgroundColor: colors.accent },
  switchKnob: { width: 20, height: 20, borderRadius: 10, backgroundColor: "#fff" },
  switchKnobOn: { alignSelf: "flex-end" },
  addForm: { marginTop: 6, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, gap: 8 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: colors.bg,
    fontSize: 13,
    color: colors.text,
  },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    borderRadius: 12,
    paddingVertical: 10,
    backgroundColor: colors.accentSoft,
  },
  addBtnText: { color: colors.accentDark, fontSize: 14, fontWeight: "600" },
  countHint: { fontSize: 11, color: colors.faint, marginTop: 8 },
  webpageIntro: { fontSize: 12, lineHeight: 18, color: colors.secondary, marginBottom: 8 },
  saveBtn: {
    backgroundColor: colors.accent,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 4,
  },
  saveBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  disabled: { opacity: 0.55 },
  status: { marginTop: 10, fontSize: 13, textAlign: "center" },
  statusFaint: { marginTop: 10, fontSize: 12, color: colors.faint, textAlign: "center" },
  ok: { color: colors.success },
  error: { color: colors.danger },
  emptyLine: { fontSize: 12, color: colors.faint, paddingVertical: 8 },
});
