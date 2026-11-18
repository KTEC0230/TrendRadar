# 静流（JingLiu）项目交接文档

> 更新：2026-11-15 ｜ 仓库：`C:\Users\27025\Desktop\github\TrendRadar`（fork，master）
> 读这份文档即可接手，无需翻阅历史对话。设计方案与勘察结论见 `docs/jingliu-refactor-plan.md`。

---

## 1. 项目定位与状态速览

**一句话**：在 TrendRadar（多平台热榜聚合）基础上做的外科手术式二次开发，改造为"推送即契约"的移动端信息筛选后端——每条推送自带命中理由，同一内容全生命周期只推一次。

| 模块 | 状态 | 说明 |
|------|------|------|
| 存储层（state 库） | ✅ 完成 | `output/state/state.db`，6 张表，跨日持久 |
| 契约层（PushContractBuilder） | ✅ 完成 | hit_reason 生成 + 三道门控 |
| URL 监控（WebpageMonitor + MonitorScheduler） | ✅ 完成 | 六条防噪声规则，端到端验证过 |
| 抖音适配器（DouyinAdapter） | ✅ 完成 | 仅 RSSHub 路由转换，路由可用性未实测 |
| APNs/FCM 直连推送 | ✅ 代码就绪 | 轮询架构下暂不需要，保留备用 |
| App HTTP API（本地） | ✅ 完成 | 13 个端点，冒烟 13/13；本地调试用 |
| **云后端（Worker + KV）** | ✅ 完成 | `cloudflare-worker/`，固定地址 `https://jingliu.ktec0230.de5.net`，全端点实测通过 |
| **云同步（cloud_sync）** | ✅ 完成 | GH Actions 每轮拉/回 state.db + feed.json，本地→Worker 实测通过 |
| AI 理由字段（LLM reason） | ✅ 完成 | prompt 已带可选字段；云端暂未配 AI_API_KEY，AI 筛选不生效（关键词/网页监控契约照常） |
| 安卓端 App（Expo，mobile/） | ✅ v2 改版完成 | Claude 风格 UI + 安全区适配 + 保活弹窗/跳转 + 兴趣编辑屏；APK 待重构建装机 |
| 摘要池定时推送（Digest） | ✅ 完成 | low 置信度契约攒批，按 interval_minutes 汇总一条推送 |

**测试基线**：`uv run pytest tests/` → 87 passed + 35 subtests（2026-11-15 复验）；移动端 `cd mobile && npx tsc --noEmit` 通过。

**云端架构（2026-11-15 起，手机不再依赖本机）**：

```
GH Actions crawler.yml（每小时 cron，试用版需每 7 天 Check In 一次）
  ├─ sync-in:  从 Worker 拉持久 state.db + 兴趣 overlay → 覆盖 config 文件
  ├─ Run crawler（jingliu.enabled=true，契约构建/监控/门控/落台账）
  └─ sync-out: state.db 回传 + feed.json（近 100 条契约 + 兴趣快照）上传
        ↓ 存 Cloudflare KV（namespace "jingliu"，id 2c70e679-…）
手机 App → https://jingliu.ktec0230.de5.net（Worker：/api/* 读 KV 合并反馈 overlay）
```

无推送渠道时契约照样落台账（`record_pushed` 空 channel 允许），App 轮询即所见。

---

## 2. 架构与关键文件

### 2.1 新增文件（静流专属，与上游无冲突）

