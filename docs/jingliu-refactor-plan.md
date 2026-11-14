# 「静流」改造方案 —— 基于 TrendRadar 的"推送即契约"后端

> 勘察基线：`C:\Users\27025\Desktop\github\TrendRadar`（fork，master @ 8a31662，上游 v6.11.0）。
> 本文所有行号均来自对该仓库源码的实际阅读；与任务前置认知不符之处，一律以源码为准并显式标注。

---

## 实施记录（2026-11-14，全部落地）

本方案已完整实施并通过验证：

- **测试**：`uv run pytest tests/` → 65 passed（原有套件零回归）+ 新增 3 个测试文件：
  `tests/test_push_contracts.py`（契约构建/门控/台账，13 例）、
  `tests/test_webpage_monitor.py`（规范化/掩码/diff/基线三态，14 例）、
  `tests/test_state_store.py`（state 库 schema+CRUD 集成，4 例）。
- **端到端冒烟**：`D:\K\zcode\tmp-jingliu-smoke\smoke.py`（本地 HTTP 静态页 5 轮验证）10/10 通过——
  基线不推 / 变更推送（hit_reason="网页标题从『标题 A』变为『标题 B』"）/ 无变更零推 /
  冷却跳过 / 纯噪声零事件 / 台账唯一。
- **与方案的偏差**（源码落地时的修正）：
  1. `push_contracts` 唯一索引改为**部分唯一**（仅 `pushed_at IS NOT NULL` 行）——未推送的
     低置信度记录不占用指纹，高置信度版本后续仍可推送；
  2. 冷却期判定以"该源**最近一次推送时间**"为准（新查询 `get_last_contract_pushed_at`），
     而非最后一次 diff 时间——否则基线建库会误杀首次变更（冒烟验证抓出的 bug）；
  3. `min_change_chars` 支持源级覆盖（`selector_config.min_change_chars`），随契约进入
     门控闸 3，全局 50 仅作兜底；
  4. HTML 解析依赖选用 `beautifulsoup4`（方案中的 trafilatura 未引入，减小依赖面）；
  5. `dispatcher.dispatch_contracts` 接收契约对象（duck-typing `to_notification_payload()`），
     APNs/FCM 渠道函数遵循 senders.py 约定（输入载荷 → bool）。
- **新增依赖**：`httpx[http2]`、`PyJWT`、`cryptography`、`beautifulsoup4`（dev: pytest）。
- **使用入口**：`config.yaml` 追加 `jingliu:` 段（默认 disabled）；网页源注册走
  state 库 `sources` 表（type=webpage，config.url + selector_config）；抖音源走
  `DouyinAdapter.make_source_record` + `rsshub_base`。

---

## 交付物 1：源码勘察结论

### 1.1 与前置认知不符的事实（必须先纠正，方案据此落地）

| # | 前置认知 | 源码实际 | 证据 |
|---|---------|---------|------|
| 1 | 内部数据结构是 `ContentItem` | **不存在 `ContentItem`**。热榜条目是 `NewsItem`，RSS 条目是 `RSSItem`；集合容器 `NewsData` / `RSSData` | `trendradar/storage/base.py:14-67`（NewsItem）、`base.py:70-120`（RSSItem）、`base.py:177-296`（NewsData）、`base.py:123-174`（RSSData）。全仓库 grep `ContentItem` 零命中 |
| 2 | Notifier 有基类/协议抽象 | **没有**。接口是"模块级函数 + Dispatcher 约定"：`senders.py` 提供 9 个 `send_to_*` 函数，`NotificationDispatcher.dispatch_all()` 按配置逐渠道调用 | `trendradar/notification/senders.py:96/230/346/473/588/747/938/1100/1206`（feishu/dingtalk/wework/telegram/email/ntfy/bark/slack/generic_webhook）；`trendradar/notification/dispatcher.py:248-363`（dispatch_all）、`dispatcher.py:365`（_send_to_multi_accounts） |
| 3 | `AppContext` 是依赖注入容器 | 是**配置访问器 + 懒加载工厂**，非容器。存储/调度器为懒加载单例；Dispatcher 与 AI 筛选管线**每次调用新建** | `trendradar/context.py:47`；单例工厂 `get_storage_manager()`（context.py:183-209）、`create_scheduler()`（481-498）；每次新建 `create_notification_dispatcher()`（465-479）、`_get_ai_filter_pipeline()`（502-507） |
| 4 | DataFetcher 返回内容条目 | 返回**以 title 为键的三层 dict**：`{platform_id: {title: {ranks, url, mobileUrl}}}`，经 `convert_crawl_results_to_news_data` 才变成 `NewsItem` | `trendradar/crawler/fetcher.py:203-221`；`trendradar/storage/base.py:530-586` |
| 5 | Issue #1007：incremental 下"只标记 is_new 未真正过滤" | **本仓库已存在真实过滤**：`convert_to_report_data` 在 incremental 分支 `if mode == "incremental" and not is_new: continue`。该逻辑随 fork 内提交 `4df2318`（v6.10.0 模块拆分重构）引入 | `trendradar/ai/filter_pipeline.py:549-558`；git log `-S 'if mode == "incremental" and not is_new'` 仅命中 4df2318 |
| 6 | 存储是单一 SQLite | 本地**按日期分库**：`output/news/{date}.db`、`output/rss/{date}.db`；远程后端按日期 key 下载/上传整个 .db；`cleanup_old_data` 会删除过期 .db 文件 | `trendradar/storage/local.py:82-100`、`local.py:400-446`；`trendradar/storage/remote.py:152-171/211-257/271` |
| 7 | Docker 是常驻进程 | **不是**。`entrypoint.sh` 用 supercronic 定时拉起短命进程 `python -m trendradar`（默认 `*/30 * * * *`）；GH Actions `crawler.yml` 亦为每小时单次 cron（`timeout-minutes: 15`） | `docker/entrypoint.sh`（RUN_MODE=cron 分支）；`.github/workflows/crawler.yml:34` |
| 8 | AI 筛选已有"命中理由" | **没有**。LLM 分类只回传 `{news_item_id, tag_id, relevance_score}`（`classify_batch` 注释与解析均无 reason 字段）；`ai_filter_results` 表也只有 `relevance_score` | `trendradar/ai/filter.py:310-326, 386-520`；`trendradar/storage/ai_filter_schema.sql:28-38` |

