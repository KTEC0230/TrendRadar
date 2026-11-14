# coding=utf-8
"""
FCM 直连推送渠道

通过 Firebase Cloud Messaging HTTP v1 API 直连推送，
service account OAuth2 鉴权，载荷携带 hit_reason。

依赖：PyJWT、cryptography（RS256 签名）；HTTP 请求用 requests（项目已有）。
遵循 senders.py 的渠道函数约定：输入载荷、输出 bool。
"""

import time
from typing import Any, Dict, Optional

FCM_SEND_URL = "https://fcm.googleapis.com/v1/projects/{project_id}/messages:send"
OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
OAUTH_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"

# 进程内缓存的 access_token：{client_email: (token, expires_at)}
_token_cache: Dict[str, Any] = {}


def build_fcm_message(payload: Dict[str, Any], device_token: str) -> Dict[str, Any]:
    """
    构造 FCM HTTP v1 消息体。

    结构化契约信息放 data（FCM 要求 data 值全部为字符串），
    通知标题/正文直接展示 hit_reason。
    """
    import json

    contract_data = {
        "fingerprint": payload.get("fingerprint", ""),
        "interest_id": payload.get("interest_id", ""),
        "confidence": payload.get("confidence", ""),
        "url": payload.get("url", ""),
        "source_type": payload.get("source_type", ""),
        "hit_reason": json.dumps(payload.get("hit_reason", {}), ensure_ascii=False),
    }
    return {
        "message": {
            "token": device_token,
            "notification": {
                "title": payload.get("title", "静流"),
                "body": payload.get("body", ""),
            },
            "data": {k: str(v) for k, v in contract_data.items()},
        }
    }


def _get_access_token(service_account: Dict[str, Any], proxy_url: str = "") -> Optional[str]:
    """
    用 service account 换取 OAuth2 access token（RS256 JWT bearer 流程），
    进程内缓存至过期前 60 秒。
    """
    import jwt
    import requests

    client_email = service_account.get("client_email", "")
    private_key = service_account.get("private_key", "")
    token_uri = service_account.get("token_uri", OAUTH_TOKEN_URL)
    if not (client_email and private_key):
        print("[FCM] service account 缺少 client_email/private_key")
        return None

    cached = _token_cache.get(client_email)
    if cached and cached[1] > time.time() + 60:
        return cached[0]

    now = int(time.time())
    assertion = jwt.encode(
        {
            "iss": client_email,
            "scope": OAUTH_SCOPE,
            "aud": token_uri,
            "iat": now,
            "exp": now + 3600,
        },
        private_key,
        algorithm="RS256",
    )

    try:
        proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None
        response = requests.post(
            token_uri,
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": assertion,
            },
            timeout=15,
            proxies=proxies,
        )
        response.raise_for_status()
        data = response.json()
        token = data.get("access_token")
        expires_in = int(data.get("expires_in", 3600))
        if not token:
            print("[FCM] OAuth2 响应缺少 access_token")
            return None
        _token_cache[client_email] = (token, time.time() + expires_in)
        return token
    except Exception as e:
        print(f"[FCM] 获取 access token 失败: {type(e).__name__}: {e}")
        return None


def load_service_account(credentials_path: str) -> Optional[Dict[str, Any]]:
    """从 JSON 文件加载 service account 凭据"""
    import json
    from pathlib import Path

    try:
        path = Path(credentials_path)
        if not path.exists():
            print(f"[FCM] 凭据文件不存在: {credentials_path}")
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[FCM] 读取凭据文件失败: {e}")
        return None


def send_to_fcm(
    device_token: str,
    payload: Dict[str, Any],
    *,
    project_id: str,
    service_account: Dict[str, Any],
    proxy_url: str = "",
) -> bool:
    """
    推送一条通知到指定设备。

    Args:
        device_token: FCM 注册 token
        payload: PushContract.to_notification_payload() 的结果
        project_id: Firebase 项目 ID
        service_account: service account JSON 内容（dict）
        proxy_url: HTTP 代理（可选）

    Returns:
        是否发送成功
    """
    import requests

    if not (device_token and project_id and service_account):
        print("[FCM] 配置不完整（device_token/project_id/service_account）")
        return False

    try:
        access_token = _get_access_token(service_account, proxy_url)
        if not access_token:
            return False

        body = build_fcm_message(payload, device_token)
        proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None
        response = requests.post(
            FCM_SEND_URL.format(project_id=project_id),
            json=body,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=15,
            proxies=proxies,
        )
        if response.status_code == 200:
            return True
        print(f"[FCM] 推送失败（HTTP {response.status_code}）: {response.text[:200]}")
        return False
    except Exception as e:
        print(f"[FCM] 推送异常: {type(e).__name__}: {e}")
        return False
