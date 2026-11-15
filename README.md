# 静流 JingLiu

> **推送即契约** · 每条推送都告诉你为什么 —— 同一份内容，全生命周期只推一次

基于 [sansan0/TrendRadar](https://github.com/sansan0/TrendRadar)（多平台热榜聚合）二次开发的**个人信息筛选后端 + 安卓 App**。上游的热榜聚合、RSS 订阅、AI 筛选、多渠道推送能力全部保留（原版说明见 [docs/README-upstream.md](docs/README-upstream.md)），本仓库在其上叠加了一层"契约式推送"与完整的云端/移动端链路。

---

## 它解决什么问题

信息聚合工具的通病：**同一件事每天反复推、推了也不知道为什么推**。静流的答案是"契约"——每条推送在生成时就写清命中理由（关键词命中 / AI 判断 / 网页变更），按内容指纹全程去重，并允许你对每条推送打「有用/无用」反馈。

## 架构

```
┌─────────────────────── 云端（电脑关机不影响） ───────────────────────┐
│                                                                      │
│  GitHub Actions (crawler.yml, 每小时)                                │
│    ├─ sync-in   拉取持久 state.db + 兴趣文件 overlay                 │
│    ├─ 爬取热榜/RSS/网页监控 → AI/关键词筛选 → 契约构建 + 三道门控    │
│    └─ sync-out  回传 state.db + 生成 feed.json                       │
│                          │ 存入 Cloudflare KV                       │
│  Cloudflare Worker (jingliu-api)                                     │
│    └─ https://<自定义域>  固定地址 REST API（Bearer 鉴权）           │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ 轮询
┌──────────────────────────────┴───────────────────────────────────────┐
│  安卓 App (mobile/, Expo SDK 58)                                     │
│    前台 30 秒实时拉取 + 后台 WorkManager 15 分钟兜底                  │
│    新内容 → 本地通知（无 Google 依赖，大陆网络可用）                  │
│    推送流 / 命中理由 / 有用无用反馈 / 兴趣关键词编辑 / 保活跳转       │
└──────────────────────────────────────────────────────────────────────┘
```

- **数据持久**：`state.db`（监控源/推送台账/变更历史）经同步端点往返 KV，Actions 运行器是无状态的
- **无推送渠道也能跑**：契约落地台账即对 App 可见，APNs/FCM/Expo 通道保留备用
- **自部署友好**：本地 API（`python -m trendradar.jingliu.api_server`）保留，可脱离云端独立调试

## 核心特性

| | |
|---|---|
| 🏷️ **命中理由** | 每条推送携带 hit_reason（关键词 / AI 理由 / 网页变更明细），拒绝"黑箱推送" |
| 🔁 **一次即止** | 内容指纹部分唯一索引——推过的不再推，低置信度不占指纹、后续可升级推送 |
| 📡 **多源监控** | 多平台热榜 + RSS + 任意网页变更监控（CSS 选择器、变更阈值、噪声掩码、冷却期）+ 抖音（RSSHub 路由） |
| 🧊 **防噪声** | 变更幅度阈值、六条噪声规则、同源冷却窗口、首次建基线不通知 |
| ☁️ **全云端** | GitHub Actions 定时跑 + Cloudflare Worker/KV 固定地址，终端设备零公网要求 |
| 📱 **安卓 App** | Claude 风格 UI、安全区适配、前台实时/后台轮询双通道、兴趣关键词手机直编、厂商保活跳转（OPPO/vivo/华为/小米） |
| 👍 **反馈闭环** | 有用/无用一键反馈（存 KV overlay），为"反哺兴趣调优"留好接口 |

## 仓库结构（相对上游的新增）

```
trendradar/jingliu/       契约构建/门控/台账、URL 监控调度、App API、云同步(cloud_sync)
trendradar/collectors/    webpage_monitor（网页 diff）、douyin_adapter（RSSHub 路由）
cloudflare-worker/        云后端：/api/*（App）+ /internal/*（Actions 同步），纯 JS + KV
mobile/                   安卓 App（Expo SDK 58 + RN 0.88，TS strict）
docs/jingliu-*.md         交接文档 / 设计方案 / 上游原版 README
```

上游同步说明与冲突点清单见 [docs/jingliu-handoff.md](docs/jingliu-handoff.md)。

## 快速开始（自部署）

```bash
git clone https://github.com/KTEC0230/TrendRadar.git
cd TrendRadar
uv sync && uv run pytest tests/ -q        # 后端基线：87 passed
cd mobile && npm install && npx tsc --noEmit   # App 类型检查
```

完整部署（R2/KV、Worker、GH Secrets、APK 构建）见 **[docs/jingliu-handoff.md](docs/jingliu-handoff.md)** —— 按文档从零到手机收推送。

## 致谢与许可

- 上游项目：[sansan0/TrendRadar](https://github.com/sansan0/TrendRadar)（[官网](https://trendradar.sandev.cc)）——本仓库的全部基础能力来自它
- 许可：**GPL-3.0**（随上游）
