# coding=utf-8
"""
静流 App HTTP API 服务器

供移动端 App 调用的 REST 接口（stdlib http.server 实现，零额外依赖）：
- 设备注册（动态 device token → state 库 devices 表，推送时与静态配置合并）
- 推送流 / 摘要池查询
- 契约反馈（有用/无用 → push_contracts.user_feedback）
- 源管理（webpage / douyin 的 CRUD）
- 兴趣文件编辑（ai_interests.txt / frequency_words.txt，写入前自动备份）

启动：
    python -m trendradar.jingliu.api_server [--host H] [--port P] [--token T]
或 config.yaml 的 jingliu.api 段 / 环境变量 JINGLIU_API_TOKEN。

安全模型（单用户自部署）：
- Bearer Token 鉴权（除 /api/health 外全部要求）
- 未配置 token 时拒绝启动
- 默认绑定 127.0.0.1；对外暴露需自行加反向代理/HTTPS
- 仅支持本地存储后端（API 服务面向 Docker/VPS 等持久化部署）

注意：必须从仓库根目录启动（兴趣文件路径、output/ 目录均为相对路径）。
"""

import argparse
import hmac
import json
import shutil
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from trendradar.collectors.douyin_adapter import DouyinAdapter
from trendradar.storage.local import LocalStorageBackend

_API_PREFIX = "/api"
_MAX_BODY_BYTES = 300 * 1024          # 请求体上限（兴趣文件约 200KB 内）
_VALID_FEEDBACK = {"useful", "useless", ""}
_VALID_SOURCE_TYPES = {"webpage", "douyin"}   # hotlist/rss 仍由 config.yaml 驱动，不走本表
_INTEREST_FILES = {
    "ai_interests": "config/ai_interests.txt",
    "frequency_words": "config/frequency_words.txt",
}
_DOUYIN_PARAM_KEYS = {"user": "sec_uid", "search": "keyword", "live": "rid"}


