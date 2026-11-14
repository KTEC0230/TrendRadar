import unittest
from unittest import mock

from trendradar.notifiers.expo_notifier import build_expo_message, send_to_expo


def _payload():
    return {
        "title": "静流 · 微博",
        "body": "命中了关键词『AI Agent』",
        "fingerprint": "fp-x",
        "interest_id": "AI Agent",
        "hit_reason": {"kind": "keyword", "text": "命中了关键词『AI Agent』", "detail": {}},
        "confidence": "high",
        "url": "https://a.com/1",
        "source_type": "hotlist",
    }


class BuildExpoMessageTests(unittest.TestCase):
    def test_message_shape(self):
        message = build_expo_message(_payload(), "ExpoPushToken[abc]")
        self.assertEqual(message["to"], "ExpoPushToken[abc]")
        self.assertEqual(message["title"], "静流 · 微博")
        self.assertEqual(message["body"], "命中了关键词『AI Agent』")
        self.assertEqual(message["channelId"], "jingliu")
        self.assertEqual(message["priority"], "high")
        self.assertEqual(message["data"]["fingerprint"], "fp-x")
        self.assertEqual(message["data"]["hit_reason"]["kind"], "keyword")
        self.assertEqual(message["data"]["url"], "https://a.com/1")


class SendToExpoTests(unittest.TestCase):
    def test_invalid_token_rejected_without_network(self):
        self.assertFalse(send_to_expo("not-a-token", _payload()))
        self.assertFalse(send_to_expo("", _payload()))

    def test_ok_response(self):
        response = mock.Mock()
        response.raise_for_status = mock.Mock()
        response.json.return_value = {"data": {"status": "ok", "id": "x"}, "errors": []}
        with mock.patch("requests.post", return_value=response) as post:
            ok = send_to_expo("ExpoPushToken[abc]", _payload())
        self.assertTrue(ok)
        body = post.call_args.kwargs["json"]
        self.assertEqual(body["to"], "ExpoPushToken[abc]")

    def test_error_response(self):
        response = mock.Mock()
        response.raise_for_status = mock.Mock()
        response.json.return_value = {
            "data": {"status": "error", "details": {"error": "DeviceNotRegistered"}},
            "errors": [],
        }
        with mock.patch("requests.post", return_value=response):
            self.assertFalse(send_to_expo("ExpoPushToken[abc]", _payload()))

    def test_top_level_errors(self):
        response = mock.Mock()
        response.raise_for_status = mock.Mock()
        response.json.return_value = {"data": {}, "errors": [{"message": "rate limited"}]}
        with mock.patch("requests.post", return_value=response):
            self.assertFalse(send_to_expo("ExpoPushToken[abc]", _payload()))


if __name__ == "__main__":
    unittest.main()
