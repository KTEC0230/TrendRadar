import json
import shutil
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

import requests

from trendradar.jingliu.api_server import JingliuApiServer, make_handler


class ApiIntegrationTests(unittest.TestCase):
    """静流 App API 集成测试：真实起 ThreadingHTTPServer + requests 调用"""

    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.mkdtemp(prefix="jingliu_api_test_")
        (Path(cls.temp_dir) / "state").mkdir(parents=True, exist_ok=True)

        config = {
            "TIMEZONE": "Asia/Shanghai",
            "STORAGE": {"LOCAL": {"DATA_DIR": cls.temp_dir}},
            "JINGLIU": {
                "ENABLED": True,
                "WEBPAGE": {"MIN_CHANGE_CHARS": 50, "COOLDOWN_MINUTES": 15, "REQUEST_TIMEOUT": 15},
            },
        }
        cls.server_core = JingliuApiServer(config, "127.0.0.1", 0, "test-token-123")
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(cls.server_core))
        cls.port = cls.httpd.server_address[1]
        cls.base = f"http://127.0.0.1:{cls.port}/api"
        cls.headers = {"Authorization": "Bearer test-token-123"}
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.temp_dir, ignore_errors=True)

    def _get(self, path, **kwargs):
        return requests.get(f"{self.base}{path}", headers=self.headers, timeout=10, **kwargs)

    def _post(self, path, payload=None):
        return requests.post(f"{self.base}{path}", headers=self.headers, json=payload, timeout=10)

    def _put(self, path, payload=None):
        return requests.put(f"{self.base}{path}", headers=self.headers, json=payload, timeout=10)

    def _delete(self, path, **kwargs):
        return requests.delete(f"{self.base}{path}", headers=self.headers, timeout=10, **kwargs)

    # ---- 鉴权 ----

    def test_health_no_auth(self):
        response = requests.get(f"{self.base}/health", timeout=10)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")

    def test_auth_required_and_wrong_token(self):
        self.assertEqual(requests.get(f"{self.base}/sources", timeout=10).status_code, 401)
        bad = requests.get(f"{self.base}/sources",
                           headers={"Authorization": "Bearer wrong"}, timeout=10)
        self.assertEqual(bad.status_code, 401)

    def test_unknown_endpoint_404(self):
        response = self._get("/nope")
        self.assertEqual(response.status_code, 404)

    # ---- 设备注册 → 推送合并的闭环 ----

    def test_device_register_list_delete(self):
        created = self._post("/devices", {"channel": "apns", "device_token": "tok-abc", "device_name": "iPhone"})
        self.assertEqual(created.status_code, 201)

        devices = self._get("/devices", params={"channel": "apns"}).json()["devices"]
        self.assertEqual(len(devices), 1)
        self.assertEqual(devices[0]["device_token"], "tok-abc")

        # 重复注册 = 刷新，不新增行
        self._post("/devices", {"channel": "apns", "device_token": "tok-abc"})
        devices = self._get("/devices").json()["devices"]
        self.assertEqual(len(devices), 1)

        deleted = self._delete("/devices", params={"channel": "apns", "device_token": "tok-abc"})
        self.assertEqual(deleted.json()["deleted"], True)
        self.assertEqual(len(self._get("/devices").json()["devices"]), 0)

    def test_device_register_validation(self):
        self.assertEqual(self._post("/devices", {"channel": "xxx", "device_token": "t"}).status_code, 400)
        self.assertEqual(self._post("/devices", {"channel": "apns", "device_token": "  "}).status_code, 400)

    # ---- 源管理 ----

    def test_source_crud(self):
        created = self._post("/sources", {
            "type": "webpage",
            "name": "测试页",
            "config": {"url": "https://example.com/a"},
            "check_interval": 45,
            "selector_config": {"body_selector": "#content", "min_change_chars": 30},
        })
        self.assertEqual(created.status_code, 201)
        source_id = created.json()["id"]
        self.assertEqual(created.json()["source"]["config"]["url"], "https://example.com/a")

        # external_id 默认取 url
        self.assertEqual(created.json()["source"]["external_id"], "https://example.com/a")

        # 列表 + 单查
        sources = self._get("/sources", params={"type": "webpage"}).json()["sources"]
        self.assertEqual(len(sources), 1)
        single = self._get(f"/sources/{source_id}").json()["source"]
        self.assertEqual(single["check_interval"], 45)

        # 更新（部分字段）
        updated = self._put(f"/sources/{source_id}", {"name": "改名", "status": "paused"})
        self.assertEqual(updated.json()["source"]["name"], "改名")
        self.assertEqual(updated.json()["source"]["status"], "paused")

        # type 不可改
        self.assertEqual(self._put(f"/sources/{source_id}", {"type": "douyin"}).status_code, 400)

        # config 更新校验（webpage 必须带合法 url）
        self.assertEqual(
            self._put(f"/sources/{source_id}", {"config": {"url": "not-a-url"}}).status_code, 400
        )

        # 删除
        deleted = self._delete(f"/sources/{source_id}")
        self.assertEqual(deleted.json()["deleted"], True)
        self.assertEqual(self._get(f"/sources/{source_id}").status_code, 404)

    def test_source_validation(self):
        # 非法类型
        self.assertEqual(self._post("/sources", {"type": "hotlist", "name": "x"}).status_code, 400)
        # webpage 缺 url
        self.assertEqual(self._post("/sources", {"type": "webpage", "name": "x"}).status_code, 400)
        # douyin 缺路由参数
        self.assertEqual(
            self._post("/sources", {"type": "douyin", "name": "x", "config": {"route": "user"}}).status_code,
            400,
        )
        # douyin 未知路由
        self.assertEqual(
            self._post("/sources", {"type": "douyin", "name": "x", "config": {"route": "xxx", "rid": "1"}}).status_code,
            400,
        )

    # ---- 契约：推送流 / 摘要池 / 反馈 ----

    def test_contracts_recent_pending_feedback(self):
        # 直接经存储层预置两条契约（一条已推送、一条待推送）
        from trendradar.storage.local import LocalStorageBackend

        backend = LocalStorageBackend(data_dir=self.temp_dir, enable_txt=False, enable_html=False)
        try:
            pushed_id = backend.save_push_contract({
                "content_fingerprint": "fp-api-1", "interest_id": "tag-a",
                "hit_reason": {"kind": "keyword", "text": "命中了关键词『tag-a』", "detail": {}},
                "confidence": "high",
                "source_attribution": {"platform": "weibo", "url": "https://a.com"},
                "payload": {"body": "命中了关键词『tag-a』"}, "pushed_at": None, "channel": "",
            })
            backend.mark_contract_pushed(pushed_id, "apns", "2026-11-14T12:00:00")
            backend.save_push_contract({
                "content_fingerprint": "fp-api-2", "interest_id": "tag-b",
                "hit_reason": {"kind": "ai", "text": "相关度 0.42", "detail": {}},
                "confidence": "low",
                "source_attribution": {}, "payload": {}, "pushed_at": None, "channel": "",
            })
        finally:
            backend.cleanup()

        # 推送流：只含已推送
        recent = self._get("/contracts/recent").json()["contracts"]
        self.assertEqual(len(recent), 1)
        self.assertEqual(recent[0]["content_fingerprint"], "fp-api-1")
        self.assertEqual(recent[0]["hit_reason"]["text"], "命中了关键词『tag-a』")

        # 摘要池：只含未推送
        pending = self._get("/contracts/pending", params={"min_confidence": "low"}).json()["contracts"]
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["confidence"], "low")

        # 反馈：写 + 非法值 + 不存在的 id
        ok = self._post(f"/contracts/{pushed_id}/feedback", {"feedback": "useful"})
        self.assertEqual(ok.json()["updated"], True)
        self.assertEqual(self._post(f"/contracts/{pushed_id}/feedback", {"feedback": "meh"}).status_code, 400)
        self.assertEqual(self._post("/contracts/99999/feedback", {"feedback": "useful"}).status_code, 404)

        # 反馈落库验证
        recent = self._get("/contracts/recent").json()["contracts"]
        self.assertEqual(recent[0]["user_feedback"], "useful")

    # ---- 兴趣文件 ----

    def test_interests_get_put(self):
        # GET（config/ai_interests.txt 在仓库中存在）
        data = self._get("/interests").json()
        self.assertIn("ai_interests", data)
        self.assertIn("frequency_words", data)

        # PUT ai_interests：写临时内容 → 验证 .bak 备份 → 恢复原内容
        original = Path("config/ai_interests.txt").read_text(encoding="utf-8")
        bak = Path("config/ai_interests.txt.bak")
        try:
            response = self._put("/interests", {"target": "ai_interests", "content": "测试兴趣内容"})
            self.assertEqual(response.json()["updated"], True)
            self.assertEqual(Path("config/ai_interests.txt").read_text(encoding="utf-8"), "测试兴趣内容")
            self.assertEqual(bak.read_text(encoding="utf-8"), original)
        finally:
            Path("config/ai_interests.txt").write_text(original, encoding="utf-8")
            if bak.exists():
                bak.unlink()

        # 非法 target / 超大 content
        self.assertEqual(self._put("/interests", {"target": "nope", "content": "x"}).status_code, 400)
        self.assertEqual(self._put("/interests", {"target": "ai_interests", "content": "x" * 400 * 1024}).status_code, 413)

    def test_malformed_json_body(self):
        response = requests.post(
            f"{self.base}/sources",
            headers={**self.headers, "Content-Type": "application/json"},
            data="{not-json",
            timeout=10,
        )
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