class ApiError(Exception):
    """业务错误：携带 HTTP 状态码与消息"""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class JingliuApiServer:
    """API 服务器：持有配置与鉴权 token，handler 每请求新建存储后端（线程安全）"""

    def __init__(self, config: Dict[str, Any], host: str, port: int, auth_token: str):
        self.config = config
        self.host = host
        self.port = port
        self.auth_token = auth_token
        storage_config = config.get("STORAGE", {})
        self.data_dir = storage_config.get("LOCAL", {}).get("DATA_DIR", "output")
        self.timezone = config.get("TIMEZONE", "Asia/Shanghai")

    # ========================================
    # 存储后端（每请求一个实例，避免跨线程共享 sqlite 连接）
    # ========================================

    def new_storage(self) -> LocalStorageBackend:
        return LocalStorageBackend(
            data_dir=self.data_dir,
            enable_txt=False,
            enable_html=False,
            timezone=self.timezone,
        )

    # ========================================
    # 路由
    # ========================================

    def route(self, method: str, path: str, query: Dict[str, list], body: Optional[Dict]) -> Tuple[int, Dict]:
        """返回 (HTTP 状态码, JSON 对象)。抛出 ApiError 由 handler 转换。"""
        parts = [p for p in path.split("/") if p]

        # GET /api/health（免鉴权探活）
        if method == "GET" and parts == ["api", "health"]:
            storage = self.new_storage()
            try:
                return 200, {"status": "ok", "backend": storage.backend_name}
            finally:
                storage.cleanup()

        if not parts or parts[0] != "api" or len(parts) < 2:
            raise ApiError(404, "未知路径")

        resource = parts[1]
        resource_id = parts[2] if len(parts) > 2 else None

        # ---- 设备 ----
        if resource == "devices":
            if method == "POST" and resource_id is None:
                return self._register_device(body)
            if method == "GET" and resource_id is None:
                return self._list_devices(query)
            if method == "DELETE" and resource_id is None:
                return self._delete_device(query)

        # ---- 契约 ----
        if resource == "contracts":
            if method == "GET" and resource_id == "pending":
                return self._pending_contracts(query)
            if method == "GET" and resource_id == "recent":
                return self._recent_contracts(query)
            if method == "POST" and resource_id and len(parts) == 4 and parts[3] == "feedback":
                return self._contract_feedback(resource_id, body)

        # ---- 源 ----
        if resource == "sources":
            if method == "GET" and resource_id is None:
                return self._list_sources(query)
            if method == "POST" and resource_id is None:
                return self._create_source(body)
            if method == "PUT" and resource_id:
                return self._update_source(resource_id, body)
            if method == "DELETE" and resource_id:
                return self._delete_source(resource_id)
            if method == "GET" and resource_id:
                return self._get_source(resource_id)

        # ---- 兴趣文件 ----
        if resource == "interests":
            if method == "GET" and resource_id is None:
                return self._get_interests()
            if method == "PUT" and resource_id is None:
                return self._put_interests(body)

        raise ApiError(404, f"未知端点: {method} /{'/'.join(parts)}")

    # ========================================
    # 设备
    # ========================================

    def _register_device(self, body: Optional[Dict]) -> Tuple[int, Dict]:
        channel = (body or {}).get("channel", "")
        device_token = (body or {}).get("device_token", "").strip()
        device_name = str((body or {}).get("device_name", ""))[:100]
        if channel not in ("apns", "fcm", "expo"):
            raise ApiError(400, "channel 必须为 apns / fcm / expo")
        if not device_token:
            raise ApiError(400, "device_token 不能为空")

        storage = self.new_storage()
        try:
            device_id = storage.register_device(channel, device_token, device_name)
            if device_id <= 0:
                raise ApiError(500, "设备注册失败")
            return 201, {"id": device_id, "channel": channel, "device_token": device_token}
        finally:
            storage.cleanup()

    def _list_devices(self, query: Dict[str, list]) -> Tuple[int, Dict]:
        channel = (query.get("channel") or [None])[0]
        if channel and channel not in ("apns", "fcm", "expo"):
            raise ApiError(400, "channel 必须为 apns / fcm / expo")
        storage = self.new_storage()
        try:
            return 200, {"devices": storage.list_devices(channel)}
        finally:
            storage.cleanup()

    def _delete_device(self, query: Dict[str, list]) -> Tuple[int, Dict]:
        channel = (query.get("channel") or [""])[0]
        device_token = (query.get("device_token") or [""])[0]
        if channel not in ("apns", "fcm") or not device_token:
            raise ApiError(400, "需要 channel 与 device_token 查询参数")
        storage = self.new_storage()
        try:
            deleted = storage.delete_device(channel, device_token)
            return 200, {"deleted": deleted}
        finally:
            storage.cleanup()

    # ========================================
    # 契约
    # ========================================

    def _pending_contracts(self, query: Dict[str, list]) -> Tuple[int, Dict]:
        min_confidence = (query.get("min_confidence") or ["medium"])[0]
        if min_confidence not in ("high", "medium", "low"):
            raise ApiError(400, "min_confidence 必须为 high/medium/low")
        limit = self._parse_limit(query)
        storage = self.new_storage()
        try:
            return 200, {"contracts": storage.get_pending_contracts(min_confidence, limit)}
        finally:
            storage.cleanup()

    def _recent_contracts(self, query: Dict[str, list]) -> Tuple[int, Dict]:
        limit = self._parse_limit(query)
        storage = self.new_storage()
        try:
            return 200, {"contracts": storage.get_recent_contracts(limit)}
        finally:
            storage.cleanup()

    def _contract_feedback(self, contract_id_str: str, body: Optional[Dict]) -> Tuple[int, Dict]:
        try:
            contract_id = int(contract_id_str)
        except ValueError:
            raise ApiError(400, "契约 id 必须为整数")
        feedback = str((body or {}).get("feedback", ""))
        if feedback not in _VALID_FEEDBACK:
            raise ApiError(400, "feedback 必须为 useful / useless / 空串(清除)")
        storage = self.new_storage()
        try:
            updated = storage.set_contract_feedback(contract_id, feedback)
            if not updated:
                raise ApiError(404, f"契约 {contract_id} 不存在")
            return 200, {"updated": True, "contract_id": contract_id, "feedback": feedback}
        finally:
            storage.cleanup()

    # ========================================
    # 源
    # ========================================

    def _list_sources(self, query: Dict[str, list]) -> Tuple[int, Dict]:
        source_type = (query.get("type") or [None])[0]
        status = (query.get("status") or ["active"])[0] or None
        if source_type and source_type not in _VALID_SOURCE_TYPES:
            raise ApiError(400, "type 必须为 webpage 或 douyin")
        storage = self.new_storage()
        try:
            return 200, {"sources": storage.list_sources(source_type, status)}
        finally:
            storage.cleanup()

    def _get_source(self, source_id_str: str) -> Tuple[int, Dict]:
        try:
            source_id = int(source_id_str)
        except ValueError:
            raise ApiError(400, "源 id 必须为整数")
        storage = self.new_storage()
        try:
            source = storage.get_source(source_id)
            if not source:
                raise ApiError(404, f"源 {source_id} 不存在")
            return 200, {"source": source}
        finally:
            storage.cleanup()

    def _create_source(self, body: Optional[Dict]) -> Tuple[int, Dict]:
        data = body or {}
        source_type = data.get("type", "")
        name = str(data.get("name", "")).strip()
        source_config = data.get("config") or {}
        selector_config = data.get("selector_config") or {}
        if source_type not in _VALID_SOURCE_TYPES:
            raise ApiError(400, "type 必须为 webpage 或 douyin")
        if not name:
            raise ApiError(400, "name 不能为空")

        self._validate_source_config(source_type, source_config)

        record = {
            "type": source_type,
            "platform": data.get("platform") or source_type,
            "external_id": data.get("external_id") or self._default_external_id(source_type, source_config),
            "name": name,
            "config": source_config,
            "check_interval": data.get("check_interval", 30),
            "selector_config": selector_config,
            "status": data.get("status", "active"),
        }
        if source_type == "douyin":
            # 抖音源下限 30 分钟，降低 RSSHub 实例被封风险
            try:
                record["check_interval"] = max(30, int(record["check_interval"]))
            except (ValueError, TypeError):
                record["check_interval"] = 30

        storage = self.new_storage()
        try:
            source_id = storage.register_source(record)
            if source_id <= 0:
                raise ApiError(500, "源注册失败")
            return 201, {"id": source_id, "source": storage.get_source(source_id)}
        finally:
            storage.cleanup()

    def _validate_source_config(self, source_type: str, source_config: Dict) -> None:
        if source_type == "webpage":
            if not str(source_config.get("url", "")).strip().startswith(("http://", "https://")):
                raise ApiError(400, "webpage 源需要 config.url（http/https）")
            return
        if source_type == "douyin":
            route = source_config.get("route", "")
            param_key = _DOUYIN_PARAM_KEYS.get(route)
            if not param_key:
                raise ApiError(400, "douyin 源 config.route 必须为 user/search/live")
            if not str(source_config.get(param_key, "")).strip():
                raise ApiError(400, f"douyin 源缺少 config.{param_key}")

    @staticmethod
    def _default_external_id(source_type: str, source_config: Dict) -> str:
        if source_type == "webpage":
            return str(source_config.get("url", ""))
        param_key = _DOUYIN_PARAM_KEYS.get(source_config.get("route", ""), "external_id")
        return str(source_config.get(param_key, ""))

    def _update_source(self, source_id_str: str, body: Optional[Dict]) -> Tuple[int, Dict]:
        try:
            source_id = int(source_id_str)
        except ValueError:
            raise ApiError(400, "源 id 必须为整数")
        updates = body or {}
        if "type" in updates:
            raise ApiError(400, "type 不可修改（请删除后重建）")
        if "check_interval" in updates:
            try:
                updates["check_interval"] = int(updates["check_interval"])
            except (ValueError, TypeError):
                raise ApiError(400, "check_interval 必须为整数分钟")

        storage = self.new_storage()
        try:
            existing = storage.get_source(source_id)
            if not existing:
                raise ApiError(404, f"源 {source_id} 不存在")
            if "config" in updates:
                self._validate_source_config(existing["type"], updates.get("config") or {})

            updated = storage.update_source(source_id, updates)
            if not updated:
                raise ApiError(400, "无可更新字段（仅支持 name/platform/check_interval/config/selector_config/status）")
            return 200, {"updated": True, "source": storage.get_source(source_id)}
        finally:
            storage.cleanup()

    def _delete_source(self, source_id_str: str) -> Tuple[int, Dict]:
        try:
            source_id = int(source_id_str)
        except ValueError:
            raise ApiError(400, "源 id 必须为整数")
        storage = self.new_storage()
        try:
            deleted = storage.delete_source(source_id)
            if not deleted:
                raise ApiError(404, f"源 {source_id} 不存在")
            return 200, {"deleted": True, "id": source_id}
        finally:
            storage.cleanup()

    # ========================================
    # 兴趣文件（读取/编辑，写入前自动 .bak 备份）
    # ========================================

    def _get_interests(self) -> Tuple[int, Dict]:
        result = {}
        for target, rel_path in _INTEREST_FILES.items():
            path = Path(rel_path)
            result[target] = {
                "path": rel_path,
                "exists": path.exists(),
                "content": path.read_text(encoding="utf-8") if path.exists() else "",
            }
        return 200, result

    def _put_interests(self, body: Optional[Dict]) -> Tuple[int, Dict]:
        target = (body or {}).get("target", "")
        content = (body or {}).get("content", "")
        if target not in _INTEREST_FILES:
            raise ApiError(400, f"target 必须为 {'/'.join(_INTEREST_FILES)}")
        if not isinstance(content, str):
            raise ApiError(400, "content 必须为字符串")
        if len(content.encode("utf-8")) > _MAX_BODY_BYTES:
            raise ApiError(400, "content 超过大小限制")

        path = Path(_INTEREST_FILES[target])
        if path.exists():
            shutil.copy2(path, path.with_suffix(path.suffix + ".bak"))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        print(f"[静流API] 兴趣文件已更新: {path}（原文件备份为 .bak）")
        return 200, {"updated": True, "target": target, "path": str(path)}

    # ========================================
    # 工具
    # ========================================

    @staticmethod
    def _parse_limit(query: Dict[str, list], default: int = 50, maximum: int = 200) -> int:
        raw = (query.get("limit") or [str(default)])[0]
        try:
            return max(1, min(int(raw), maximum))
        except (ValueError, TypeError):
            return default


