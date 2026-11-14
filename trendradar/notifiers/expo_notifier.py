# coding=utf-8
"""
Expo 推送通道

经 Expo 官方 push 服务（exp.host）转发 FCM，到达 Expo App：
后端无需 Google service account 凭据，只需要 App 注册的 ExpoPushToken。

协议：POST https://exp.host/--/api/v2/push/send
响应：{"data": {"status": "ok", "id": "..."}, "errors": []}（单条 to 时 data 为对象，
批量时为数组——本实现逐条发送，恒为对象）。

App 侧（mobile/）注册流程见 mobile/README.md。
"""

from typing import Any, Dict

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"


def build_expo_message(payload: Dict[str, Any], expo_push_token: str) -> Dict[str, Any]:
    """
    构造 Expo push 消息体。

    Args:
        payload: PushContract.to_notification_payload() 的结果
        expo_push_token: App 注册的 ExpoPushToken[...] 字符串

    Returns:
        Expo 协议消息（channelId 与 App 端建的 "jingliu" 通知渠道对应）
    """
    return {
        "to": expo_push_token,
        "title": payload.get("title", "静流"),
        "body": payload.get("body", ""),
        "data": {
            "fingerprint": payload.get("fingerprint", ""),
            "interest_id": payload.get("interest_id", ""),
            "confidence": payload.get("confidence", ""),
            "url": payload.get("url", ""),
            "source_type": payload.get("source_type", ""),
            "hit_reason": payload.get("hit_reason", {}),
        },
        "sound": "default",
        "priority": "high",
        "channelId": "jingliu",
    }


def send_to_expo(expo_push_token: str, payload: Dict[str, Any]) -> bool:
    """
    推送一条通知到指定 ExpoPushToken。

    Returns:
        是否发送成功（Expo data.status == "ok"）
    """
    import requests

    if not expo_push_token or not expo_push_token.startswith("ExpoPushToken["):
        print("[Expo] expo_push_token 格式非法（应以 ExpoPushToken[ 开头）")
        return False

    try:
        response = requests.post(
            EXPO_PUSH_URL,
            json=build_expo_message(payload, expo_push_token),
            headers={"Content-Type": "application/json"},
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()

        errors = data.get("errors") or []
        if errors:
            print(f"[Expo] 推送失败: {errors[0].get('message', errors)}")
            return False

        detail = data.get("data") or {}
        if detail.get("status") == "ok":
            return True
        # status=error 时带 details（常见：token 失效/设备已卸载）
        error_detail = detail.get("details") or {}
        print(f"[Expo] 推送未成功: status={detail.get('status')}, detail={error_detail.get('error', '')}")
        return False
    except Exception as e:
        print(f"[Expo] 推送异常: {type(e).__name__}: {e}")
        return False