### 1.2 交付物要求的四项勘察结论

**(a) `ContentItem`（实为 `NewsItem`）字段定义**

`NewsItem`（`trendradar/storage/base.py:14-31`）字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `title` | str | 标题 |
| `source_id` | str | 来源平台 ID |
| `source_name` | str | 来源名称（运行时用，不入库） |
| `rank` / `ranks` | int / List[int] | 当前排名 / 历史排名 |
| `url` / `mobile_url` | str | 链接 |
| `crawl_time` | str | HH:MM 抓取时间 |
| `first_time` / `last_time` | str | 首次/最后出现时间 |
| `count` | int | 出现次数 |
| `rank_timeline` | List[Dict] | 排名时间线（rank=None 表示脱榜） |

RSS 对应 `RSSItem`（base.py:70-87）：`title/feed_id/feed_name/url/guid/published_at/summary/author/crawl_time/first_time/last_time/count`。
**扩展约定**：新源类型不修改这两个 dataclass 的现有字段；URL 监控走独立的 `WebpageChangeEvent` 数据类（见交付物 3），不入 `news_items` 表，避免破坏热榜解析（`fetcher.py:203-221` 的 title 键控逻辑）。

**(b) Notifier 接口抽象方式**

约定式接口，三要素：
1. 渠道发送函数：模块级函数，签名 `(渠道配置值, report_data, report_type, update_info, proxy_url, mode, account_label, *, batch_size, ..., rss_items, rss_new_items, ai_analysis, display_regions, standalone_data) -> bool`（ Bark 参考实现 `senders.py:938-955` 的签名；载荷构造见 `senders.py:1041-1048`，Bark 走 APNs、4KB 限制检查在 `senders.py:1034-1038`）；
2. 分发器：`NotificationDispatcher`（`dispatcher.py:43`），构造参数 `(config, get_time_func, split_content_func, translator)`（`dispatcher.py:51-71`）；`dispatch_all` 内每个渠道一段 `if self.config.get("XXX")` 调用（`dispatcher.py:299-361`）；
3. 多账号：`;` 分隔 + `parse_multi_account_config` / `validate_paired_configs` / `limit_accounts`（`trendradar/core/config.py:11/40/97`）。
**APNs/FCM 新渠道必须复刻这套约定**（函数 + dispatcher 分支 + 多账号解析），而不是发明抽象基类。

**(c) `DataFetcher` 调用点与返回结构**

- 唯一生产调用点：`NewsAnalyzer._crawl_data()`（`__main__.py:947-986`），在 `run()`（1611-1638）中于 RSS 抓取（`_crawl_rss_data`，988-1088）之前执行；
- `crawl_websites(ids_list, request_interval, domain_rules)`（`fetcher.py:153-238`）：**串行 for 循环**（175 行起），逐平台 `fetch_data`（86-151，requests 同步 + 重试），返回 `Tuple[results, id_to_name, failed_ids]`；
- `results` 结构：`{platform_id: {title: {"ranks": [排名...], "url": str, "mobileUrl": str}}}`（203-221）；
- 下游：`convert_crawl_results_to_news_data`（base.py:530）→ `storage_manager.save_news_data`（`__main__.py:978`）→ `_save_news_data_impl`（`sqlite_mixin.py:140-341`，按 url+platform_id 去重，写 rank_history）。
- RSS 侧平行结构：`RSSFetcher.fetch_all()`（`crawler/rss/fetcher.py:174`）→ `RSSData` → `save_rss_data` → `_process_rss_data_by_mode`（`__main__.py:1090-1263`）。

**(d) `AppContext` 中与新增模块相关的服务注册位置**

| 服务 | 位置 | 生命周期 | 新模块接入方式（照抄此模式） |
|------|------|---------|------------------------------|
| 存储管理器 | `context.py:183-209` `get_storage_manager()` | 懒加载单例 | 新增 `get_state_store()` 懒加载单例 |
| 调度器 | `context.py:481-498` `create_scheduler()` | 懒加载单例 | 新增 `get_monitor_scheduler()` 懒加载单例 |
| 通知分发器 | `context.py:465-479` `create_notification_dispatcher()` | 每次新建 | 复用（在其中追加 `dispatch_contracts()`） |
| AI 筛选管线 | `context.py:502-516` `_get_ai_filter_pipeline()` / `run_ai_filter()` / `convert_ai_filter_to_report_data()`（518-528） | 每次新建 | 契约构建器仿照此模式：`get_push_contract_builder()` |

### 1.3 主流程调用链与插入点（改造的锚点）