```
trendradar/jingliu/
├── __init__.py              # 导出 PushContractBuilder 等
├── contracts.py             # 核心：契约构建 + 门控 + 台账（方案交付物 3）
├── monitor_scheduler.py     # URL 监控调度：run_due_cycle() 进程启动即扫描
├── api_server.py            # App REST API（stdlib http.server，零新依赖；本地调试用）
└── cloud_sync.py            # 云同步：sync-in/sync-out（GH Actions ↔ Worker/KV，stdlib 实现）

cloudflare-worker/          # 云后端（部署: cd cloudflare-worker && npx wrangler deploy）
├── worker.js                # /api/*（App，Bearer JINGLIU_API_TOKEN）+ /internal/*（GH 同步，Bearer JINGLIU_SYNC_TOKEN）；数据全存 KV
└── wrangler.toml            # KV 绑定 + 自定义域 jingliu.ktec0230.de5.net；secrets 两个见上

trendradar/collectors/
├── webpage_monitor.py       # URL 监控采集器（提取/规范化/diff/噪声掩码）
└── douyin_adapter.py        # 抖音 → RSSHub 路由 → RSSFeedConfig

trendradar/notifiers/
├── apns_notifier.py         # APNs HTTP/2（.p8 ES256 JWT）
├── fcm_notifier.py          # FCM HTTP v1（service account OAuth2）
└── expo_notifier.py         # Expo push 服务转发（**当前 App 未使用**——FCM 大陆不可用后 App 转轮询，通道保留备用）

mobile/                    # Expo SDK 58 安卓端 App（轮询+本地通知，tsc strict；推送流/设置/WorkManager 后台任务）

trendradar/storage/jingliu_schema.sql   # 6 张表 DDL（sources/push_contracts/webpage_diffs/devices）
```

### 2.2 修改过的现有文件（**上游同步时的冲突点**）

| 文件 | 改动性质 | 同步上游时 |
|------|---------|-----------|
| `trendradar/__main__.py` | 5 处小插入：`_has_notification_configured` 认可静流渠道、`_crawl_rss_data` 合并抖音源、`run()` 挂监控周期、`_send_notification_if_needed` 挂契约分发、`_run_jingliu_monitor_cycle` 尾部挂摘要推送 | ⚠️ 高危冲突区，重合并时逐段核对 |
| `trendradar/context.py` | `jingliu_enabled` 属性 + 3 个工厂 + `_get_jingliu_devices` | ⚠️ 同上 |
| `trendradar/core/loader.py` | `_load_jingliu_config` + load_config 一行 | 低 |
| `trendradar/core/config.py` | 未改 | — |
| `trendradar/notification/dispatcher.py` | `__init__` 加 `jingliu_device_provider` 参数 + `dispatch_contracts`/`_send_apns`/`_send_fcm`/`_resolve_jingliu_tokens` | ⚠️ 中 |
| `trendradar/storage/sqlite_mixin.py` | schema 加载分支 + `_migrate_ai_filter_schema` + 静流 `_impl` 方法约 15 个 + ai_filter_results reason 列读写 | ⚠️ 中（上游改 SQL 相关需留意） |
| `trendradar/storage/{base,local,remote,manager}.py` | 委托方法追加 | 低（纯追加） |
| `trendradar/ai/filter.py` / `filter_pipeline.py` | reason 字段解析/透传 + title_entry 加 relevance_score/reason | ⚠️ 中 |
| `trendradar/storage/ai_filter_schema.sql` | 加 reason 列 | ⚠️ 低（上游若改此文件需手动并） |
| `config/config.yaml` / `config/ai_filter/prompt.txt` | 追加 jingliu 段（enabled=true）/ reason 输出格式 | 低 |
| `README.md` | 已重写为静流项目定位（上游原版移至 `docs/README-upstream.md`） | ⚠️ 中：上游改 README.md 时同步冲突，一律保留 fork 版，把上游新内容手动并进 docs/README-upstream.md |
| `.github/workflows/crawler.yml` | 插入静流云同步两步（sync-in / sync-out，缺 secrets 自动跳过） | 低（纯插入） |
| `mobile/` | Expo App（v2：safe-area-context + intent-launcher + vector-icons 三个新原生依赖） | 无冲突（纯新增目录） |
| `pyproject.toml` | 4 个运行依赖 + pytest dev | 低 |
| `.gitignore` | 新建（原本没有，__pycache__ 全裸奔） | — |

