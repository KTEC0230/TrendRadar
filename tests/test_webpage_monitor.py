import unittest

from trendradar.collectors.webpage_monitor import (
    WebpageChangeEvent,
    WebpageMonitor,
    diff_blocks,
    extract_blocks,
    make_content_fingerprint,
    normalize_text,
)


HTML_SAMPLE = """
<html>
<head><title>测试站点</title></head>
<body>
<nav>首页 | 分类</nav>
<div id="content">
    <h1 id="page-title">文章标题 A</h1>
    <p>这是正文第一段，包含实质内容。</p>
    <p>阅读量 12345</p>
    <p>这是正文第二段。</p>
    <footer>版权所有</footer>
</div>
</body>
</html>
"""


def _make_monitor():
    monitor = WebpageMonitor(config={"JINGLIU": {"WEBPAGE": {"MIN_CHANGE_CHARS": 5, "REQUEST_TIMEOUT": 5}}})
    return monitor


class NormalizeTests(unittest.TestCase):
    def test_nfkc_and_whitespace(self):
        self.assertEqual(normalize_text("ＡＢＣ　  中文"), "ABC 中文")

    def test_default_masks_strip_counters_and_timestamps(self):
        text = "正文开始\n更新于 2026-11-14 09:30\n阅读量 12345\n正文结束\n3 小时前发布"
        result = normalize_text(text)
        self.assertIn("正文开始", result)
        self.assertIn("正文结束", result)
        self.assertNotIn("12345", result)
        self.assertNotIn("2026-11-14", result)
        self.assertNotIn("小时前", result)

    def test_custom_ignore_rules(self):
        result = normalize_text("推广位文字\n实质内容", ignore_rules=[r"^推广位文字$"])
        self.assertNotIn("推广位文字", result)
        self.assertIn("实质内容", result)

    def test_invalid_regex_is_skipped(self):
        result = normalize_text("ok", ignore_rules=["[["])
        self.assertEqual(result, "ok")


class ExtractBlocksTests(unittest.TestCase):
    def test_selector_extraction(self):
        title, blocks = extract_blocks(HTML_SAMPLE, {
            "title_selector": "#page-title",
            "body_selector": "#content",
        })
        self.assertEqual(title, "文章标题 A")
        types = [b["type"] for b in blocks]
        self.assertIn("title", types)
        self.assertIn("paragraph", types)
        # 导航/页脚/脚本不在正文容器内，不应出现
        texts = " ".join(b["text"] for b in blocks)
        self.assertNotIn("首页 | 分类", texts)
        self.assertNotIn("版权所有", texts)

    def test_heading_marked_as_title_type(self):
        _, blocks = extract_blocks(HTML_SAMPLE, {"body_selector": "#content"})
        heading = [b for b in blocks if b["text"] == "文章标题 A"]
        self.assertEqual(heading[0]["type"], "title")


class DiffTests(unittest.TestCase):
    def test_title_change_detected(self):
        prev = [{"type": "title", "text": "标题 A"}, {"type": "paragraph", "text": "正文"}]
        curr = [{"type": "title", "text": "标题 B"}, {"type": "paragraph", "text": "正文"}]
        changed, chars = diff_blocks(prev, curr)
        self.assertTrue(any(c["type"] == "title" and c["new"] == "标题 B" for c in changed))
        self.assertGreater(chars, 0)

    def test_paragraph_insert_detected(self):
        prev = [{"type": "paragraph", "text": "第一段"}]
        curr = [{"type": "paragraph", "text": "第一段"}, {"type": "paragraph", "text": "新插入的重要段落内容"}]
        changed, chars = diff_blocks(prev, curr)
        self.assertTrue(any(c["new"] == "新插入的重要段落内容" for c in changed))
        self.assertEqual(chars, len("新插入的重要段落内容"))

    def test_punctuation_only_change_counts_zero(self):
        prev = [{"type": "paragraph", "text": "内容一。"}]
        curr = [{"type": "paragraph", "text": "内容一！"}]
        changed, chars = diff_blocks(prev, curr)
        # 变更块可能被报告，但有效字符数（中文/字母数字）不变
        self.assertEqual(chars, 0)

    def test_no_change(self):
        blocks = [{"type": "paragraph", "text": "稳定内容"}]
        changed, chars = diff_blocks(blocks, blocks)
        self.assertEqual(changed, [])
        self.assertEqual(chars, 0)


