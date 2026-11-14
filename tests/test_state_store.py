import shutil
import tempfile
import unittest
from pathlib import Path

from trendradar.storage.local import LocalStorageBackend


class StateStoreIntegrationTests(unittest.TestCase):
    """静流 state 库（jingliu_schema.sql）建表与 CRUD 全链路验证"""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="jingliu_test_")
        self.backend = LocalStorageBackend(data_dir=self.temp_dir, enable_txt=False, enable_html=False)

    def tearDown(self):
        self.backend.cleanup()
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _db_path(self) -> Path:
        return Path(self.temp_dir) / "state" / "state.db"

    def test_source_register_and_list(self):
        source_id = self.backend.register_source({
            "type": "webpage",
            "platform": "webpage",
            "external_id": "https://a.com/x",
            "name": "测试页",
            "config": {"url": "https://a.com/x"},
            "check_interval": 30,
            "selector_config": {"body_selector": "#content", "min_change_chars": 50},
        })
        self.assertGreater(source_id, 0)
        self.assertTrue(self._db_path().exists())

        sources = self.backend.list_sources(source_type="webpage")
        self.assertEqual(len(sources), 1)
        # JSON 列已反序列化为 dict
        self.assertEqual(sources[0]["config"]["url"], "https://a.com/x")
        self.assertEqual(sources[0]["selector_config"]["body_selector"], "#content")

        # 同 external_id 重复注册 = 更新，不新增行
        again_id = self.backend.register_source({
            "type": "webpage",
            "platform": "webpage",
            "external_id": "https://a.com/x",
            "name": "测试页（改名）",
            "config": {"url": "https://a.com/x"},
            "check_interval": 60,
            "selector_config": {},
        })
        self.assertEqual(again_id, source_id)
        self.assertEqual(len(self.backend.list_sources(source_type="webpage")), 1)
        self.assertEqual(self.backend.list_sources()[0]["check_interval"], 60)

    def test_update_source_check_and_due_fields(self):
        source_id = self.backend.register_source({
            "type": "webpage", "external_id": "u1", "name": "n1",
            "config": {"url": "u1"}, "check_interval": 30,
        })
        self.assertTrue(self.backend.update_source_check(source_id, "2026-11-14T10:00:00", "no-change"))
        source = self.backend.get_source(source_id)
        self.assertEqual(source["last_checked_at"], "2026-11-14T10:00:00")
        self.assertEqual(source["last_message"], "no-change")

        self.assertTrue(self.backend.set_source_status(source_id, "paused"))
        self.assertEqual(self.backend.list_sources(status="active"), [])
        self.assertEqual(len(self.backend.list_sources(status="paused")), 1)

    def test_push_contract_ledger_roundtrip(self):
        fingerprint = "fp-roundtrip"
        self.assertFalse(self.backend.is_fingerprint_pushed(fingerprint))

        contract_id = self.backend.save_push_contract({
            "content_fingerprint": fingerprint,
            "interest_id": "tag-a",
            "hit_reason": {"kind": "keyword", "text": "命中了关键词『tag-a』", "detail": {}},
            "confidence": "high",
            "source_attribution": {"platform": "weibo", "url": "https://a.com"},
            "payload": {"body": "命中了关键词『tag-a』"},
            "pushed_at": None,
            "channel": "",
        })
        self.assertGreater(contract_id, 0)
        # 未推送不占用指纹
        self.assertFalse(self.backend.is_fingerprint_pushed(fingerprint))

        self.assertTrue(self.backend.mark_contract_pushed(contract_id, "apns", "2026-11-14T11:00:00"))
        self.assertTrue(self.backend.is_fingerprint_pushed(fingerprint))

        # 同指纹二次标记推送（模拟并发）应被部分唯一索引拦截
        second_id = self.backend.save_push_contract({
            "content_fingerprint": fingerprint,
            "interest_id": "tag-b",
            "hit_reason": {"kind": "ai", "text": "x", "detail": {}},
            "confidence": "medium",
            "source_attribution": {},
            "payload": {},
            "pushed_at": None,
            "channel": "",
        })
        self.assertFalse(self.backend.mark_contract_pushed(second_id, "apns", "2026-11-14T12:00:00"))

        pending = self.backend.get_pending_contracts()
        self.assertEqual(len(pending), 1)  # 只剩第二条未推送记录
        self.assertEqual(pending[0]["hit_reason"]["kind"], "ai")

    def test_webpage_diff_roundtrip(self):
        self.backend.register_source({
            "type": "webpage", "external_id": "u2", "name": "n2",
            "config": {"url": "u2"}, "check_interval": 30,
        })
        diff_id = self.backend.save_webpage_diff({
            "source_id": 1,
            "previous_fingerprint": "",
            "current_fingerprint": "fp-base",
            "diff_summary": {"blocks": [{"type": "title", "text": "基线"}], "change_chars": 0},
        })
        self.assertGreater(diff_id, 0)

        latest = self.backend.get_latest_webpage_diff(1)
        self.assertEqual(latest["current_fingerprint"], "fp-base")
        self.assertEqual(latest["diff_summary"]["blocks"][0]["text"], "基线")

        # 再次写入后取最新
        self.backend.save_webpage_diff({
            "source_id": 1,
            "previous_fingerprint": "fp-base",
            "current_fingerprint": "fp-next",
            "diff_summary": {"blocks": [{"type": "title", "text": "新基线"}], "change_chars": 3},
        })
        self.assertEqual(self.backend.get_latest_webpage_diff(1)["current_fingerprint"], "fp-next")
        self.assertIsNone(self.backend.get_latest_webpage_diff(999))


if __name__ == "__main__":
    unittest.main()
