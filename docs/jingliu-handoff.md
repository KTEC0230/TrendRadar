# 静流（JingLiu）项目交接文档

> 更新：2026-11-28 ｜ 仓库：`C:\Users\27025\Desktop\github\TrendRadar`（fork of sansan0/TrendRadar，master）
> App 版本 0.5.0 ｜ 读这一份即可接手。上游原版说明在 `docs/README-upstream.md`，设计方案在 `docs/jingliu-refactor-plan.md`。

---

## 1. 一句话与状态速览

**一句话**：在 TrendRadar（多平台热榜聚合）上的二开，做成「推送即契约」的个人信息哨兵——每条推送自带命中理由、同一内容全生命周期只推一次。**云端全链路已上线，手机 App 已装机验收（用户满意），电脑关机不影响手机。**

| 模块 | 状态 | 说明 |
|------|------|------|
| 云端 Worker API（`jingliu-api`） | ✅ 生产运行 | 固定地址 `https://jingliu.ktec0230.de5.net`，数据全存 Cloudflare KV |
| 管道定时任务 | ✅ 运行中（本机兜底） | **GH Actions 调度故障未解**（见坑 G1），兜底=本机计划任务每小时跑 |
| 推送链路 | ✅ | 契约落台账 → App 轮询 → 本地通知（无 Google 依赖） |
| 安卓 App（mobile/，Expo 58） | ✅ v0.5.0 装机验收 | 图标/分组翻页/热榜/源管理/兴趣/报告/文章页；**本地 Docker 构建**出包 |
| AI 筛选 | ⏳ **只差 key** | 模型已配（deepseek-v4-flash），等用户提供 DeepSeek key → GH secret `AI_API_KEY` + bat 加行 |
| 摘要池（digest） | ✅ 已开启 | 4h 攒批低置信度；攒够第一批后推送流出现汇总条目 |
| 报告历史 | ✅ | 云端 8 份+索引，App 热榜页「报告」按钮 |
| 网页监控源管理 | ✅ App 化 | 源 Tab 第三区，overlay→state.db upsert 闭环实测 |
| README | ✅ | 已重写为静流定位（上游原版移至 docs/README-upstream.md） |

**测试基线**：`uv run pytest tests/ -q` → **87 passed + 35 subtests**（每次改后端必跑）。App：`npx tsc --noEmit` + `npx expo-doctor` 20/20。

---

## 2. 架构（数据怎么流）

```
【管道】本机计划任务 JingLiuPipeline（schtasks 每小时，SYSTEM 账户跑 start-pipeline.bat）
  ├─ sync-in   ：从 Worker 拉持久 state.db + 兴趣 overlay + 信息源 overlay + 网页监控 overlay → 写入工作目录
  ├─ trendradar：抓热榜/RSS/网页监控 → 关键词/AI 筛选 → 契约构建 + 三道门控 → 落台账 state.db
  └─ sync-out  ：state.db 回传 + feed.json（100 契约+热榜 255 条+目录+网页源实况）+ 报告（current+历史 10 份）
         ↓ 存 Cloudflare KV（namespace "jingliu"，id 2c70e679-…）
【App】手机 → https://jingliu.ktec0230.de5.net（Worker，Bearer 鉴权）
  前台 30s 实时拉 + WorkManager 15min 兜底 → 本地通知
```

- 电脑关机：手机仍能看云端已有数据；无新增（GH Actions 修好前）
- 无推送渠道时契约照样落台账（channel 空串），App 轮询即所见——这是 `_has_jingliu_push_configured` 修复后的语义（3acecdb）
- 本地 API（start-api.bat，127.0.0.1:8807）仅本地调试用，与生产无关

---

## 3. 关键文件地图

```
trendradar/jingliu/
├── contracts.py          契约构建+三道门控+台账（核心）
├── monitor_scheduler.py  网页监控调度（独立于热榜 timeline）
├── api_server.py         本地调试 API（13 端点，生产不用）
└── cloud_sync.py         云同步：sync-in/sync-out（stdlib；overlay 应用+feed 导出+报告上传）
trendradar/core/loader.py 静流锚点×2：jingliu 配置段 + _apply_jingliu_sources_overlay（App 源开关生效点）
config/config.yaml        jingliu.enabled=true、digest.enabled=true、AI 模型 deepseek/deepseek-v4-flash
.github/workflows/hotnews.yml  （crawler.yml 改名——绕 fork 调度卡死；**调度故障未解，从未成功跑过**）
cloudflare-worker/        worker.js + wrangler.toml（App API + /internal 同步通道；改完 wrangler deploy）
mobile/                   Expo 58 + RN 0.88 + TS strict
├── src/api/              分域：types/client/contracts/hotlist/interests/sources + index 桶导出
├── src/components/       GroupCardShell/ToggleRow/StatusLine/CenterLoading
├── src/screens/          FeedScreen(分组翻页)/HotlistScreen(趋势+报告列表)/SourcesScreen(三类源)/Interests/Settings
├── src/article.tsx       App 内文章页（react-native-webview 全屏，替代 Custom Tabs）
├── src/keepalive.ts      电池白名单/自启动跳转（OPPO/vivo 组件清单）
├── android/              **已入库（bare workflow）**：含签名配置；用 expo prebuild 重生成会丢签名改动
└── credentials-local/    jingliu-release.keystore（gitignore；密码在 ~/.gradle/gradle.properties）
docs/jingliu-handoff.md   本文档（每次任务必更新）
start-api.bat             本地调试 API 启动（token 在内，gitignore）
start-pipeline.bat        兜底管道启动（凭据在内，gitignore；schtasks 引用它）
```

