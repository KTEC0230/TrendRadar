import unittest
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytz

from trendradar.jingliu.digest import DIGEST_INTEREST_ID, DigestScheduler
from trendradar.jingliu.contracts import PushContractBuilder


TZ = pytz.timezone("Asia/Shanghai")


class FakeStorage:
    """DigestScheduler 依赖的窄接口内存实现"""

    def __init__(self):
        self.contracts = []          # push_contracts 台账
        self._next_id = 1

    # ---- DigestScheduler / builder 使用 ----
    def get_last_contract_pushed_at(self, interest_id):
        times = [c["pushed_at"] for c in self.contracts
                 if c["interest_id"] == interest_id and c.get("pushed_at")]
        return max(times) if times else None

    def get_pending_contracts(self, min_confidence="medium", limit=100):
        order = {"high": 3, "medium": 2, "low": 1}
        threshold = order.get(min_confidence, 2)
        pending = [c for c in self.contracts if not c.get("pushed_at")]
        return [c for c in pending if order.get(c["confidence"], 1) >= threshold][:limit]

    def is_fingerprint_pushed(self, fingerprint):
        return any(c["content_fingerprint"] == fingerprint and c.get("pushed_at")
                   for c in self.contracts)

    def save_push_contract(self, record):
        cid = self._next_id
        self._next_id += 1
        self.contracts.append({"id": cid, **record})
        return cid

    def mark_contract_pushed(self, contract_id, channel, pushed_at_iso):
        for c in self.contracts:
            if c["id"] == contract_id and not c.get("pushed_at"):
                c["pushed_at"] = pushed_at_iso
                c["channel"] = channel
                return True
        return False


class FakeDispatcher:
    def __init__(self):
        self.sent = []

    def dispatch_contracts(self, contracts):
        self.sent.extend(contracts)
        return {"apns": True}


def _make_ctx(storage, now, digest_config):
    builder = PushContractBuilder(
        config={"JINGLIU": {"DIGEST": digest_config}},
        state_store=storage,
        get_time_func=lambda: now,
    )
    dispatcher = FakeDispatcher()
    ctx = SimpleNamespace(config={"JINGLIU": {"DIGEST": digest_config}})
    ctx.get_time = lambda: now
    ctx.get_storage_manager = lambda: storage
    ctx.get_push_contract_builder = lambda: builder
    ctx.create_notification_dispatcher = lambda: dispatcher
    return ctx, dispatcher


def _seed_pending(storage, n=2):
    for i in range(n):
        storage.save_push_contract({
            "content_fingerprint": f"fp-pending-{i}",
            "interest_id": f"tag-{i}",
            "hit_reason": {"kind": "ai", "text": f"相关度 0.4{i}", "detail": {}},
            "confidence": "low",
            "source_attribution": {"platform": "weibo", "url": f"https://a.com/{i}"},
            "payload": {"body": f"与你的兴趣『tag-{i}』相关度 0.4{i}"},
            "pushed_at": None,
            "channel": "",
        })


DIGEST_CFG = {"ENABLED": True, "INTERVAL_MINUTES": 240, "MAX_ITEMS": 10, "MIN_CONFIDENCE": "low"}