**同步上游的操作纪律**：先 `git pull upstream master` 看冲突文件；`__main__.py` 的 4 处插入点都有 `# 静流：` 注释锚，逐个恢复；改完必须跑 `uv run pytest tests/ -q` + `uv run python "D:\K\zcode\tmp-jingliu-smoke\smoke.py"`。

### 2.3 一条推送的完整链路（函数级）

```
热榜/RSS/AI 路径（每次 trendradar 运行）：
NewsAnalyzer.run() (__main__.py)
  → _crawl_data / _crawl_rss_data            # 抓取入库（现有逻辑，未动）
  → _execute_mode_strategy → _run_analysis_pipeline
      → ctx.run_ai_filter()                   # AI 筛选（reason 落 ai_filter_results.reason 列）
  → _send_notification_if_needed
      → _dispatch_push_contracts(stats, rss_items)          # ← 静流入口①
          → PushContractBuilder.build_from_stats(...)        # 契约构建（hit_reason 取自本轮数据）
          → gate_and_rank()                                  # 三道闸（闸1 查 state.db.push_contracts）
          → dispatcher.dispatch_contracts()                  # APNs/FCM（静态 token + devices 表动态 token）
          → builder.record_pushed()                          # 写台账（UNIQUE 指纹判定在此收口）

URL 监控路径（独立，与 timeline.yaml 无关）：
NewsAnalyzer.run() → _run_jingliu_monitor_cycle()           # ← 静流入口②
  → MonitorScheduler.run_due_cycle()
      → sources 表到期扫描 → WebpageMonitor.check_source()   # 抓取/指纹/diff
      → 基线写 webpage_diffs；变更 → cooldown 判定（查最近推送时间）
      → PushContractBuilder.build_from_webpage_event() → gate → dispatch → record_pushed
```

---

## 3. 快速上手

```bash
cd C:\Users\27025\Desktop\github\TrendRadar
uv sync                                        # 安装依赖（含静流新增 4 个）
uv run pytest tests/ -q                        # 全量测试基线 75 passed
uv run python D:\K\zcode\tmp-jingliu-smoke\smoke.py        # 推送链路冒烟（无需凭据）
uv run python D:\K\zcode\tmp-jingliu-smoke\api_smoke.py    # API 冒烟
```

**启用静流**：`config/config.yaml` → `jingliu.enabled: true` + 配好推送渠道（见下节）。
**启动 API**：`uv run python -m trendradar.jingliu.api_server`（必须从仓库根目录跑——interests 文件与 output/ 是相对路径）。

---

## 4. 配置参考

### 4.1 config.yaml `jingliu:` 段（完整字段见仓库 config.yaml 末尾）

| 键 | 默认 | 说明 |
|----|------|------|
| `enabled` | false | 总开关；false 时全部静流逻辑零开销跳过 |
| `rsshub_base` | "" | RSSHub 实例地址，抖音源必填 |
| `webpage.min_change_chars` | 50 | 全局变更幅度阈值（`selector_config.min_change_chars` 源级覆盖） |
| `webpage.cooldown_minutes` | 15 | 同源两次推送的冷却窗口（按"最近推送时间"算，不是按检查时间） |
| `webpage.request_timeout` | 15 | 抓取超时秒数 |
| `apns.*` | — | team_id/key_id/key_file/bundle_id/production/device_tokens |
| `fcm.*` | — | project_id/credentials_file/device_tokens |
| `api.host/port/auth_token` | 127.0.0.1/8807/"" | API 服务；**auth_token 为空则拒绝启动** |
| `digest.enabled/interval_minutes/max_items/min_confidence` | false/240/10/low | 摘要池定时推送：到期把 pending 契约聚合为一条，送达后标记 channel=digest |
| `expo.enabled/device_tokens` | true/"" | Expo 通道（**当前 App 未使用**，保留备用）：经 exp.host 转发 FCM；安卓 App 已转"后台轮询+本地通知"架构（FCM 大陆网络不可用） |