```
main() (__main__.py:1641)
└─ NewsAnalyzer.run() (1611-1638)
   ├─ _crawl_data() (947) ─── DataFetcher.crawl_websites(966) → save_news_data(978)
   ├─ _crawl_rss_data() (988) ─ RSSFetcher.fetch_all(1067) → save_rss_data(1073)
   └─ _execute_mode_strategy() (1391)
      ├─ Scheduler.resolve() (1405-1406) → report_mode/filter_method/interests_file 覆盖 (1409-1424)
      ├─ detect_new_titles() (1433)
      └─ _run_analysis_pipeline() (652-790)
         ├─ filter.method==ai: ctx.run_ai_filter() (676) → convert_ai_filter_to_report_data() (681-684)
         ├─ else: ctx.count_frequency() (695/702)   [count_word_frequency: core/analyzer.py:93]
         └─ generate_html (766)
      └─ _send_notification_if_needed() (792-923)
         └─ dispatcher.dispatch_all() (876-888)
```

AI 筛选管线内部（Issue #1007 相关）：`AIFilterPipeline.run()`（`filter_pipeline.py:64-172`）第 8 步**拉取当日全部 active 结果** `get_active_ai_filter_results`（158 行；SQL 在 `sqlite_mixin.py:1581-1716`，JOIN news_items/rss_items，无批次过滤）；`convert_to_report_data()`（473-626）做 current 下榜过滤（515-518）、min_score 过滤（520-523）、is_new 标记（544-555）与 incremental 过滤（557-558）。

存储 schema：`schema.sql`（news_items/platforms/title_changes/rank_history/crawl_records/crawl_source_status/period_executions，其中 `news_items` 以 url+platform_id 部分唯一索引去重，schema.sql:111-112）、`rss_schema.sql`（rss_feeds/rss_items/rss_crawl_records/rss_crawl_status/rss_push_records）、`ai_filter_schema.sql`（三表）。建表模式：`.sql 文件 + CREATE TABLE IF NOT EXISTS`，由 mixin 在连接初始化时执行（`sqlite_mixin.py:71-96`）。

---

## 交付物 2：模块变更清单

> 开关约定：新增顶层配置 `jingliu.enabled`（loader 解析为 `config["JINGLIU"]`）。开关关闭时，所有修改点行为与现状逐字节一致——这是"不破坏三种部署"的兜底。

