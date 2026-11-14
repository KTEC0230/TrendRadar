# coding=utf-8
"""
APNs 直连推送渠道

通过 Apple HTTP/2 Provider API 直连推送（非 Bark 等第三方中继），
载荷携带 PushContractBuilder 生成的 hit_reason，移动端通知直接展示"为什么推给你"。

依赖：httpx[http2]（APNs 强制 HTTP/2）、PyJWT、cryptography（ES256 签名）。
遵循 senders.py 的渠道函数约定：输入载荷、输出 bool。
"""

from typing import Any, Dict

APNS_HOST_PRODUCTION = "https://api.push.apple.com"
APNS_HOST_SANDBOX = "https://api.sandbox.push.apple.com"


def build_apns_payload(payload: Dict[str, Any], contract_meta: Dict[str, Any]) -> Dict[str, Any]:
    """
    构造 APNs JSON payload。

    Args:
        payload: PushContract.to_notification_payload() 的结果
        contract_meta: 附加的契约元信息（thread-id 用 source 标识等）

    Returns:
        APNs 协议载荷 {"aps": {...}, "jingliu": {...}}
    """
    confidence = payload.get("confidence", "medium")
    # 高置信度用 time-sensitive，低置信度用 passive（不亮屏）
    interruption_level = {
        "high": "time-sensitive",
        "medium": "active",
        "low": "passive",
    }.get(confidence, "active")

    return {
        "aps": {
            "alert": {
                "title": payload.get("title", "静流"),
                "body": payload.get("body", ""),
            },
            "thread-id": contract_meta.get("thread_id", payload.get("interest_id", "")),
            "interruption-level": interruption_level,
        },
        "jingliu": {
            "fingerprint": payload.get("fingerprint", ""),
            "interest_id": payload.get("interest_id", ""),
            "hit_reason": payload.get("hit_reason", {}),
            "confidence": confidence,
            "url": payload.get("url", ""),
            "source_type": payload.get("source_type", ""),
        },
    }


def _build_apns_jwt(team_id: str, key_id: str, private_key: str) -> str:
    """构造 APNs Provider Token（ES256，有效期取 20 分钟，避开 Apple 对 exp 的限制）"""
    import time

    import jwt

    now = int(time.time())
    return jwt.encode(
        {"iss": team_id, "iat": now, "exp": now + 20 * 60},
        private_key,
        algorithm="ES256",
        headers={"kid": key_id},
    )


def send_to_apns(
    device_token: str,
    payload: Dict[str, Any],
    *,
    team_id: str,
    key_id: str,
    private_key: str,
    bundle_id: str,
    production: bool = True,
    proxy_url: str = "",
) -> bool:
    """
    推送一条通知到指定设备。

    Args:
        device_token: 目标设备 token
        payload: PushContract.to_notification_payload() 的结果
        team_id: Apple 开发者团队 ID
        key_id: APNs 密钥 ID（.p8）
        private_key: .p8 私钥 PEM 内容
        bundle_id: 应用 Bundle ID（作为 apns-topic）
        production: True 用生产环境，False 用沙箱
        proxy_url: HTTP 代理（可选）

    Returns:
        是否发送成功
    """
    try:
        import httpx
    except ImportError:
        print("[APNs] 缺少依赖 httpx[http2]，请运行: uv add 'httpx[http2]'")
        return False

    if not (device_token and team_id and key_id and private_key and bundle_id):
        print("[APNs] 配置不完整（device_token/team_id/key_id/private_key/bundle_id）")
        return False

    try:
        provider_token = _build_apns_jwt(team_id, key_id, private_key)
        host = APNS_HOST_PRODUCTION if production else APNS_HOST_SANDBOX
        body = build_apns_payload(payload, contract_meta={
            "thread_id": f"interest:{payload.get('interest_id', '')}",
        })

        with httpx.Client(http2=True, proxy=proxy_url or None, timeout=15) as client:
            response = client.post(
                f"{host}/3/device/{device_token}",
                json=body,
                headers={
                    "authorization": f"bearer {provider_token}",
                    "apns-topic": bundle_id,
                    "apns-push-type": "alert",
                    "apns-priority": "10",
                },
            )
        if response.status_code == 200:
            return True
        print(f"[APNs] 推送失败（HTTP {response.status_code}）: {response.text[:200]}")
        return False
    except Exception as e:
        print(f"[APNs] 推送异常: {type(e).__name__}: {e}")
        return False