### 4.2 环境变量（优先于 config，CI/容器友好）

`JINGLIU_ENABLED`、`JINGLIU_RSSHUB_BASE`、`APNS_TEAM_ID`、`APNS_KEY_ID`、`APNS_KEY_FILE`、`APNS_BUNDLE_ID`、`APNS_DEVICE_TOKENS`、`FCM_PROJECT_ID`、`GOOGLE_APPLICATION_CREDENTIALS`、`FCM_DEVICE_TOKENS`、`JINGLIU_API_HOST`、`JINGLIU_API_PORT`、`JINGLIU_API_TOKEN`

### 4.3 凭据获取（App 上线前必须做，当前均未验证）

- **APNs**：Apple Developer → Keys → 建 APNs Key（.p8），记 Key ID + Team ID；App 建 App ID 得 bundle_id；真机 token 由 App 端注册（或先手工填 device_tokens）
- **FCM**：Firebase 控制台 → 项目设置 → 服务账号 → 生成 JSON 私钥

---

## 5. App HTTP API 参考

启动：`python -m trendradar.jingliu.api_server`，鉴权 `Authorization: Bearer <JINGLIU_API_TOKEN>`（`/api/health` 免鉴权）。响应统一 JSON；状态码 ≥400 时服务端强制 `Connection: close`。

| 端点 | 说明 |
|------|------|
| `GET /api/health` | 探活（返回 backend 名） |
| `POST /api/devices` | 注册设备 `{channel: "apns"\|"fcm", device_token, device_name?}`；重复注册=刷新 last_seen |
| `GET /api/devices?channel=` / `DELETE /api/devices?channel=&device_token=` | 设备列表 / 注销 |
| `GET /api/contracts/recent?limit=` | 已推送契约倒序（App 推送流） |
| `GET /api/contracts/pending?min_confidence=&limit=` | 未推送契约（摘要池） |
| `POST /api/contracts/{id}/feedback` | `{feedback: "useful"\|"useless"\|""(清除)}` |
| `GET /api/sources?type=&status=` | 源列表（type 仅 webpage/douyin；hotlist/rss 不归本表管） |
| `POST /api/sources` | 注册源（webpage 需 config.url；douyin 需 config.route+参数；douyin check_interval 下限 30） |
| `GET/PUT/DELETE /api/sources/{id}` | 单查 / 部分更新（type 不可改）/ 删除（连带删 webpage_diffs） |
| `GET /api/interests` / `PUT /api/interests` | 读 / 写 `ai_interests.txt` 与 `frequency_words.txt`（写入前自动 .bak 备份） |

curl 示例：

```bash
TOKEN="你的token"; BASE="http://127.0.0.1:8807/api"

# 注册一个网页监控源（正文区域 #article-body，源级阈值 30 字符）
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/sources" \
  -d '{"type":"webpage","name":"某博客","config":{"url":"https://blog.example.com"},
       "selector_config":{"title_selector":"h1","body_selector":"#article-body",
                          "min_change_chars":30,"ignore_rules":["^广告"]},"check_interval":20}'

# App 首启注册设备
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/devices" \
  -d '{"channel":"apns","device_token":"<hex64>","device_name":"iPhone 15"}'

# 拉推送流 / 反馈
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/contracts/recent?limit=20"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/contracts/123/feedback" -d '{"feedback":"useful"}'
```

---

## 6. 数据库说明