| # | 文件路径 | 类型 | 职责 | 依赖现有模块 | 是否动现有测试 |
|---|---------|------|------|-------------|----------------|
| 1 | `trendradar/jingliu/__init__.py` | 新建 | 静流层包入口，导出 PushContractBuilder / MonitorScheduler | — | 否 |
| 2 | `trendradar/jingliu/contracts.py` | 新建 | **PushContractBuilder**：hit_reason 生成、置信度、fingerprint 门控、跨源去重（交付物 3、4 的落点） | `jingliu.state_store`、`core/config.py`（多账号工具不需要） | 否（新增 `tests/test_push_contracts.py`） |
| 3 | `trendradar/jingliu/state_store.py` | 新建 | `StateStoreMixin`：`output/state/state.db` 的 sources/push_contracts/webpage_diffs 增删查；跨日持久化台账 | `storage/sqlite_mixin.py` 的连接模式 | 否 |
| 4 | `trendradar/storage/jingliu_schema.sql` | 新建 | 三张新表 DDL（见交付物 2.1） | — | 否 |
| 5 | `trendradar/collectors/__init__.py` | 新建 | 采集器包入口 | — | 否 |
| 6 | `trendradar/collectors/webpage_monitor.py` | 新建 | **WebpageMonitor**：抓取、正文提取（选择器/可读性）、规范化指纹、结构化 diff、噪声规则（交付物 5 的落点）、产出 `WebpageChangeEvent` | `requests`（已有） | 否（新增 `tests/test_webpage_monitor.py`） |
| 7 | `trendradar/collectors/douyin_adapter.py` | 新建 | **DouyinAdapter**：账号/关键词/直播间 → RSSHub 路由 URL → 运行时生成 `RSSFeedConfig` 列表（不落盘 config.yaml）；标记 `platform_type=douyin` | `crawler/rss/fetcher.py:21` 的 `RSSFeedConfig` | 否 |
| 8 | `trendradar/jingliu/monitor_scheduler.py` | 新建 | **MonitorScheduler**：`run_due_cycle()` 扫描 sources 表中 `last_checked_at + check_interval <= now` 的到期源并执行（交付物 4.3） | `jingliu.state_store`、`collectors.*`、`jingliu.contracts` | 否 |
| 9 | `trendradar/notifiers/__init__.py` | 新建 | 推送渠道包入口 | — | 否 |
| 10 | `trendradar/notifiers/apns_notifier.py` | 新建 | `send_to_apns(device_token, contract, ...) -> bool`：HTTP/2 provider API，JWT（ES256/.p8）鉴权；payload 携带 hit_reason | `httpx[http2]`、`PyJWT`、`cryptography`（新增依赖） | 否 |
| 11 | `trendradar/notifiers/fcm_notifier.py` | 新建 | `send_to_fcm(device_token, contract, ...) -> bool`：FCM HTTP v1（service account OAuth2） | `PyJWT`、`cryptography` | 否 |
| 12 | `trendradar/storage/sqlite_mixin.py` | 修改 | ① `_get_connection(date, db_type)` 支持 `db_type="state"`（无日期固定库）；② 追加 jingliu 表 CRUD impl（`_register_source_impl`、`_record_push_contract_impl`、`_fingerprint_pushed_impl`、`_save_webpage_diff_impl` 等） | `jingliu_schema.sql` | 否（新增测试覆盖） |
| 13 | `trendradar/storage/local.py` | 修改 | `_get_db_path` 增加 `db_type="state"` 分支 → `output/state/state.db`；`cleanup_old_data`（400-446）**排除 state 目录**；委托转发新方法 | `sqlite_mixin.py` | 需回归 `tests/test_storage_sync.py` |
| 14 | `trendradar/storage/remote.py` | 修改 | `_get_remote_db_key`（152）增加 state 固定 key（如 `state/state.db`，不带日期）；`_upload_sqlite`/`_download_sqlite` 复用 | `sqlite_mixin.py` | 需回归 `tests/test_storage_sync.py` |
| 15 | `trendradar/storage/manager.py` | 修改 | `StorageManager` 委托转发 sources/push_contracts/webpage_diffs 方法（仿照现有 `get_active_ai_filter_tags` 等 302-306 行的转发写法） | `base.py` | 否 |
| 16 | `trendradar/storage/base.py` | 修改 | `StorageBackend` 追加 jingliu 方法默认实现（返回空值，模式同现有 AI filter 方法区 468-527） | — | 否 |
| 17 | `trendradar/context.py` | 修改 | 追加 `jingliu_enabled` 属性、`get_state_store()`、`get_push_contract_builder()`、`get_monitor_scheduler()` 工厂（模式照抄 502-507） | `jingliu.*` | 否 |
| 18 | `trendradar/__main__.py` | 修改 | 仅 3 处小插入：① `_crawl_rss_data` feeds 构建循环（1012-1038）后追加 douyin 生成源合并；② `run()`（1611）内 jingliu.enabled 时执行 `monitor_scheduler.run_due_cycle()`；③ `_send_notification_if_needed`（874-875 之间）jingliu.enabled 时把 stats/rss_items 转契约 → gate → `dispatch_contracts`。**不做 if/else 大改** | `jingliu.*`、`collectors.*` | 否 |
| 19 | `trendradar/notification/dispatcher.py` | 修改 | 追加 `dispatch_contracts(contracts: List[PushContract]) -> Dict[str, bool]`：复用 `_send_to_multi_accounts`（365）模式分发 APNs/FCM；**不改动 `dispatch_all`** | `notifiers.*` | 否 |
| 20 | `trendradar/ai/filter.py` | 修改 | `classify_batch`（310）prompt 约定与 `_parse_classify_response`（386）解析**可选** `reason` 字段；缺省回退 None（不影响现有 prompt 兼容） | `ai/client.py` | 需跑 `tests/test_ai_analysis_response.py` 确认无回归 |
| 21 | `trendradar/ai/filter_pipeline.py` | 修改 | `_build_filter_result`（396）items 增加 `reason` 透传；`_save_results`/`_save_filter_results_impl`（sqlite_mixin.py:1548）落库 reason 列（新列，`ALTER TABLE ... ADD COLUMN` 迁移由 jingliu_schema 部分处理） | `storage` | 否 |
| 22 | `config/ai_filter/ai_filter_prompt.txt` | 修改 | 分类输出 JSON 增加可选 `reason` 字段（≤30 字理由） | — | 否 |
| 23 | `pyproject.toml` | 修改 | dependencies 追加 `httpx[http2]`、`PyJWT`、`cryptography`（版本以 `uv add` 锁定为准） | — | 否 |
| 24 | `docker/Dockerfile` | 不改 | uv 同步依赖自动生效；`output/` 卷已挂载（docker-compose.yml:10-13），state.db 随卷持久化 | — | — |
| 25 | `trendradar/core/loader.py` | 修改 | 追加 `_load_jingliu_config`（模式同 `_load_rss_config:176`），合并进 `load_config`（524） | — | 需跑 `tests/test_config_serialization.py` 确认无回归 |

### 2.1 新增表 DDL（`trendradar/storage/jingliu_schema.sql`）

```sql
-- 静流：源注册表（本轮只登记 webpage/douyin 两类新源；hotlist/rss 仍由 config.yaml 驱动，
-- type 列为其预留，未来统一收编时不改现有表）
CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,                    -- hotlist / rss / webpage / douyin
    platform TEXT DEFAULT '',              -- 展示用平台名（如 douyin）
    external_id TEXT DEFAULT '',           -- 外部标识（sec_uid / URL hash / feed id）
    name TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',     -- JSON：webpage 的 url+selector；douyin 的 route 参数
    check_interval INTEGER NOT NULL DEFAULT 30,   -- 分钟
    selector_config TEXT DEFAULT '{}',     -- JSON：CSS 选择器与忽略规则（交付物 5）
    status TEXT DEFAULT 'active',          -- active / paused
    last_checked_at TEXT,                  -- ISO 时间，MonitorScheduler 到期判定
    created_at TEXT NOT NULL
);

-- 静流：推送契约台账（跨日持久化，唯一门控）
CREATE TABLE IF NOT EXISTS push_contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_fingerprint TEXT NOT NULL,     -- sha256，见交付物 3.3
    interest_id TEXT NOT NULL,             -- 词组名 / ai tag id / source id
    hit_reason TEXT NOT NULL,              -- JSON：{kind, text, detail}
    confidence TEXT NOT NULL,              -- high / medium / low
    source_attribution TEXT NOT NULL,      -- JSON：{platform, url, source_type}
    payload TEXT NOT NULL DEFAULT '{}',    -- JSON：APNs/FCM 结构化载荷
    pushed_at TEXT,                        -- 实际推送时间（gate 通过后写入）
    channel TEXT DEFAULT '',               -- apns / fcm
    user_feedback TEXT DEFAULT '',         -- useful / useless（移动端回传，本轮只留列）
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_contracts_fp
    ON push_contracts(content_fingerprint);       -- 交付物 4 的判重核心

-- 静流：网页变更历史
CREATE TABLE IF NOT EXISTS webpage_diffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    previous_fingerprint TEXT DEFAULT '',
    current_fingerprint TEXT NOT NULL,
    diff_summary TEXT NOT NULL,            -- JSON：{changed_blocks:[{type,old,new}], change_chars:int}
    detected_at TEXT NOT NULL,
    FOREIGN KEY (source_id) REFERENCES sources(id)
);
```

