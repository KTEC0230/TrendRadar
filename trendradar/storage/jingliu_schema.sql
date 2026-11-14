-- 静流（JingLiu）相关表结构
-- 独立 state 库（output/state/state.db），与按日期滚动的 news/rss 库分离，
-- 保证推送台账跨运行周期持久化，不随日期清理丢失

-- ============================================
-- 源注册表
-- 本轮只登记 webpage / douyin 两类新源；hotlist/rss 仍由 config.yaml 驱动，
-- type 列为其预留，未来统一收编时不改现有表
-- ============================================
CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,                    -- hotlist / rss / webpage / douyin
    platform TEXT DEFAULT '',              -- 展示用平台名（如 douyin）
    external_id TEXT DEFAULT '',           -- 外部标识（sec_uid / URL hash / feed id）
    name TEXT NOT NULL,                    -- 展示名称
    config TEXT NOT NULL DEFAULT '{}',     -- JSON：抓取目标（webpage 的 url；douyin 的路由参数）
    check_interval INTEGER NOT NULL DEFAULT 30,   -- 检查间隔（分钟）
    selector_config TEXT DEFAULT '{}',     -- JSON：CSS 选择器与去噪规则
    status TEXT DEFAULT 'active',          -- active / paused
    last_checked_at TEXT,                  -- 最后检查时间（ISO），到期判定依据
    last_message TEXT DEFAULT '',          -- 最后一次检查的结果说明
    created_at TEXT NOT NULL
);

-- ============================================
-- 推送契约台账
-- 「推送即契约」核心：同一 content_fingerprint 只允许实际推送一次
-- ============================================
CREATE TABLE IF NOT EXISTS push_contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_fingerprint TEXT NOT NULL,     -- 内容指纹（sha256）
    interest_id TEXT NOT NULL,             -- 词组名 / AI 标签名 / source id
    hit_reason TEXT NOT NULL,              -- JSON：{kind, text, detail}
    confidence TEXT NOT NULL,              -- high / medium / low
    source_attribution TEXT NOT NULL,      -- JSON：{platform, platform_name, url, source_type}
    payload TEXT NOT NULL DEFAULT '{}',    -- JSON：APNs/FCM 结构化载荷
    pushed_at TEXT,                        -- 实际推送时间（NULL = 未推送，进摘要池）
    channel TEXT DEFAULT '',               -- apns / fcm
    user_feedback TEXT DEFAULT '',         -- useful / useless（移动端回传，预留）
    created_at TEXT NOT NULL
);

-- 部分唯一索引：已推送的指纹全库唯一（未推送的低置信度记录不占用指纹，
-- 后续出现更高置信度版本仍可推送）
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_contracts_fp_pushed
    ON push_contracts(content_fingerprint) WHERE pushed_at IS NOT NULL;

-- ============================================
-- 网页变更历史
-- ============================================
CREATE TABLE IF NOT EXISTS webpage_diffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    previous_fingerprint TEXT DEFAULT '',  -- 空字符串表示首次建基线
    current_fingerprint TEXT NOT NULL,
    diff_summary TEXT NOT NULL,            -- JSON：{changed_blocks, change_chars, rolled_up}
    detected_at TEXT NOT NULL,
    FOREIGN KEY (source_id) REFERENCES sources(id)
);

-- ============================================
-- 设备注册表（App 动态注册推送 token，与 config.yaml 静态 device_tokens 合并生效）
-- ============================================
CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,                 -- apns / fcm
    device_token TEXT NOT NULL,
    device_name TEXT DEFAULT '',           -- 展示名称（App 上报，可选）
    registered_at TEXT NOT NULL,
    last_seen_at TEXT,
    UNIQUE(channel, device_token)
);

-- ============================================
-- 索引
-- ============================================
CREATE INDEX IF NOT EXISTS idx_sources_type_status ON sources(type, status);
CREATE INDEX IF NOT EXISTS idx_sources_checked ON sources(last_checked_at);
CREATE INDEX IF NOT EXISTS idx_push_contracts_created ON push_contracts(created_at);
CREATE INDEX IF NOT EXISTS idx_webpage_diffs_source ON webpage_diffs(source_id, detected_at);
CREATE INDEX IF NOT EXISTS idx_devices_channel ON devices(channel);