---

## 4. 日常运维手册

| 要做什么 | 怎么做 |
|---|---|
| 查手机为什么没新内容 | `schtasks /query /tn "JingLiuPipeline"` 确认任务在；看 `output/pipeline-cron.log` 尾部 |
| 手动跑一轮管道 | `cd TrendRadar && cmd //c start-pipeline.bat`（日志 output/pipeline-cron.log） |
| 出正式 APK | `MSYS_NO_PATHCONV=1 docker run --rm -v "C:\Users\27025\Desktop\github\TrendRadar\mobile:/w" -v "D:\K\zcode\jl-builder\gradle-props:/root/gradle-props" -v "jingliu-gradle-home:/root/.gradle-home" -e GRADLE_USER_HOME=/root/.gradle-home -w /w/android jingliu-builder bash -c "cp /root/gradle-props/gradle.properties /root/.gradle-home/gradle.properties && ./gradlew assembleRelease --no-daemon"`（产物 mobile/android/app/build/outputs/apk/release/；Docker Desktop 须在运行） |
| 改 Worker/加端点 | 编辑 cloudflare-worker/worker.js → `cd cloudflare-worker && npx wrangler deploy` |
| 撤掉本机兜底（GH 修好后） | `schtasks /delete /tn "JingLiuPipeline" /f` + 删 start-pipeline.bat |
| App 装机 | 本地构建产物直接装；⚠️ v0.5.0 起签名换新证书，从 EAS 旧版升级需**卸载重装**一次 |

**凭据位置**（全部不入库）：GH Secrets（JINGLIU_WORKER_URL/JINGLIU_SYNC_TOKEN）、Worker secrets（JINGLIU_API_TOKEN/JINGLIU_SYNC_TOKEN，wrangler secret）、`D:\K\zcode\.jingliu-sync-token`（sync token 明文）、`~/.gradle/gradle.properties`（签名密码）、start-api.bat/start-pipeline.bat（token 内嵌）。

---

## 5. Worker API 端点全集（jingliu-api @ jingliu.ktec0230.de5.net）

| 端点 | 鉴权 | 说明 |
|---|---|---|
| GET /api/health | 免 | 探活，返回 backend:"worker-kv" |
| GET /api/contracts/recent?limit= | Bearer | 推送流（feed.json + 反馈 overlay 合并） |
| POST /api/contracts/:id/feedback | Bearer | 反馈 useful/useless/空=清除（KV overlay） |
| GET /api/hotlist | Bearer | 今日热榜（platforms[].items[].trend/delta） |
| GET /api/reports | Bearer | 历史报告索引（≤10 份） |
| GET /api/report | query token | 今日报告 HTML（current.html） |
| GET /api/report/file/<name> | query token | 历史报告 HTML（WebView/浏览器直接开） |
| GET /api/interests / PUT | Bearer | 兴趣文件（KV overlay；sync-in 回写 config） |
| GET /api/sources-config / PUT | Bearer | 热榜平台/RSS overlay + catalog |
| GET /api/webpage-sources / PUT | Bearer | 网页监控 overlay + state.db 实况 |
| /internal/state.db、feed.json、report.html、report/<name>、report-index、sources-config、webpage-sources、interests | Bearer **SYNC** | 仅 GH/本机管道同步用；无 overlay 的 GET 返回 404 |

KV 键位：`state.db`、`feed.json`、`feedback`、`interests:ai_interests`、`interests:frequency_words`、`sources_config.json`、`webpage_sources.json`、`report.html`、`report_index.json`、`report/<name>.html`。

---

## 6. 坑清单（按主题合并；**接手前必读**）

### G. 全局/部署坑
- **G1 GH Actions 调度故障（未解）**：本仓库所有 run 卡 pre-queue（jobs=0、cancel 报 409 not queued yet、rerun 报 already running；状态页 operational）。已试：API 强制 enable、crawler.yml→hotnews.yml 改名重注册、删僵尸 run——均无效。**兜底=本机 schtasks JingLiuPipeline**。恢复后撤兜底
- **G2 试用版 Check-In**：上游 hotnews.yml 7 天不点 Check In 定时任务自停（网页 Actions 手动跑 Check In 工作流续期）；嫌烦可移除机制（fork 自主）
- **G3 CF zone ktec0230.de5.net 按 UA 拦 Python-urllib**（403/1010）：给此 zone 写脚本必带浏览器 UA；curl/okhttp/ReactNative 放行
- **G4 KV 单值 25MiB 上限**；KV 最终一致 ~60s；workers.dev 裸域名大陆不可达（必须自定义域）