> 说明：任务书给的 `sources` 表字段 `selector_config` 与 `config` 职责有重叠，本方案拆为「抓取目标（config）」与「提取/去噪规则（selector_config）」两列，语义更清晰；字段名保留原任务书命名。

---

## 交付物 3：PushContractBuilder 接口定义

**位置**：`trendradar/jingliu/contracts.py`。位于筛选之后、推送渲染之前：热榜/RSS 路径的调用点在 `__main__.py` `_send_notification_if_needed` 的 `prepare_report`（860）与 `dispatch_all`（876）之间；URL 监控路径在 `MonitorScheduler.run_due_cycle()` 内。

```python
# trendradar/jingliu/contracts.py
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional

Confidence = Literal["high", "medium", "low"]


@dataclass
class HitReason:
    """命中理由。text 必须来自本轮匹配的实际数据，禁止事后编造。"""
    kind: Literal["keyword", "ai", "webpage_change"]
    text: str                      # 直接进通知的文案
    detail: Dict[str, Any] = field(default_factory=dict)
    # keyword: {"matched_word": str, "required_hit": [...], "normal_hit": [...]}
    # ai:      {"tag": str, "relevance_score": float, "llm_reason": Optional[str]}
    # webpage_change: {"changed_blocks": [...], "change_chars": int, "selector_used": str}


@dataclass
class SourceAttribution:
    platform: str                  # 平台 ID / "webpage" / "douyin"
    platform_name: str             # 展示名
    url: str                       # 原始链接（webpage 源即被监控 URL）
    mobile_url: str = ""
    source_type: str = "hotlist"   # hotlist / rss / webpage / douyin


@dataclass
class PushContract:
    content_fingerprint: str
    interest_id: str
    hit_reason: HitReason
    source_attribution: SourceAttribution
    confidence: Confidence
    payload: Dict[str, Any]        # 移动端结构化载荷（交付物 3.4）
    source_row_id: Optional[int] = None   # webpage/douyin 源在 sources 表的 id


@dataclass
class GateResult:
    pushable: List[PushContract]
    suppressed: List[Dict[str, Any]]
    # suppressed 元素: {"contract": PushContract, "reason":
    #   "duplicate_fingerprint" | "lower_confidence_cross_source" | "below_change_threshold"}
```

```python
class PushContractBuilder:
    """筛选之后、推送渲染之前的契约层。所有判重状态持久化在 state.db.push_contracts。"""

    def __init__(self, config: Dict[str, Any], state_store, get_time_func) -> None: ...

    # ---- 构建（hit_reason 一律取自本轮实际匹配数据）----
    def build_from_keyword_stats(self, stats: List[Dict]) -> List[PushContract]:
        """输入 count_word_frequency 输出的 stats（[{word, count, titles: [...]}]，
        命中词即 stat["word"]（core/analyzer.py:93 按词分组的既有结构）。"""
        # hit_reason.text = f"命中了关键词『{word}』"
        # detail 补充 required/normal 命中词（来自 frequency_words.txt 词组配置）

    def build_from_ai_items(
        self, ai_filter_result, mode: str,
    ) -> List[PushContract]:
        """输入 AIFilterResult（ai/filter.py:21-34）。
        hit_reason.text 优先用 LLM reason 字段（见 3.1）；
        无 reason 时降级：f"与你的兴趣『{tag}』相关度 {relevance_score:.2f}"。"""

    def build_from_webpage_event(self, event) -> PushContract:
        """输入 WebpageChangeEvent（collectors/webpage_monitor.py）。
        hit_reason.text 按 diff 类型生成：
        标题变更 → f"网页标题从『{old}』变为『{new}』"；
        段落新增 → f"正文新增段落：『{new[:40]}…』"。"""

    # ---- 门控（独立于现有 filter，"推送即契约"的核心）----
    def gate_and_rank(self, contracts: List[PushContract]) -> GateResult:
        """三道闸，顺序执行：
        1. fingerprint 唯一性：state.db 中 SELECT push_contracts WHERE
           content_fingerprint=? —— 命中即 suppressed（跨运行周期持久去重）；
        2. 跨源去重：同 fingerprint 多源命中保留 confidence 最高的一条，
           其余 suppressed（reason=lower_confidence_cross_source）；
           confidence 相同取 interest_id 字典序最小，保证确定性；
        3. URL 变更幅度阈值：webpage 源 change_chars < jingliu.webpage.
           min_change_chars（默认 50）→ suppressed。"""

    def record_pushed(self, contracts: List[PushContract], channel: str) -> None:
        """推送成功后写入 push_contracts（含 pushed_at/channel），
        UNIQUE(content_fingerprint) 冲突时静默跳过（并发兜底）。"""
```

### 3.1 AI 路径理由字段的获取（对应任务"保存 LLM 返回的简短理由"）