- `output/state/state.db`（jingliu 专属，**不随日期清理**）：
  - `sources`：监控源注册（config/selector_config 为 JSON 列，读取时已反序列化）
  - `push_contracts`：推送台账。**核心约束**：部分唯一索引 `UNIQUE(content_fingerprint) WHERE pushed_at IS NOT NULL`——未推送的低置信度记录不占指纹，高置信度版本后续仍可推
  - `webpage_diffs`：变更历史，`diff_summary.blocks` 存全量块快照（下次 diff 的基线）
  - `devices`：App 动态注册的推送设备（channel=apns/fcm/expo；与 config 静态 device_tokens 合并、去重保序、`max_accounts_per_channel` 截断）
- `output/news/{date}.db`、`output/rss/{date}.db`：TrendRadar 原有按日期分库（`ai_filter_results` 新增了 `reason` 列，老库自动迁移）
- GH Actions（远程 S3 后端）下 state.db 以固定 key `state/state.db` 同步（`remote.py::_get_remote_db_key` 特例）

---

## 7. 已知限制与坑

1. **API 服务假设本地存储**：`api_server.py` 每请求新建 `LocalStorageBackend`（线程安全），远程 S3 后端不适用于 API 进程——API 面向 Docker/VPS 部署，这是有意设计
2. **必须从仓库根目录启动 API**：interests 文件（`config/ai_interests.txt`）与 `output/` 都是相对路径
3. **check_interval 低于进程调度周期时**：实际检查频率 = cron 周期（GH Actions 1 小时 / Docker 默认 30 分钟），监控不会更频繁
4. **抖音路由未实测**：RSSHub 的 douyin 路由在私有实例上可用性差异大，启用前先对 `rsshub_base + 路由` 做一次真实抓取验证；`user` 路由最稳，`search`/`live` 部分实例不支持
5. **AI reason 依赖模型自觉**：prompt 要求 ≤20 字理由但不强制；模型不输出时契约层自动降级为分数文案，无报错
6. **PUT /api/interests 直接覆盖 config 文件**：有 .bak 备份，但多实例部署时各副本不共享（单机部署无碍）
7. **APNs/FCM 未用真实凭据跑过**：代码路径有单测覆盖载荷构造，端到端发送待凭据配置后验证（第一步跑 `--test-notification` 风格的手工 curl）
8. **state.db 并发**：API 进程与 trendradar 主进程分属不同进程写同一 SQLite——低频写无碍，如遇 `database is locked` 可给连接加 `busy_timeout`（当前未加，见 sqlite_mixin 可挂点）
9. **smoke 脚本依赖**：`tmp-jingliu-smoke/` 在工作区（非仓库），重构后重跑前检查其引用路径
10. **FCM/Google 网络硬限制（架构转折点，2026-11-14 确诊）**：firebaseinstallations/mtalk.google.com/fcm.googleapis.com 在用户网络全部不可达 → Expo Go 安卓不支持远程推送 + APK 内 getToken 失败（IOException）。App 已转"WorkManager 后台轮询（≥15 分钟）+ 本地通知"：无 Google 依赖、火绒/网络无感、App 前台实时拉取。若未来网络环境变化，`push.ts`（git 历史）与后端 expo/fcm 通道可直接复用
11. **Expo Go 使用边界**：Expo Go（SDK 53+）安卓不支持远程推送，且本地通知渠道 API 在 Go 里可能 NPE——推送/通知相关验证一律用 EAS 构建的 APK；Expo Go 只适合 UI 与 API 联调
11. **App 与后端同网要求**：Expo Go 调试时手机需能访问后端地址（局域网/公网），http 明文已允许（自部署场景）

### 云架构专属坑（2026-11-15 实测）