def _check_auth(server: JingliuApiServer, header_value: Optional[str]) -> bool:
    """Bearer Token 校验（恒定时间比较）"""
    if not header_value or not header_value.startswith("Bearer "):
        return False
    token = header_value[len("Bearer "):].strip()
    return hmac.compare_digest(token, server.auth_token)


def make_handler(server: JingliuApiServer):
    """构造绑定了服务器配置的 handler 类"""

    class Handler(BaseHTTPRequestHandler):
        server_version = "JingLiuAPI/0.1"
        protocol_version = "HTTP/1.1"

        # ---- HTTP 方法入口 ----
        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_PUT(self):
            self._dispatch("PUT")

        def do_DELETE(self):
            self._dispatch("DELETE")

        # ---- 统一分发 ----
        def _dispatch(self, method: str):
            parsed = urlparse(self.path)
            query = parse_qs(parsed.query)
            path = parsed.path.rstrip("/") or "/"

            try:
                if not (path == f"{_API_PREFIX}/health" and method == "GET"):
                    if not _check_auth(server, self.headers.get("Authorization")):
                        self._respond(401, {"error": "鉴权失败（Authorization: Bearer <token>）"})
                        return

                body = None
                if method in ("POST", "PUT"):
                    body = self._read_json_body()

                status, payload = server.route(method, path, query, body)
                self._respond(status, payload)
            except ApiError as e:
                self._respond(e.status, {"error": e.message})
            except Exception as e:
                print(f"[静流API] {method} {path} 处理异常: {type(e).__name__}: {e}")
                self._respond(500, {"error": f"内部错误: {type(e).__name__}"})

        def _read_json_body(self) -> Optional[Dict]:
            length = int(self.headers.get("Content-Length", 0) or 0)
            if length <= 0:
                return {}
            if length > _MAX_BODY_BYTES:
                raise ApiError(413, "请求体过大")
            raw = self.rfile.read(length)
            if not raw.strip():
                return {}
            try:
                data = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                raise ApiError(400, "请求体不是合法 JSON")
            if not isinstance(data, dict):
                raise ApiError(400, "请求体必须是 JSON 对象")
            return data

        def _respond(self, status: int, payload: Dict):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            if status >= 400:
                # 错误响应（尤其 413）可能未消费请求体，关闭连接避免
                # 残留字节被误解析为下一个请求
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):  # noqa: A002（http.server 约定签名）
            print(f"[静流API] {self.address_string()} {format % args}")

    return Handler