### P. 管道坑
- **P1 loader 是大写键展开 dict**——直接 yaml.dump 会丢小写段；要改 config 结构必须用 yaml 直读原始小写（cloud_sync._build_sources_catalog 是范例）
- **P2 bat 文件禁写中文**（cmd 按 GBK 解析 UTF-8 会把注释行当命令执行）；HTML 报告自动弹窗用 `GITHUB_ACTIONS=true` 环境变量抑制
- **P3 契约门控**：`_has_jingliu_push_configured` 已改为「jingliu_enabled 即视为已配置」——别再让它要求 APNs/FCM token，否则热榜/RSS 契约静默消失（网页监控契约走 MonitorScheduler 独立路径，曾掩盖此 bug）
- **P4 信息源 overlay 三件套**（interests/sources_config/webpage_sources）：App 写 KV → sync-in 落 output/state/ → loader/应用脚本生效。overlay 是唯一真源，**不改 config.yaml 本体**（dump 丢注释）；网页源按 config.url upsert，app_managed 标记的才随 overlay 删除

### A. App 坑
- **A1 闪退档案**（正式版无声闪退→查 expo-doctor + 解剖 APK）：①缺 react peer ②缺 expo-font（@expo/vector-icons 的原生 peer）③**R8 混淆裁掉 expo-device**——SDK 58 模板默认 `enableMinifyInReleaseBuilds=true`，已用 expo-build-properties `android.enableMinifyInReleaseBuilds=false` 根治；**android/ 已入库，勿再用 prebuild --clean 重生成**（会丢签名配置）
- **A2 dex 探针类名是 `com/xxx` 斜杠格式**（点号全误报）；APK 解剖是定位闪退的最快手段
- **A3 两个 profile 别混**：eas `development`=dev client 外壳（须 PC 开 expo start）；`preview`/本地构建=独立版。误装 development 版 → "Error loading app"
- **A4 SDK 58 顶层 `splash` 字段已废弃** → expo-splash-screen 插件；`warmUpAsync` 不是 `warmUp`
- **A5 edge-to-edge 下 RN 内置 SafeAreaView 无效** → 用 react-native-safe-area-context；翻页组件 pageWidth 必须 ScrollView onLayout 实测（Dimensions 硬编码会漂移）

### B. 构建坑
- **B1 Windows 直编死路**：ninja 不认长路径（260 硬上限，.cxx/codegen 目标必超；junction/注册表 LongPathsEnabled 都救不了，gradle 会 canonicalize 回真实路径）→ **必须 Docker Linux 容器**（命令见 §4）
- **B2 容器构建三坑**：Git Bash 加 `MSYS_NO_PATHCONV=1`；挂载文件要用「目录级挂载再 cp」；**容器构建前必须清 Windows 残留**（android/build、app/build、app/.cxx 里有 Windows 路径的 autolinking 缓存，不清会 configure 报 /w/android/C:/Users/... 不存在）
- **B3 签名**：releaseLocal 配置读 ~/.gradle/gradle.properties 的 RELEASE_*；**新证书 CN=JingLiu 与 EAS 签名不兼容**——EAS 旧版升级到本地包必须卸载重装

### D. 数据坑
- **D1 state.db 部分唯一索引**（仅已推送行占指纹）；冷却期按「最近推送时间」判定
- **D2 反馈/兴趣/源开关存 KV overlay，不回写 state.db/config**——管道侧 overlay 是真源
- **D3 feed.json 体积**：契约 100 条 + 热榜 255 条 ≈ 190KB，报告 150KB/份（KV 余量充足）

---

## 7. 路线图（未完成）

1. **AI key 接线**（等用户提供 DeepSeek key）：GH secret `AI_API_KEY` + start-pipeline.bat 加行 → AI 筛选/AI 理由/分析/翻译全活
2. **GH Actions 调度故障**：持续观察（或开 GH support ticket）；修好后撤本机兜底
3. 摘要池观察：首批 digest 汇总条目出现后验证体验
4. 网页监控实战：用户在 App 加第一个真实监控源后验证闭环
5. 远期可选：抖音源（需 RSSHub 实例）、报告 KV 老文件清理、App 内搜索

## 8. 交接纪律

- **每次任务结束必更新本文档**（状态表/坑/路线图）并 git commit（中文 conventional，不 push 除非明说/必要）
- 后端改动必跑 `uv run pytest tests/ -q`（87 基线）；App 改动必跑 `npx tsc --noEmit` + `npx expo-doctor`
- 用户是中文小白：决策点用聊天文字问（弹窗辅助）；端到端代办；产出物给可直接复制的路径/命令
- 上游同步：mobile/、cloudflare-worker/、jingliu/ 为纯新增无冲突；`__main__.py`/`loader.py`/`dispatcher.py`/config.yaml/README.md 是冲突高危区（改前看各处「静流：」锚点）