12. **CF zone 的 Browser Integrity Check 按 UA 拦截**：`Python-urllib` UA 访问 `*.ktec0230.de5.net` 一律 403/1010（curl、okhttp/ReactNative 均放行）。`cloud_sync.py` 已统一伪装浏览器 UA；手机 App 与 curl 不受影响。**给这个 zone 写任何新脚本都要带浏览器 UA**
13. **KV 单值上限 25MiB**：state.db（当前 53KB）与 feed.json（16KB）都远小于上限；webpage_diffs 全量块快照会缓慢膨胀，若 state.db 涨到几十 MB 需要清理策略（Worker 会在 PUT 时 413 拒绝）
14. **KV 最终一致**：写后 ~60 秒内跨边缘读取可能拿旧值——App 每次轮询读到 1 分钟内的旧 feed 属正常
15. **反馈/兴趣存 overlay 不回写 DB**：手机上的反馈和兴趣编辑只存 KV overlay，管道台账里的 user_feedback 保持空——当前无功能依赖它读 DB（反馈反哺是未来路线）
16. **fork 的 Actions 要网页激活一次**：API 层面 enabled=true 但 run 会永远停在"pre-queue"（cancel 报 409 not queued yet）——必须在网页 Actions 标签点一次"I understand my workflows, go ahead and enable them"
17. **试用版 Check-In**：上游 crawler.yml 设计为每 7 天需在 Actions 页手动运行一次 "Check In" 工作流，否则 cron 自动停（推送静默中断）。上游本意是省资源；嫌烦可自行移除该机制（fork 自主）
18. **workers.dev 裸域名大陆不可达**：必须走自定义域 `jingliu.ktec0230.de5.net`（wrangler deploy 已自动建好 DNS 与证书；重部署时保持 wrangler.toml 里的 routes 段，注意 TOML 顶层键必须在 [[table]] 之前）

### 云化收尾补丁（2026-11-18 实测）

19. **契约分发门控 bug（3acecdb 修复）**：`_has_jingliu_push_configured` 原先要求 APNs/FCM 静态 token，云端轮询架构下热榜/RSS 契约从不生成（网页监控契约走 MonitorScheduler 独立路径才掩盖了它）。现语义：jingliu_enabled 即视为已配置。改 `__main__.py` 时保留「静流：」注释锚
20. **GH Actions 调度故障**：本仓库所有运行卡 pre-queue（jobs=0、cancel 报 409 not queued yet、rerun 报 already running），`disabled_fork` 已 API 强制 active、workflow 文件改名（crawler.yml→hotnews.yml，新 id 421526100）也无效，GitHub 状态页 operational——疑账号/仓库级调度异常。**兜底已上线**：本机计划任务 `JingLiuPipeline`（schtasks，每小时，SYSTEM 账户跑 start-pipeline.bat：sync-in→管道→sync-out，日志 output/pipeline-cron.log）。撤销命令：`schtasks /delete /tn "JingLiuPipeline" /f`。bat 与 start-api.bat 同为 gitignore 凭据文件
21. **正式版闪退档案**：①缺 react peer（5474041）②缺 expo-font（fe1ab3d）③**R8 混淆裁掉 expo-device 原生模块**——SDK 58 模板默认 `enableMinifyInReleaseBuilds=true`，已用 expo-build-properties `android.enableMinifyInReleaseBuilds=false` 关闭（daf7632）。诊断手法=下载 EAS APK 解剖 dex 探针 `com/xxx` 斜杠类名（dex 类名是斜杠分隔勿用点号）；2026-11-17 独立版装机验收通过，全部原生模块在包
22. **本地定时任务的编码坑**：bat 文件禁写中文（cmd 按 GBK 解析 UTF-8 中文注释会把行解析成命令）；HTML 报告自动弹窗用 `GITHUB_ACTIONS=true` 环境变量抑制（上游原生支持，副作用=不使用代理，本机爬取无碍）
23. **App v3（2026-11-18）**
24. **v4（2026-11-18）**：FeedScreen 翻页漂移修复（pageWidth 必须 ScrollView onLayout 实测，Dimensions 硬编码比组卡内容区宽 28px 致吸附错位累积）；热榜 Tab（cloud_sync 导出 rank_history 窗口函数趋势 + Worker /api/hotlist）；/api/report?token=（Custom Tabs 加不了请求头，query 鉴权）；兴趣页筛选语法卡。SDK 58 顶层 splash 字段废弃→expo-splash-screen 插件
25. **v5（2026-11-18）**：信息源自助管理——KV overlay `sources_config.json` 单一真源（disabled_platform_ids/disabled_feed_ids/extra_feeds），loader 静流锚点 `_apply_jingliu_sources_overlay` 应用（不改 config.yaml 本体避 dump 丢注释）；sync-in 拉 overlay→写 output/state/；sync-out 导出 sources_catalog（yaml 直读原始小写结构）；Worker /api/sources-config。E2E 实测：停用贴吧→热榜消失、停用雅虎财经+注入测试 RSS→2 源抓取成功。App 5 Tab 新增源管理屏（版本 0.4.0）
26. **App v0.4.1（2026-11-19，对照官方模块化结构复查）**：src/api.ts → src/api/ 分域（桶导出保持 `from "../api"` 兼容）；src/components/ 抽出 GroupCardShell/ToggleRow/StatusLine/CenterLoading；重卡片 React.memo + removeClippedSubviews；安卓返回键=非推送流先回推送流；warmUpAsync 预热 Custom Tabs（注意：SDK 58 的 expo-web-browser 是 `warmUpAsync` 不是 `warmUp`）：①图标=PIL 程序绘制（生成脚本 D:\K\zcode\gen_icon.py，超采样贝塞尔水滴；dex 排查教训：dex 类名是 `com/xxx` 斜杠格式）②FeedScreen 信息源分组+横向翻页（platform_name 聚合组卡）③链接走 expo-web-browser（Custom Tabs）。④SDK 58 顶层 `splash` 字段已废弃，启动屏归 expo-splash-screen 插件管：bat 文件禁写中文（cmd 按 GBK 解析 UTF-8 中文注释会把行解析成命令）；HTML 报告自动弹窗用 `GITHUB_ACTIONS=true` 环境变量抑制（上游原生支持，副作用=不使用代理，本机爬取无碍）