- `config/ai_filter/ai_filter_prompt.txt`：分类输出格式由 `[{"id":1,"tag_id":1,"score":0.9}]` 扩展为可选 `"reason":"≤30字理由"`（`ai/filter.py:386-520` 的 `_parse_classify_response` 兼容缺省）；
- `ai_filter_results` 表加列 `reason TEXT DEFAULT ''`（`ALTER TABLE` 幂等迁移放在 jingliu schema 应用逻辑中）；
- `_save_filter_results_impl`（`sqlite_mixin.py:1548-1579`）INSERT 增加 reason；`_get_active_filter_results_impl`（1581）SELECT 透出；
- `_build_filter_result`（`filter_pipeline.py:437-450`）items 携带 `reason`。

### 3.2 置信度规则（决定推送节奏）

| 路径 | high | medium | low |
|------|------|--------|-----|
| keyword | 词组含必须词全命中 | 仅普通词命中 | — |
| ai | relevance_score ≥ 0.8 | 0.5 ~ 0.8 | < 0.5 |
| webpage_change | 结构化 diff 含标题变更或 ≥2 个段落变更 | 1 个段落变更且 ≥50 字符 | 其余通过阈值的变更 |

节奏：high → 立即推（`dispatch_contracts` 即时发送）；medium → 即时推但通知级别为"被动"（APNs `interruption-level: active`）；low → 不进本轮推送，落 `push_contracts`（pushed_at 为空）进入摘要池，由后续"低置信度摘要"（本轮不实现，仅预留查询接口）消费。

### 3.3 content_fingerprint 生成规则

```python
def make_fingerprint(*parts: str) -> str:
    canonical = "\x1f".join(p.strip().lower() for p in parts if p)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
```

- 热榜/RSS：`make_fingerprint(url or title, source_id)`——URL 优先（news_items 本身以 url+platform 去重，schema.sql:111-112），无 URL 回退 title；
- AI 路径：同上（item 已带 url/title）；
- webpage：`make_fingerprint(source_url, current_fingerprint)`——**必须**包含内容指纹，否则同一页面第二次变更会被首闸误杀。

### 3.4 移动端结构化 payload（APNs 示例，FCM 同构）

```json
{
  "aps": {
    "alert": {"title": "静流 · 抖音", "body": "正文新增段落：『Agent 2.0 发布…』"},
    "thread-id": "sources:17",
    "interruption-level": "active"
  },
  "jingliu": {
    "contract_id": 123,
    "fingerprint": "sha256…",
    "hit_reason": {"kind": "webpage_change", "text": "…", "detail": {…}},
    "confidence": "high",
    "url": "https://…"
  }
}
```

---

## 交付物 4：Issue #1007 处理决策 —— **选 B（契约层持久化判重），不改 run_ai_filter**

### 4.1 源码事实澄清

任务书描述的根因（"convert 只标记不过滤"）在**本仓库当前源码中不成立**：`filter_pipeline.py:557-558` 确实执行了 `continue` 过滤（该逻辑自提交 `4df2318` 存在）。但防重链条依然脆弱，重复推送风险真实存在：

1. **`run()` 语义是"当日累计"**：`filter_pipeline.py:158` 拉取当日全部 active 结果（SQL 见 `sqlite_mixin.py:1599`，仅 `status='active'` 过滤，无批次/时间窗过滤）——推送新鲜度完全依赖下游 is_new 过滤的正确性；
2. **is_new 依赖 title 字符串匹配 + HH:MM 字符串比较**（`filter_pipeline.py:549-555` 与 `core/data.py:113-195`）：同标题脱榜再上榜、同一分钟内多批次、标题微调等场景都会造成误判；
3. **首抓兜底全推**：`core/data.py:173-176` 当天无历史数据时把全部最新标题当"新增"，叠加 AI 累计结果即一次性推整天存量；
4. **跨渠道/跨模式无台账**：daily/current 模式按设计就是重复推同一批内容，没有任何"这条推过没有"的持久记录。

### 4.2 为什么不选 A（改 run_ai_filter / convert_to_report_data 的返回值语义）

`get_active_ai_filter_results` 的"当日全量"语义是**被 HTML 报告复用的数据源**：`_run_analysis_pipeline`（`__main__.py:676-690`）用同一个 `AIFilterResult` 生成 stats 并渲染 `daily/current` 报告区。把 `run()` 改成"只返回本轮 pending 命中"，daily/current 模式的 HTML 与推送会丢历史命中；要兼容就得加旁路参数，改动面覆盖 `filter_pipeline.py` 的 `run/_build_filter_result/convert_to_report_data` 三个函数 + `context.py:509-528` 两个转发方法，还得处理"AI 分类失败重试后 created_at 变化"等边界——为修一个能在契约层一行 SQL 挡住的问题，代价不成比例。

### 4.3 选 B 的落地改动点

