# coding=utf-8
"""
摘要池定时推送（Digest）

低置信度契约不即时打扰（APNs passive），攒批后按 jingliu.digest.interval_minutes
汇总为一条摘要推送。语义约定：
- digest 契约 interest_id 固定为 "digest"，台账中最近一次 digest 推送时间
  即间隔判定依据（复用 get_last_contract_pushed_at，无需新存储方法）
- digest 成功后，其覆盖的 pending 契约标记为已推送（channel="digest"）——
  内容已通过摘要送达，同一指纹不再重复即时推送
- pending 为空时不推送、不写台账（空摘要不应重置间隔）
"""

from typing import Any, Dict, List

from trendradar.jingliu.contracts import (
    HitReason,
    PushContract,
    SourceAttribution,
    make_fingerprint,
)

DIGEST_INTEREST_ID = "digest"


class DigestScheduler:
    """摘要池定时推送：进程启动即判定是否到期。"""

    def __init__(self, ctx):
        """ctx: AppContext"""
        self.ctx = ctx

    # ========================================
    # 间隔判定
    # ========================================

    def _is_due(self, storage, now, interval_minutes: int) -> bool:
        """距上次 digest 推送超过 interval_minutes 即到期；解析失败视为到期"""
        if interval_minutes <= 0:
            return True
        last_pushed_at = None
        try:
            last_pushed_at = storage.get_last_contract_pushed_at(DIGEST_INTEREST_ID)
        except Exception as e:
            print(f"[静流] 摘要间隔判定查询失败（按到期处理）: {e}")
            return True
        if not last_pushed_at:
            return True
        try:
            from datetime import datetime

            last_dt = datetime.fromisoformat(str(last_pushed_at))
        except ValueError:
            return True
        from datetime import timedelta

        return now >= last_dt + timedelta(minutes=interval_minutes)

    # ========================================
    # 执行
    # ========================================

    def run_if_due(self) -> Dict[str, Any]:
        """
        到期则把 pending 契约聚合为一条摘要推送。

        Returns:
            {"due": bool, "pending": int, "pushed": int}
        """
        config = self.ctx.config.get("JINGLIU", {}).get("DIGEST", {})
        if not config.get("ENABLED", False):
            return {"due": False, "pending": 0, "pushed": 0}

        interval_minutes = config.get("INTERVAL_MINUTES", 240)
        max_items = config.get("MAX_ITEMS", 10)
        min_confidence = config.get("MIN_CONFIDENCE", "low")

        storage = self.ctx.get_storage_manager()
        now = self.ctx.get_time()

        if not self._is_due(storage, now, interval_minutes):
            return {"due": False, "pending": 0, "pushed": 0}

        try:
            pending = storage.get_pending_contracts(min_confidence, max_items) or []
        except Exception as e:
            print(f"[静流] 摘要池读取失败: {e}")
            return {"due": True, "pending": 0, "pushed": 0}

        if not pending:
            return {"due": True, "pending": 0, "pushed": 0}

        contract = self._build_digest_contract(pending, now)
        print(f"[静流] 摘要到点：聚合 {len(pending)} 条低置信度契约")

        builder = self.ctx.get_push_contract_builder()
        gate = builder.gate_and_rank([contract], source_kind="digest")
        if not gate.pushable:
            return {"due": True, "pending": len(pending), "pushed": 0}

        dispatcher = self.ctx.create_notification_dispatcher()
        results = dispatcher.dispatch_contracts(gate.pushable)
        builder.record_pushed(gate.pushable, results)

        pushed_any = any(results.values()) if results else False
        if pushed_any:
            self._mark_items_delivered(storage, pending)
        return {"due": True, "pending": len(pending), "pushed": len(gate.pushable) if pushed_any else 0}

    # ========================================
    # 构建与回写
    # ========================================

    def _build_digest_contract(self, pending: List[Dict], now) -> PushContract:
        """聚合契约：指纹含分钟级时间戳（每次摘要唯一）；detail 携带条目清单"""
        items = [
            {
                "title": str(item.get("payload", {}).get("body") or item.get("hit_reason", {}).get("text", ""))[:60],
                "url": item.get("source_attribution", {}).get("url", ""),
                "confidence": item.get("confidence", "low"),
                "interest_id": item.get("interest_id", ""),
            }
            for item in pending
        ]
        texts = [item["title"] for item in items if item["title"]]
        preview = "；".join(texts[:3])
        if len(texts) > 3:
            preview += f" 等 {len(texts)} 条"

        # 指纹含分钟级时间戳，保证每次摘要互不撞车
        now_stamp = now.strftime("%Y-%m-%d %H:%M")
        return PushContract(
            content_fingerprint=make_fingerprint("digest", now_stamp),
            interest_id=DIGEST_INTEREST_ID,
            hit_reason=HitReason(
                kind="digest",
                text=f"低置信度摘要：{len(pending)} 条内容待你判断：{preview}",
                detail={"items": items},
            ),
            source_attribution=SourceAttribution(
                platform="digest",
                platform_name="摘要池",
                url="",
                source_type="digest",
            ),
            confidence="medium",
        )

    def _mark_items_delivered(self, storage, pending: List[Dict]) -> None:
        """digest 覆盖的 pending 契约标记为已推送（channel=digest）"""
        from trendradar.jingliu.contracts import PushContractBuilder

        pushed_at = ""
        if self.ctx.get_time:
            try:
                pushed_at = self.ctx.get_time().isoformat(timespec="seconds")
            except Exception:
                pushed_at = ""
        if not pushed_at:
            from datetime import datetime

            pushed_at = datetime.now().isoformat(timespec="seconds")

        delivered = 0
        for item in pending:
            try:
                if storage.mark_contract_pushed(item.get("id"), "digest", pushed_at):
                    delivered += 1
            except Exception as e:
                print(f"[静流] 摘要条目标记失败: {e}")
        print(f"[静流] 摘要送达：{delivered}/{len(pending)} 条 pending 契约已标记（channel=digest）")