---

## 8. 路线图（建议顺序）

1. ~~安卓真机联调~~（**已完成 2026-11-14**：dev client 装机、端到端通知验证通过——页面变更→契约→手机弹通知"网页标题从『标题 A』变为『标题 B』"）
2. ~~固定地址~~（**已完成 2026-11-15，方案升级**：放弃隧道，整体云化——GH Actions 跑管道 + Worker/KV 固定地址 `https://jingliu.ktec0230.de5.net`，电脑关机不影响手机拉取）
3. ~~厂商后台限制~~（**已完成 2026-11-15**：App 首启弹窗 + 设置页「后台保活」区，电池优化白名单弹窗直达 + OPPO/vivo/华为/小米自启动跳转逐级兜底）
4. ~~App v2 装机验收~~（**完成 2026-11-17**：preview 独立版装机，用户确认主要功能一切正常。三轮排雷：误装 development 版（Error loading app）→ 缺 expo-font → R8 混淆裁 expo-device，见坑 21）
5. **定时管道**（部分受阻）：GH Actions 调度故障未解（坑 20），**兜底=本机计划任务 JingLiuPipeline 每小时跑**（sync-in→管道→sync-out，2026-11-18 实测 54 条契约入云端）。GH 恢复后撤兜底即回归纯云端
6. **摘要推送体验**：后端 `jingliu.digest.enabled: true`，观察 low 置信度契约的攒批摘要（App 通知流会呈现）
7. **反馈反哺**：统计 useless 高发的 interest，提示用户调整兴趣描述（App 端按钮已就绪；云架构下 overlay 数据在 KV 里可查）
8. **上游同步**：见 2.2 冲突点清单；mobile/、cloudflare-worker/ 为新增目录无冲突风险
9. **可选**：配 AI_API_KEY secret 让 AI 筛选生效；嫌弃试用版 Check-In 机制可移除（fork 自主）