| 改动 | 文件 + 函数 | 说明 |
|------|------------|------|
| 判重表 | `trendradar/storage/jingliu_schema.sql`：`push_contracts` + `UNIQUE(content_fingerprint)` 索引 | 跨日持久化于 `output/state/state.db`（不随日期分库滚动，`local.py` cleanup 排除该目录） |
| 门控逻辑 | `trendradar/jingliu/contracts.py::PushContractBuilder.gate_and_rank` | 首闸 fingerprint 查库；第二闸跨源 confidence 排序 |
| 热榜/RSS/AI 插入点 | `trendradar/__main__.py::_send_notification_if_needed`，在 `prepare_report`（860）之后、`dispatch_all`（876）之前 | jingliu.enabled 时：stats/rss_items → `build_from_*` → `gate_and_rank` → `record_pushed` → `dispatch_contracts`；gate 结果为空则整轮跳过推送（增量语义强于现有 `_has_valid_content`） |
| URL 监控插入点 | `trendradar/jingliu/monitor_scheduler.py::run_due_cycle` | 独立于主 Scheduler（不读 timeline.yaml），进程启动即跑一次到期扫描，与热榜全流程互不阻塞 |
| 上游顺手加固（可选，不作为主防线） | `trendradar/ai/filter_pipeline.py::_collect_pending_news`（276-303） | 已有 analyzed_news 去重；无需改。真正可选的加固是给 `_get_active_filter_results_impl`（sqlite_mixin.py:1599）加 `AND n.last_crawl_time >= 最新批次` 的查询参数——本轮**不做**，理由同 4.2 |

### 4.4 结论

选项 B 把"只推一次"从"上游筛选语义"中解耦出来，落为 `push_contracts` 表上的一条 UNIQUE 约束。无论上游 AI 路径返回当日累计还是全量，闸门后的内容必然是"本生命周期内从未推过的 fingerprint"。这同时天然覆盖任务书担心的关键词路径重复（daily 模式）与 URL 监控重复，是"推送即契约"的最小充分实现。

---

## 交付物 5：URL 监控的防噪声策略

**位置**：`trendradar/collectors/webpage_monitor.py`。抓取 → 提取 → 规范化 → 指纹 → diff → 噪声规则 → `WebpageChangeEvent{changed_blocks, change_chars, previous/current_fingerprint}`。六条规则按执行顺序：

**规则 1：选择器限域（第一道，从根上排除噪声）**
`selector_config.json` 用户指定 CSS 选择器（如 `#article-body`），仅对该区域做指纹；未指定时用可读性算法兜底（优先 `trafilatura`，若不想加依赖则降级为 `html.parser` + "文本密度最大块"启发式）。导航/页脚/推荐位在提取阶段即被排除。

**规则 2：规范化文本（消除无意义差异）**
指纹计算前对选定区域文本做：全角→半角、连续空白折叠、按行 strip、空行剔除、行序无关（对标签型内容）不启用、URL 尾参剔除。同一次抓取的规范化函数必须与建基线时一致（函数版本号写入 `sources.selector_config`，升级规范化逻辑时重置基线防误报）。

**规则 3：动态噪声掩码（changedetection.io 最小集）**
抓取内容在规范化前先过 `selector_config.ignore_rules`（正则列表，源级可配），并内置默认掩码：时间戳行（`\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}`）、访问计数（`(浏览|阅读|views?|点击)[：: ]*\d+`）、评论数、倒计时、"更新于 xx 分钟前"。命中行直接从指纹输入中剔除，但保留在原始文本中（供 diff 展示上下文）。

**规则 4：变更幅度阈值（数量闸）**
结构化 diff 后统计有效变更字符数 `change_chars`（剔除标点/空白差异后的字符数）。`change_chars < min_change_chars`（默认 50，`sources.selector_config` 可配）→ 只写 `webpage_diffs` 表，不产出推送契约。

**规则 5：结构化 diff 定位"哪里变了"**
把选定区域解析为有序块列表 `[{type: title|paragraph, text}]`（title 块取 `<h1>-<h6>` 或选择器 `title_selector`），`difflib.SequenceMatcher` 逐块对齐，产出 `changed_blocks`：`{type, old, new}`。仅大小写/标点差异的块不算变更。`hit_reason` 文案直接由 changed_blocks 渲染（"网页标题从『A』变为『B』"/"正文新增段落…"）——满足"变更事件必须能回答哪里变了"。

**规则 6：抖动合并（时间闸）**
同一 source 在 `cooldown_minutes`（默认 15）内产生多次变更时，`MonitorScheduler` 只保留最新一次契约（previous_fingerprint 取上次**已推送**的指纹而非上次检查的指纹），并把中间态合入 `diff_summary.rolled_up: n`。避免页面轮播/计数抖动造成连击推送。

另有一条结构约定：**首次检查只建基线**（`previous_fingerprint` 为空 → 写 webpage_diffs，永远不推送），杜绝新添加源时的"存量爆发"。

---

## 交付物 6：兼容性风险评估

### 6.1 GitHub Actions（`.github/workflows/crawler.yml`，每小时 cron，单次运行）

| 风险 | 等级 | 规避 |
|------|------|------|
| **无状态环境导致指纹库丢失 → 全量重复推送**（最高风险：state.db 若只落本地，每次运行都是空台账，选项 B 门控失效） | 高 | state.db 纳入远程后端同步：`remote.py::_get_remote_db_key` 增加 `db_type="state"` 固定 key（不带日期），`begin_batch/end_batch` 已有的上传/下载路径（remote.py:259-268）自动覆盖；本地路径 `output/state/state.db`。S3 未配置（本地存储模式）时门控退化为"当日库内去重"，文档标注 |
| `MonitorScheduler` 假设常驻 | 中 | 设计为 `run_due_cycle()` 单次到期扫描（进程启动即执行），cron 模型天然兼容；check_interval < cron 周期的源实际按 cron 周期检查——在 README 标注，不硬造后台线程 |
| 新依赖拖慢安装 | 低 | uv 缓存；APNs/FCM 相关依赖仅在 jingliu.enabled 时 import（延迟导入，仿照 `__main__.py:1082-1085` 对 feedparser 的 ImportError 处理） |
| timeout-minutes 15 | 低 | monitor cycle 串行执行，源数 ×超时（默认 15s/源）需 < 剩余预算；加单源硬超时 |