class DigestTests(unittest.TestCase):
    def test_disabled_returns_not_due(self):
        storage = FakeStorage()
        _seed_pending(storage)
        ctx, _ = _make_ctx(storage, datetime.now(TZ), {**DIGEST_CFG, "ENABLED": False})
        result = DigestScheduler(ctx).run_if_due()
        self.assertFalse(result["due"])
        self.assertEqual(result["pushed"], 0)
        self.assertEqual(len(storage.get_pending_contracts("low")), 2)  # 未消费

    def test_first_run_pushes_and_marks_delivered(self):
        storage = FakeStorage()
        _seed_pending(storage, 3)
        ctx, dispatcher = _make_ctx(storage, datetime.now(TZ), DIGEST_CFG)
        result = DigestScheduler(ctx).run_if_due()

        self.assertTrue(result["due"])
        self.assertEqual(result["pending"], 3)
        self.assertEqual(result["pushed"], 1)
        self.assertEqual(len(dispatcher.sent), 1)

        digest_contract = dispatcher.sent[0]
        self.assertEqual(digest_contract.interest_id, DIGEST_INTEREST_ID)
        self.assertIn("3 条内容待你判断", digest_contract.hit_reason.text)

        # digest 覆盖的 3 条 pending 标记 channel=digest；digest 自身契约走 apns 渠道
        delivered = [c for c in storage.contracts if c.get("channel") == "digest"]
        self.assertEqual(len(delivered), 3)
        self.assertEqual([c for c in storage.contracts if c["interest_id"] == DIGEST_INTEREST_ID][0]["channel"], "apns")

    def test_interval_not_due_right_after_push(self):
        storage = FakeStorage()
        _seed_pending(storage)
        now = datetime.now(TZ)
        ctx, _ = _make_ctx(storage, now, DIGEST_CFG)
        DigestScheduler(ctx).run_if_due()

        # 10 分钟后再跑：未到 240 分钟间隔，且 pending 已清空
        ctx2, dispatcher2 = _make_ctx(storage, now + timedelta(minutes=10), DIGEST_CFG)
        result = DigestScheduler(ctx2).run_if_due()
        self.assertFalse(result["due"])
        self.assertEqual(len(dispatcher2.sent), 0)

    def test_due_again_after_interval_with_new_pending(self):
        storage = FakeStorage()
        _seed_pending(storage)
        now = datetime.now(TZ)
        ctx, _ = _make_ctx(storage, now, DIGEST_CFG)
        DigestScheduler(ctx).run_if_due()

        _seed_pending(storage, 1)  # 新增一条 pending
        ctx2, dispatcher2 = _make_ctx(storage, now + timedelta(minutes=241), DIGEST_CFG)
        result = DigestScheduler(ctx2).run_if_due()
        self.assertTrue(result["due"])
        self.assertEqual(result["pushed"], 1)
        self.assertEqual(len(dispatcher2.sent), 1)
        # 两次 digest 指纹不同（时间戳入指纹）
        fp2 = dispatcher2.sent[0].content_fingerprint
        earlier_fps = {c["content_fingerprint"] for c in storage.contracts}
        earlier_fps.discard(fp2)
        self.assertNotIn(fp2, earlier_fps)

    def test_empty_pending_does_not_reset_interval_or_push(self):
        storage = FakeStorage()
        now = datetime.now(TZ)
        ctx, dispatcher = _make_ctx(storage, now, DIGEST_CFG)
        result = DigestScheduler(ctx).run_if_due()
        self.assertTrue(result["due"])
        self.assertEqual(result["pending"], 0)
        self.assertEqual(len(dispatcher.sent), 0)
        self.assertIsNone(storage.get_last_contract_pushed_at(DIGEST_INTEREST_ID))

    def test_max_items_caps_digest(self):
        storage = FakeStorage()
        _seed_pending(storage, 5)
        ctx, dispatcher = _make_ctx(
            storage, datetime.now(TZ), {**DIGEST_CFG, "MAX_ITEMS": 2}
        )
        DigestScheduler(ctx).run_if_due()
        digest = dispatcher.sent[0]
        self.assertEqual(len(digest.hit_reason.detail["items"]), 2)

    def test_digest_payload_shaped_for_mobile(self):
        storage = FakeStorage()
        _seed_pending(storage, 1)
        ctx, dispatcher = _make_ctx(storage, datetime.now(TZ), DIGEST_CFG)
        DigestScheduler(ctx).run_if_due()
        payload = dispatcher.sent[0].to_notification_payload()
        self.assertEqual(payload["title"], "静流 · 摘要池")
        self.assertIn("低置信度摘要", payload["body"])
        self.assertEqual(payload["hit_reason"]["kind"], "digest")
        self.assertTrue(payload["hit_reason"]["detail"]["items"])


if __name__ == "__main__":
    unittest.main()
