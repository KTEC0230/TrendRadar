# coding=utf-8
"""
静流移动端直连推送渠道

- APNs：HTTP/2 Provider API（.p8 token 鉴权）
- FCM：HTTP v1 API（service account OAuth2）

依赖 httpx[http2] / PyJWT / cryptography，均延迟导入：
未启用 jingliu 推送时不增加启动开销，未安装依赖时报错清晰。
"""

from trendradar.notifiers.apns_notifier import build_apns_payload, send_to_apns
from trendradar.notifiers.fcm_notifier import build_fcm_message, send_to_fcm

__all__ = [
    "build_apns_payload",
    "build_fcm_message",
    "send_to_apns",
    "send_to_fcm",
]