class FingerprintTests(unittest.TestCase):
    def test_noise_does_not_change_fingerprint(self):
        blocks_a = [normalize_text("实质内容一", []), normalize_text("阅读量 999", [])]
        blocks_b = [normalize_text("实质内容一", []), normalize_text("阅读量 123456", [])]
        self.assertEqual(
            make_content_fingerprint(blocks_a),
            make_content_fingerprint(blocks_b),
        )

    def test_real_change_changes_fingerprint(self):
        blocks_a = [normalize_text("实质内容一")]
        blocks_b = [normalize_text("实质内容二")]
        self.assertNotEqual(
            make_content_fingerprint(blocks_a),
            make_content_fingerprint(blocks_b),
        )


class CheckSourceTests(unittest.TestCase):
    """用 monkeypatch _fetch 模拟两次抓取，验证基线/无变更/变更三态"""

    def setUp(self):
        self.monitor = _make_monitor()
        self.source = {
            "id": 1,
            "name": "测试页",
            "config": {"url": "https://example.com/page"},
            "selector_config": {"title_selector": "#page-title", "body_selector": "#content"},
        }

    def _html(self, title, extra_paragraph=""):
        return f"""
        <html><head><title>{title}</title></head><body>
        <div id="content">
            <h1 id="page-title">{title}</h1>
            <p>稳定段落内容。</p>
            {extra_paragraph}
        </div></body></html>
        """

    def test_first_check_is_baseline_and_never_pushable(self):
        self.monitor._fetch = lambda url: self._html("标题 A")
        event = self.monitor.check_source(self.source, previous=None)
        self.assertIsNotNone(event)
        self.assertTrue(event.is_baseline)
        self.assertEqual(event.change_chars, 0)

    def test_no_change_returns_none(self):
        self.monitor._fetch = lambda url: self._html("标题 A")
        first = self.monitor.check_source(self.source, None)
        previous = {"fingerprint": first.current_fingerprint, "blocks": first.blocks_snapshot}
        self.monitor._fetch = lambda url: self._html("标题 A")
        self.assertIsNone(self.monitor.check_source(self.source, previous))

    def test_title_change_event_answers_where_changed(self):
        self.monitor._fetch = lambda url: self._html("标题 A")
        first = self.monitor.check_source(self.source, None)
        previous = {"fingerprint": first.current_fingerprint, "blocks": first.blocks_snapshot}
        self.monitor._fetch = lambda url: self._html("标题 B")
        event = self.monitor.check_source(self.source, previous)

        self.assertIsNotNone(event)
        self.assertFalse(event.is_baseline)
        # 页面 <title> 与正文 <h1> 均随内容变化，title 类型变更 ≥1 条
        title_changes = [b for b in event.changed_blocks if b["type"] == "title"]
        self.assertGreaterEqual(len(title_changes), 1)
        self.assertTrue(all(c["old"] == "标题 A" and c["new"] == "标题 B" for c in title_changes))
        self.assertGreater(event.change_chars, 0)

    def test_noise_only_change_returns_none(self):
        self.monitor._fetch = lambda url: self._html("标题 A", "<p>阅读量 100</p>")
        first = self.monitor.check_source(self.source, None)
        previous = {"fingerprint": first.current_fingerprint, "blocks": first.blocks_snapshot}
        # 只有计数器变化（默认掩码剔除）
        self.monitor._fetch = lambda url: self._html("标题 A", "<p>阅读量 99999</p>")
        self.assertIsNone(self.monitor.check_source(self.source, previous))

    def test_meaningful_change_threshold(self):
        monitor = WebpageMonitor(config={"JINGLIU": {"WEBPAGE": {"MIN_CHANGE_CHARS": 10}}})
        event = WebpageChangeEvent(
            source_id=1, url="u", name="n",
            previous_fingerprint="a", current_fingerprint="b",
            changed_blocks=[{"type": "paragraph", "old": "", "new": "短"}],
            change_chars=3, selector_used="auto",
        )
        self.assertFalse(monitor.is_meaningful_change(event))
        event.change_chars = 12
        self.assertTrue(monitor.is_meaningful_change(event))

    def test_missing_url_returns_none(self):
        monitor = _make_monitor()
        self.assertIsNone(monitor.check_source({"id": 2, "config": {}}, None))


if __name__ == "__main__":
    unittest.main()
