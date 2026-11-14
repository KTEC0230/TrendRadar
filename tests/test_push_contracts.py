import unittest

from trendradar.jingliu.contracts import (
    GateResult,
    HitReason,
    PushContract,
    PushContractBuilder,
    SourceAttribution,
    make_fingerprint,
)


class FakeStateStore:
    """PushContractBuilder 依赖的窄接口内存实现"""

    def __init__(self):
        self.contracts = []  # [{"id", "content_fingerprint", "pushed_at", ...}]
        self._next_id = 1

    def is_fingerprint_pushed(self, fingerprint: str) -> bool:
        return any(
            c["content_fingerprint"] == fingerprint and c.get("pushed_at")
            for c in self.contracts
        )

    def save_push_contract(self, record) -> int:
        contract_id = self._next_id
        self._next_id += 1
        self.contracts.append({"id": contract_id, **record})
        return contract_id

    def mark_contract_pushed(self, contract_id: int, channel: str, pushed_at_iso: str) -> bool:
        for c in self.contracts:
            if c["id"] == contract_id and not c.get("pushed_at"):
                # 模拟部分唯一索引：同指纹已推送则拒绝
                if any(
                    o["content_fingerprint"] == c["content_fingerprint"]
                    and o.get("pushed_at") and o["id"] != contract_id
                    for o in self.contracts
                ):
                    return False
                c["pushed_at"] = pushed_at_iso
                c["channel"] = channel
                return True
        return False


def _contract(fingerprint, confidence="high", interest="tag-a", kind="ai"):
    return PushContract(
        content_fingerprint=fingerprint,
        interest_id=interest,
        hit_reason=HitReason(kind=kind, text="test reason"),
        source_attribution=SourceAttribution(platform="p", platform_name="P", url=""),
        confidence=confidence,
    )


class FingerprintTests(unittest.TestCase):
    def test_fingerprint_is_stable_and_case_insensitive(self):
        self.assertEqual(make_fingerprint("https://a.com/x", "weibo"), make_fingerprint("https://a.com/x", "weibo"))
        self.assertEqual(make_fingerprint("ABC"), make_fingerprint("abc"))
        self.assertNotEqual(make_fingerprint("a", "b"), make_fingerprint("a"))
        self.assertNotEqual(make_fingerprint("a b"), make_fingerprint("a  b").replace("x", "y"))

    def test_url_wins_over_title_difference(self):
        # 构建器以 (url or title, platform) 入指纹：同一 URL 标题微调 → 同指纹，应判重
        builder = PushContractBuilder(config={}, state_store=FakeStateStore())
        stats_a = [{"word": "w", "titles": [{"title": "标题甲", "url": "https://a.com/x", "source_name": "weibo"}]}]
        stats_b = [{"word": "w", "titles": [{"title": "标题乙", "url": "https://a.com/x", "source_name": "weibo"}]}]
        fp_a = builder.build_from_stats(stats_a, filter_method="keyword")[0].content_fingerprint
        fp_b = builder.build_from_stats(stats_b, filter_method="keyword")[0].content_fingerprint
        self.assertEqual(fp_a, fp_b)


class BuildFromStatsTests(unittest.TestCase):
    def setUp(self):
        self.builder = PushContractBuilder(config={}, state_store=FakeStateStore())

    def test_keyword_hit_reason_uses_actual_word(self):
        stats = [{"word": "AI Agent", "count": 1, "titles": [
            {"title": "某产品发布", "url": "https://a.com/1", "source_name": "weibo"},
        ]}]
        contracts = self.builder.build_from_stats(stats, filter_method="keyword", source_type="hotlist")
        self.assertEqual(len(contracts), 1)
        self.assertEqual(contracts[0].hit_reason.text, "命中了关键词『AI Agent』")
        self.assertEqual(contracts[0].hit_reason.kind, "keyword")
        self.assertEqual(contracts[0].confidence, "high")
        self.assertEqual(contracts[0].source_attribution.url, "https://a.com/1")

    def test_ai_reason_prefers_llm_reason(self):
        stats = [{"word": "AI Agent", "count": 1, "titles": [
            {"title": "t", "url": "", "source_name": "rss-x",
             "relevance_score": 0.87, "reason": "标题明确提到Agent产品"},
        ]}]
        contracts = self.builder.build_from_stats(stats, filter_method="ai", source_type="rss")
        self.assertEqual(contracts[0].hit_reason.text, "标题明确提到Agent产品")
        self.assertEqual(contracts[0].confidence, "high")  # 0.87 >= 0.8

    def test_ai_reason_falls_back_to_score_text(self):
        stats = [{"word": "AI Agent", "count": 1, "titles": [
            {"title": "t", "url": "", "source_name": "s", "relevance_score": 0.6},
        ]}]
        contracts = self.builder.build_from_stats(stats, filter_method="ai", source_type="hotlist")
        self.assertIn("相关度 0.60", contracts[0].hit_reason.text)
        self.assertEqual(contracts[0].confidence, "medium")

    def test_ai_confidence_bands(self):
        low = [{"word": "w", "titles": [{"title": "t", "relevance_score": 0.3}]}]
        contracts = self.builder.build_from_stats(low, filter_method="ai")
        self.assertEqual(contracts[0].confidence, "low")


