# coding=utf-8
"""
静流云同步（GitHub Actions ↔ Cloudflare Worker/KV）

云端架构下手机 App 只认 Worker 固定地址（cloudflare-worker/），数据存 KV。
GH Actions 每轮运行负责把 Worker KV 里的持久状态搬进运行器、跑完管道再搬回去：

    sync-in  （Run crawler 之前）拉取 state.db + 兴趣文件 overlay → 写入工作目录
    sync-out （Run crawler 之后）上传最新 state.db + 生成 feed.json（近 N 条已推契约 + 兴趣快照）

Worker 内部端点（Bearer JINGLIU_SYNC_TOKEN 鉴权，见 cloudflare-worker/worker.js）：
    GET /internal/state.db    PUT /internal/state.db
    PUT /internal/feed.json
    GET /internal/interests   → {"ai_interests": str|null, "frequency_words": str|null}

环境变量：JINGLIU_WORKER_URL、JINGLIU_SYNC_TOKEN；任一未配置则整体跳过（退出 0），
便于本地/未接入云端的环境无感运行。零第三方依赖（urllib + sqlite 经 storage 层）。
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

from trendradar.core.loader import load_config
from trendradar.storage.local import LocalStorageBackend

# 与 api_server._INTEREST_FILES 保持一致
INTEREST_FILES = {
    "ai_interests": "config/ai_interests.txt",
    "frequency_words": "config/frequency_words.txt",
}
FEED_CONTRACT_LIMIT = 100
STATE_DB_PATH = Path("output/state/state.db")
REQUEST_TIMEOUT = 60
# CF Browser Integrity Check 拦 Python-urllib UA，统一伪装浏览器（见 _request 注释）
_BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/126.0 Safari/537.36 jingliu-cloud-sync/1.0")


def _sync_env() -> Optional[tuple]:
    url = os.environ.get("JINGLIU_WORKER_URL", "").strip().rstrip("/")
    token = os.environ.get("JINGLIU_SYNC_TOKEN", "").strip()
    if not url or not token:
        print("[静流云同步] JINGLIU_WORKER_URL / JINGLIU_SYNC_TOKEN 未配置，跳过云同步")
        return None
    return url, token


def _request(method: str, url: str, token: str, data: Optional[bytes] = None,
             content_type: str = "application/octet-stream") -> Optional[bytes]:
    """返回响应体；HTTP 404 返回 None；其他错误打印并退出非零。

    UA 必须伪装成浏览器：用户 zone 开着 Browser Integrity Check，会按 UA
    拦截 Python-urllib（实测 403/1010）；okhttp/curl/浏览器 UA 均放行。
    """
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("User-Agent", _BROWSER_UA)
    if data is not None:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        print(f"[静流云同步] {method} {url} → HTTP {e.code}: {e.read()[:200]!r}")
        raise SystemExit(1)
    except Exception as e:
        print(f"[静流云同步] {method} {url} 失败: {e}")
        raise SystemExit(1)


def sync_in() -> None:
    """运行前：拉远端 state.db 到工作目录 + 兴趣 overlay 覆盖 config 文件。"""
    env = _sync_env()
    if not env:
        return
    url, token = env

    # 1) state.db（首次运行远端还没有 → 从零开始）
    blob = _request("GET", f"{url}/internal/state.db", token)
    if blob:
        STATE_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_DB_PATH.write_bytes(blob)
        print(f"[静流云同步] state.db 已拉取（{len(blob)} 字节）")
    else:
        print("[静流云同步] 远端暂无 state.db（首次运行），从零开始")

    # 2) 兴趣文件 overlay（App 在手机上改过 → 这里生效）
    raw = _request("GET", f"{url}/internal/interests", token)
    overlays = json.loads(raw or b"{}") if raw else {}
    for target, rel_path in INTEREST_FILES.items():
        content = overlays.get(target)
        if isinstance(content, str):
            path = Path(rel_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
            print(f"[静流云同步] 兴趣 overlay 已写入 {rel_path}")


def _build_feed() -> dict:
    """复用本地 API 同一序列化路径，保证 feed.json 与 /api/contracts/recent 结构一致。"""
    try:
        config = load_config()
        timezone = config.get("TIMEZONE", "Asia/Shanghai")
        data_dir = config.get("STORAGE", {}).get("LOCAL", {}).get("DATA_DIR", "output")
    except Exception:
        timezone, data_dir = "Asia/Shanghai", "output"

    backend = LocalStorageBackend(data_dir=data_dir, enable_txt=False, enable_html=False, timezone=timezone)
    try:
        contracts = backend.get_recent_contracts(FEED_CONTRACT_LIMIT)
    finally:
        backend.cleanup()

    interests = {}
    for target, rel_path in INTEREST_FILES.items():
        path = Path(rel_path)
        interests[target] = path.read_text(encoding="utf-8") if path.exists() else ""
    return {"contracts": contracts, "interests": interests, "hotlist": _build_hotlist(data_dir)}


def _build_hotlist(data_dir: str) -> dict:
    """当天热榜快照：全平台 + 排名趋势（rank_history 最早 vs 最新排名）。

    数据源 output/news/{date}.db（取最新一份）；无数据时返回空壳，App 端显示空态。
    """
    news_dir = Path(data_dir) / "news"
    if not news_dir.exists():
        return {"date": "", "platforms": []}
    db_files = sorted(news_dir.glob("*.db"), reverse=True)
    if not db_files:
        return {"date": "", "platforms": []}
    db_path = db_files[0]
    date = db_path.stem

    import sqlite3

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        platforms = []
        for pid, pname in conn.execute(
            "SELECT id, name FROM platforms WHERE is_active = 1 ORDER BY id"
        ):
            items = []
            for rank, title, url, mobile_url, first_rank, cnt in conn.execute(
                """
                SELECT n.rank, n.title, n.url, n.mobile_url,
                       rh.first_rank, rh.cnt
                FROM news_items n
                LEFT JOIN (
                    SELECT news_item_id,
                           MAX(CASE WHEN rn_asc = 1 THEN rank END) AS first_rank,
                           COUNT(*) AS cnt
                    FROM (
                        SELECT news_item_id, rank,
                               ROW_NUMBER() OVER (PARTITION BY news_item_id ORDER BY crawl_time) AS rn_asc
                        FROM rank_history
                    )
                    GROUP BY news_item_id
                ) rh ON rh.news_item_id = n.id
                WHERE n.platform_id = ?
                ORDER BY n.rank
                """,
                (pid,),
            ):
                trend, delta = "flat", 0
                if cnt is None or cnt <= 1:
                    trend = "new"
                elif first_rank is not None:
                    delta = int(first_rank) - int(rank)  # 正=排名上升 N 位
                    trend = "up" if delta > 0 else ("down" if delta < 0 else "flat")
                items.append({
                    "rank": rank,
                    "title": title,
                    "url": url or "",
                    "mobile_url": mobile_url or "",
                    "trend": trend,
                    "delta": delta,
                })
            platforms.append({"id": pid, "name": pname, "items": items})
        return {"date": date, "platforms": platforms}
    finally:
        conn.close()


def _upload_report(url: str, token: str) -> None:
    """上传 HTML 报告到 KV（App 内置浏览器查看）。"""
    report = Path("output/html/latest/current.html")
    if not report.exists():
        print("[静流云同步] 无 HTML 报告，跳过上传")
        return
    payload = report.read_bytes()
    _request("PUT", f"{url}/internal/report.html", token, data=payload, content_type="text/html")
    print(f"[静流云同步] report.html 已上传（{len(payload)} 字节）")


def sync_out() -> None:
    """运行后：回传 state.db + 上传 feed.json。"""
    env = _sync_env()
    if not env:
        return
    url, token = env

    if STATE_DB_PATH.exists():
        blob = STATE_DB_PATH.read_bytes()
        _request("PUT", f"{url}/internal/state.db", token, data=blob)
        print(f"[静流云同步] state.db 已上传（{len(blob)} 字节）")
    else:
        print("[静流云同步] 本地无 state.db，跳过回传")

    feed = _build_feed()
    payload = json.dumps(feed, ensure_ascii=False).encode("utf-8")
    _request("PUT", f"{url}/internal/feed.json", token, data=payload, content_type="application/json")
    hotlist_count = sum(len(p["items"]) for p in feed.get("hotlist", {}).get("platforms", []))
    print(f"[静流云同步] feed.json 已上传（{len(payload)} 字节，{len(feed['contracts'])} 条契约，{hotlist_count} 条热榜）")
    _upload_report(url, token)


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "sync-in":
        sync_in()
    elif cmd == "sync-out":
        sync_out()
    else:
        print("用法: python -m trendradar.jingliu.cloud_sync sync-in|sync-out")
        raise SystemExit(2)


if __name__ == "__main__":
    main()