### 6.2 Docker（`entrypoint.sh` supercronic，默认 `*/30 * * * *`）

- 进程短生命周期与 MonitorScheduler 的"启动即扫描"模型一致，无需改 entrypoint / Dockerfile / compose；
- state.db 位于 `output/state/`，compose 已挂载 `../output:/app/output`（docker-compose.yml:10-13），随卷持久化；
- 唯一注意点：`IMMEDIATE_RUN=true` + cron 双触发时，`run_due_cycle` 可能并发——用 `push_contracts` 的 UNIQUE 约束 + `record_pushed` 冲突静默兜底（交付物 4.3），不加进程锁（避免引入复杂度）。

### 6.3 本地 `uv run`

- 新依赖（httpx[http2]、PyJWT、cryptography）`uv sync` 自动安装，Python 3.12 兼容；
- 现有 `pyproject.toml` 依赖零移除，`uv.lock` 重锁即可；
- Windows/macOS 下 httpx h2 无二进制坑（纯 Python + h2 包）。

### 6.4 数据与逻辑兼容

- 现有三套 schema 零改动（新表全部 `CREATE TABLE IF NOT EXISTS`，独立 `jingliu_schema.sql`，建表模式与 `ai_filter_schema.sql` 一致，`sqlite_mixin.py:94-96` 处追加执行）；旧 .db 文件直接可用；
- `filter.method=keyword` 用户：jingliu 关闭时行为不变；开启时新增契约推送渠道，原飞书/钉钉等报告式推送照旧（两套并行、渠道不同，不互斥）；
- `filter.method=ai` 用户：prompt 增加可选 reason 字段——旧模型不输出 reason 时解析回退（`_parse_classify_response` 容错已有先例：新旧两种 JSON 格式，filter.py:394-396）；
- MCP server（`mcp_server/`）只读 news/rss 库，不受影响；
- `tests/`：`test_storage_sync.py`（remote key 改动）、`test_config_serialization.py`（loader 新段）、`test_ai_analysis_response.py`（解析扩展）三处需回归；其余不动。

### 6.5 明确"本轮不做"

- **不重写 `NewsAnalyzer`**：其编排膨胀（1717 行）是真实问题，但拆分属结构性重构，与静流无耦合。本轮只做 3 处锚点插入（交付物 2 #18），拆分另立专项；
- **不改 `DataFetcher` 并行化**：URL 监控走独立采集器与独立调度，不加剧串行瓶颈；热榜并行化（线程池包 `fetch_data`）另立专项；
- **不做移动端 App**：后端仅保证 `PushContract.payload` 结构完整可消费。

---

## 交付物 7：最小验证路径（5 步）

1. **单元验证门控**：`pytest tests/test_push_contracts.py`——用假 `state_store` 构造同一 `content_fingerprint` 两次 `build_from_webpage_event` → `gate_and_rank`：第一次 `pushable=1`、`record_pushed` 后第二次 `suppressed=[duplicate_fingerprint]`；再构造双源同指纹、confidence 不同 → 验证仅 high 保留。

2. **注册真实 URL 基线**：向 `sources` 表插入一条 webpage 源（`config={"url":"http://localhost:8080/page.html","title_selector":"h1"}`，本地起一个静态页），`check_interval=1`；执行 `python -c "from trendradar.jingliu.monitor_scheduler import MonitorScheduler; ...run_due_cycle()"` → 验证首查只写 `webpage_diffs`（基线）且**零推送**。

3. **触发实质变更**：修改静态页 `<h1>` 文字与一段正文（变更 ≥50 字符）→ 再跑 `run_due_cycle()` → 收到 APNs/FCM 推送（无设备时可临时把 `channel` 指向通用 webhook 观察载荷），通知 body 含 hit_reason 文案"网页标题从『A』变为『B』"；`webpage_diffs` 新增一行、`push_contracts` 落一条 `pushed_at` 非空的记录、payload 中 `jingliu.confidence=high`。

4. **验证不重复推送**：不改动页面，连跑两次 `run_due_cycle()` → 两次均零推送（指纹相同走不到 diff；即使指纹因噪声变化，规则 3 掩码 + 规则 4 阈值 + 交付物 4 首闸三重兜底），`push_contracts` 行数不变。

5. **端到端回归**：`jingliu.enabled=true` 跑一次完整 `python -m trendradar`（含热榜/RSS）→ 原有飞书/钉钉报告照发、HTML 正常生成、`output/state/state.db` 存在；再以 `jingliu.enabled=false` 重跑 → 行为与改造前一致（对照 `git stash` 基线输出目录），并复跑 `tests/test_storage_sync.py`、`tests/test_config_serialization.py`、`tests/test_ai_analysis_response.py` 三项回归。

---

## 附：实施顺序建议

1. schema + state_store（#3/#4/#12-16）→ 2. PushContractBuilder + 门控（#2）→ 3. APNs/FCM + dispatcher.contracts（#10/#11/#19）→ 4. `__main__.py` 三处插入 + loader（#18/#25，此时热榜/RSS/AI 全部内容已可走契约推送，先跑通交付物 7 第 1/5 步）→ 5. WebpageMonitor + MonitorScheduler（#6/#8）→ 6. DouyinAdapter（#7，依赖外部 RSSHub 实例，路由可用性按部署实例实测后登记）→ 7. AI reason 字段贯通（#20-22，增强项，最后做）。