class GateTests(unittest.TestCase):
    def setUp(self):
        self.store = FakeStateStore()
        self.builder = PushContractBuilder(config={}, state_store=self.store)

    def test_same_fingerprint_pushed_once(self):
        contracts = [_contract("fp-1")]
        gate1 = self.builder.gate_and_rank(contracts)
        self.assertEqual(len(gate1.pushable), 1)
        self.builder.record_pushed(gate1.pushable, {"apns": True})

        gate2 = self.builder.gate_and_rank([_contract("fp-1")])
        self.assertEqual(len(gate2.pushable), 0)
        self.assertEqual(gate2.suppressed[0]["reason"], "duplicate_fingerprint")

    def test_pending_low_confidence_does_not_block_high(self):
        # 低置信度未推送记录不应占用指纹（闸 1 只看已推送记录）
        contracts = [_contract("fp-2", confidence="low")]
        gate = self.builder.gate_and_rank(contracts)
        self.assertEqual(len(gate.pushable), 1)  # 未推送（不入 pushed 台账）

        contracts_high = [_contract("fp-2", confidence="high")]
        gate2 = self.builder.gate_and_rank(contracts_high)
        self.assertEqual(len(gate2.pushable), 1)  # 仍可推送

    def test_cross_source_keeps_highest_confidence(self):
        contracts = [_contract("fp-3", confidence="medium", interest="b-tag"),
                     _contract("fp-3", confidence="high", interest="a-tag")]
        gate = self.builder.gate_and_rank(contracts)
        self.assertEqual(len(gate.pushable), 1)
        self.assertEqual(gate.pushable[0].confidence, "high")
        self.assertEqual(gate.suppressed[0]["reason"], "lower_confidence_cross_source")

    def test_cross_source_tie_breaks_by_interest_id(self):
        contracts = [_contract("fp-4", confidence="medium", interest="zzz"),
                     _contract("fp-4", confidence="medium", interest="aaa")]
        gate = self.builder.gate_and_rank(contracts)
        self.assertEqual(gate.pushable[0].interest_id, "aaa")

    def test_webpage_below_threshold_suppressed(self):
        config = {"JINGLIU": {"WEBPAGE": {"MIN_CHANGE_CHARS": 50}}}
        builder = PushContractBuilder(config=config, state_store=self.store)
        contract = PushContract(
            content_fingerprint=make_fingerprint("u", "c1"),
            interest_id="source:1",
            hit_reason=HitReason(kind="webpage_change", text="x",
                                 detail={"change_chars": 10}),
            source_attribution=SourceAttribution(platform="webpage", platform_name="w"),
            confidence="medium",
        )
        gate = builder.gate_and_rank([contract])
        self.assertEqual(len(gate.pushable), 0)
        self.assertEqual(gate.suppressed[0]["reason"], "below_change_threshold")

    def test_webpage_repeated_push_not_blocked_by_hotlist_fingerprint(self):
        # 热榜同指纹已推送，webpage 变更（指纹包含内容 hash）不受闸 1 影响
        gate1 = self.builder.gate_and_rank([_contract(make_fingerprint("u", "c0"))])
        self.builder.record_pushed(gate1.pushable, {"apns": True})
        contract = PushContract(
            content_fingerprint=make_fingerprint("u", "c0"),  # 恰好撞上热榜指纹
            interest_id="source:1",
            hit_reason=HitReason(kind="webpage_change", text="x", detail={"change_chars": 80}),
            source_attribution=SourceAttribution(platform="webpage", platform_name="w"),
            confidence="high",
        )
        gate = self.builder.gate_and_rank([contract])
        self.assertEqual(len(gate.pushable), 1)

    def test_record_pushed_writes_ledger(self):
        gate = self.builder.gate_and_rank([_contract("fp-5")])
        self.builder.record_pushed(gate.pushable, {"apns": True, "fcm": False})
        pushed = [c for c in self.store.contracts if c.get("pushed_at")]
        self.assertEqual(len(pushed), 1)
        self.assertEqual(pushed[0]["channel"], "apns")

    def test_payload_carries_hit_reason(self):
        contract = _contract("fp-6")
        payload = contract.to_notification_payload()
        self.assertEqual(payload["body"], "test reason")
        self.assertEqual(payload["hit_reason"]["kind"], "ai")
        self.assertIn("confidence", payload)
        self.assertIn("url", payload)


if __name__ == "__main__":
    unittest.main()
