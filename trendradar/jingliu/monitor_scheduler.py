# coding=utf-8
"""
URL 监控调度器（MonitorScheduler）

与主 Scheduler（timeline.yaml 时间窗）完全独立：
- 按 sources.check_interval 驱动，逐源独立到期判定
- 进程启动即执行一次 run_due_cycle()，天然兼容 GH Actions / supercronic
  等短生命周期部署（无需常驻线程）
- 对 check_interval 小于进程调度周期（cron 间隔）的源，实际检查频率 = cron 周期

冷却合并：同一 source 在 cooldown_minutes 内多次变更，只推送最新一条，
中间态记入 diff_summary.rolled_up。
"""

from datetime import timedelta
from typing import Any, Dict, Optional


class MonitorScheduler:
    """URL 监控调度器：进程内单次到期扫描。"""

    def __init__(self, ctx):
        """ctx: AppContext（复用其 storage/builder/dispatcher/时间函数）"""
        self.ctx = ctx

    # ========================================
    # 到期判定
    # ========================================

    def _is_due(self, source: Dict[str, Any], now) -> bool:
        """last_checked_at + check_interval <= now 即到期；解析失败视为到期"""
        last_checked = source.get("last_checked_at")
        if not last_checked:
            return True
        try:
            from datetime import datetime

            last_dt = datetime.fromisoformat(str(last_checked))
        except ValueError:
            return True
        try:
            interval_minutes = int(source.get("check_interval", 30))
        except (ValueError, TypeError):
            interval_minutes = 30
        return now >= last_dt + timedelta(minutes=interval_minutes)

    def _resolve_proxy(self) -> Optional[str]:
        """代理策略与 NewsAnalyzer 一致：GH Actions 不用代理"""
        import os

        if os.environ.get("GITHUB_ACTIONS") == "true":
            return None
        config = self.ctx.config
        if config.get("USE_PROXY"):
            return config.get("DEFAULT_PROXY") or None
        return None

    # ========================================
    # 单轮执行
    # ========================================

    def run_due_cycle(self) -> Dict[str, int]:
        """
        扫描全部 active 的 webpage 源，检查到期源。

        Returns:
            统计 {"total", "due", "baseline", "changed", "pushed",
                  "failed", "cooldown_skipped"}
        """
        storage = self.ctx.get_storage_manager()
        builder = self.ctx.get_push_contract_builder()

        from trendradar.collectors.webpage_monitor import WebpageMonitor

        monitor = WebpageMonitor(
            config=self.ctx.config,
            get_time_func=self.ctx.get_time,
            proxy_url=self._resolve_proxy(),
        )

        webpage_config = self.ctx.config.get("JINGLIU", {}).get("WEBPAGE", {})
        cooldown_minutes = webpage_config.get("COOLDOWN_MINUTES", 15)

        sources = storage.list_sources(source_type="webpage")
        stats = {
            "total": len(sources), "due": 0, "baseline": 0, "changed": 0,
            "pushed": 0, "failed": 0, "cooldown_skipped": 0,
        }
        if not sources:
            return stats

        print(f"[静流] URL 监控：{stats['total']} 个源，开始到期扫描")

        for source in sources:
            now = self.ctx.get_time()
            if not self._is_due(source, now):
                continue
            stats["due"] += 1

            message = "ok"
            try:
                latest_diff = storage.get_latest_webpage_diff(source.get("id", 0))
                previous = None
                if latest_diff:
                    previous = {
                        "fingerprint": latest_diff.get("current_fingerprint", ""),
                        "blocks": (latest_diff.get("diff_summary") or {}).get("blocks", []),
                    }

                event = monitor.check_source(source, previous)

                if event is None:
                    message = "no-change"
                elif event.is_baseline:
                    stats["baseline"] += 1
                    message = "baseline"
                    self._record_diff(storage, event)
                else:
                    stats["changed"] += 1
                    message = f"changed({event.change_chars} chars)"
                    self._record_diff(storage, event)

                    cooldown_active = self._in_cooldown(storage, source, now, cooldown_minutes)
                    if cooldown_active:
                        stats["cooldown_skipped"] += 1
                        print(
                            f"[静流] 源『{source.get('name')}』处于冷却期（{cooldown_minutes} 分钟内已有变更），"
                            f"本次变更仅记录不推送"
                        )
                    elif not monitor.is_meaningful_change(event):
                        # 采集侧预检；门控层闸 3 会复核
                        print(f"[静流] 源『{source.get('name')}』变更幅度 {event.change_chars} 低于阈值，不推送")
                    else:
                        contract = builder.build_from_webpage_event(event)
                        gate = builder.gate_and_rank([contract], source_kind="webpage")
                        if gate.pushable:
                            dispatcher = self.ctx.create_notification_dispatcher()
                            results = dispatcher.dispatch_contracts(gate.pushable)
                            builder.record_pushed(gate.pushable, results)
                            stats["pushed"] += len(gate.pushable)
            except Exception as e:
                stats["failed"] += 1
                message = f"error: {type(e).__name__}: {e}"
                print(f"[静流] 源『{source.get('name')}』检查失败: {message}")

            try:
                storage.update_source_check(
                    source.get("id", 0),
                    self.ctx.get_time().isoformat(timespec="seconds"),
                    message,
                )
            except Exception as e:
                print(f"[静流] 更新源检查时间失败: {e}")

        print(
            f"[静流] URL 监控完成：到期 {stats['due']}/{stats['total']}，"
            f"基线 {stats['baseline']}，变更 {stats['changed']}，"
            f"推送 {stats['pushed']}，冷却跳过 {stats['cooldown_skipped']}，失败 {stats['failed']}"
        )
        return stats

    def _record_diff(self, storage, event) -> None:
        """写入 webpage_diffs（含当前块快照，供下次 diff）"""
        storage.save_webpage_diff({
            "source_id": event.source_id,
            "previous_fingerprint": event.previous_fingerprint,
            "current_fingerprint": event.current_fingerprint,
            "diff_summary": {
                "blocks": event_blocks_to_store(event.blocks_snapshot),
                "changed_blocks": event.changed_blocks,
                "change_chars": event.change_chars,
                "selector_used": event.selector_used,
            },
        })

    @staticmethod
    def _in_cooldown(storage, source: Dict, now, cooldown_minutes: int) -> bool:
        """
        冷却判定：该源最近一次实际推送是否仍在冷却窗口内。
        以推送时间（而非检查/diff 时间）为准——基线建库、未推送的变更都不应触发冷却。
        """
        if cooldown_minutes <= 0:
            return False
        try:
            pushed_at = storage.get_last_contract_pushed_at(f"source:{source.get('id', 0)}")
        except Exception as e:
            print(f"[静流] 冷却判定查询失败（按不在冷却处理）: {e}")
            return False
        if not pushed_at:
            return False
        try:
            from datetime import datetime

            pushed_dt = datetime.fromisoformat(str(pushed_at))
        except ValueError:
            return False
        return now < pushed_dt + timedelta(minutes=cooldown_minutes)


def event_blocks_to_store(blocks) -> list:
    """块列表截断存储（防超长）"""
    from trendradar.collectors.webpage_monitor import _MAX_BLOCK_TEXT, _MAX_BLOCKS

    stored = []
    for block in (blocks or [])[:_MAX_BLOCKS]:
        text = str(block.get("text", ""))[:_MAX_BLOCK_TEXT]
        stored.append({"type": block.get("type", "paragraph"), "text": text})
    return stored