def main():
    parser = argparse.ArgumentParser(description="静流 App HTTP API 服务器")
    parser.add_argument("--host", default=None, help="监听地址（默认取 jingliu.api.host，缺省 127.0.0.1）")
    parser.add_argument("--port", type=int, default=None, help="监听端口（默认取 jingliu.api.port，缺省 8807）")
    parser.add_argument("--token", default=None, help="Bearer Token（默认取 jingliu.api.auth_token / JINGLIU_API_TOKEN）")
    args = parser.parse_args()

    from trendradar.core.loader import load_config

    config = load_config()
    api_config = config.get("JINGLIU", {}).get("API", {})

    host = args.host or api_config.get("HOST", "127.0.0.1")
    port = args.port if args.port is not None else int(api_config.get("PORT", 8807))
    auth_token = args.token or api_config.get("AUTH_TOKEN", "")

    if not auth_token:
        print("❌ 未配置 API Token。请设置 jingliu.api.auth_token 或环境变量 JINGLIU_API_TOKEN")
        print("   （API 以明文 Bearer Token 鉴权，拒绝无 token 启动）")
        raise SystemExit(1)

    server = JingliuApiServer(config, host, port, auth_token)
    httpd = ThreadingHTTPServer((host, port), make_handler(server))

    print("╔════════════════════════════════════════╗")
    print("║  静流 App API Server                    ║")
    print("╚════════════════════════════════════════╝")
    print(f"[地址] http://{host}:{port}")
    print(f"[鉴权] Bearer Token 已启用（长度 {len(auth_token)}）")
    print("[端点] GET  /api/health（免鉴权）")
    print("       POST /api/devices | GET /api/devices | DELETE /api/devices?channel=&device_token=")
    print("       GET  /api/contracts/recent | /api/contracts/pending")
    print("       POST /api/contracts/{id}/feedback")
    print("       GET/POST /api/sources | GET/PUT/DELETE /api/sources/{id}")
    print("       GET/PUT /api/interests")
    print("[提示] 从仓库根目录运行；Ctrl+C 停止")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[静流API] 已停止")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
