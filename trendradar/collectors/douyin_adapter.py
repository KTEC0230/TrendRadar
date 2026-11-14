# coding=utf-8
"""
抖音源适配器（DouyinAdapter）

硬约束：不自建抖音抓取爬虫、不调用任何非公开抖音 API。
职责仅限：将用户输入的"账号 / 关键词 / 直播间"转换为 RSSHub 公开路由 URL，
生成 RSSFeedConfig 注入现有 RSS 抓取路径（crawler/rss）。

路由可用性取决于所部署的 RSSHub 实例（不同实例对抖音路由的支持与
稳定性差异较大），推送/展示侧应附带稳定性风险提示。
"""

import json
from typing import Any, Dict, List, Optional

_STABILITY_NOTICE = (
    "[静流] 抖音源依赖第三方 RSSHub 中间层，路由可能随平台策略变动失效，"
    "属于稳定性风险源；建议 check_interval 不低于 30 分钟以降低被封风险"
)


class DouyinAdapter:
    """抖音账号/关键词/直播间 → RSSHub 路由 → RSSFeedConfig"""

    # RSSHub 公开路由模板（host 由部署实例决定，占位符 {rsshub_base}）
    ROUTE_TEMPLATES = {
        "user": "{rsshub_base}/douyin/user/{sec_uid}",      # 用户/账号
        "search": "{rsshub_base}/douyin/search/{keyword}",  # 关键词搜索（部分实例不支持）
        "live": "{rsshub_base}/douyin/live/{rid}",          # 直播间（部分实例不支持）
    }

    # 需要在推送/展示时附带稳定性提示的路由类型
    UNSTABLE_ROUTES = {"search", "live"}

    def __init__(self, rsshub_base: str):
        self.rsshub_base = rsshub_base.rstrip("/")

    def build_route_url(self, route_config: Dict[str, Any]) -> Optional[str]:
        """
        按路由类型构造 RSSHub URL。

        Args:
            route_config: {"route": "user"|"search"|"live",
                           "sec_uid"|"keyword"|"rid": str}

        Returns:
            路由 URL；类型或参数非法返回 None
        """
        route = route_config.get("route", "")
        template = self.ROUTE_TEMPLATES.get(route)
        if not template:
            print(f"[静流] 未知抖音路由类型: {route}（支持 user/search/live）")
            return None

        param_key = {"user": "sec_uid", "search": "keyword", "live": "rid"}[route]
        param_value = str(route_config.get(param_key, "")).strip()
        if not param_value:
            print(f"[静流] 抖音路由 {route} 缺少参数 {param_key}")
            return None

        return template.format(rsshub_base=self.rsshub_base, **{param_key: param_value})

    def build_feed(self, source: Dict[str, Any]) -> Optional["RSSFeedConfig"]:
        """
        从 sources 表记录构建 RSSFeedConfig。

        Args:
            source: {"id", "name", "external_id", "config": {route...}, "check_interval"}

        Returns:
            RSSFeedConfig（id 带 douyin- 前缀，platform_type=douyin 的标记）；
            路由构造失败返回 None
        """
        from trendradar.crawler.rss.fetcher import RSSFeedConfig

        url = self.build_route_url(source.get("config", {}))
        if not url:
            return None

        route = source.get("config", {}).get("route", "")
        if route in self.UNSTABLE_ROUTES:
            print(f"[静流] 抖音源『{source.get('name')}』使用 {route} 路由，稳定性风险较高，请注意推送内容可能中断")

        return RSSFeedConfig(
            id=f"douyin-{source.get('external_id') or source.get('id')}",
            name=f"抖音 · {source.get('name', source.get('external_id', ''))}",
            url=url,
            max_items=20,
            enabled=True,
            # 抖音内容时效性高，新鲜度过滤放宽到 7 天，避免频繁空批次
            max_age_days=7,
        )

    # ========================================
    # 批量导出（供 NewsAnalyzer._crawl_rss_data 合并）
    # ========================================

    @staticmethod
    def export_feed_configs(storage_manager, rsshub_base: str) -> List["RSSFeedConfig"]:
        """
        从 state 库读取全部 active 的 douyin 源并转换为 RSSFeedConfig。

        Args:
            storage_manager: StorageManager（读 sources 表）
            rsshub_base: RSSHub 实例地址

        Returns:
            RSSFeedConfig 列表
        """
        if not rsshub_base:
            return []

        adapter = DouyinAdapter(rsshub_base)
        sources = storage_manager.list_sources(source_type="douyin") or []
        feeds: List["RSSFeedConfig"] = []

        if sources:
            print(_STABILITY_NOTICE)

        for source in sources:
            try:
                feed = adapter.build_feed(source)
            except Exception as e:
                print(f"[静流] 抖音源『{source.get('name')}』转换失败: {e}")
                continue
            if feed:
                feeds.append(feed)

        return feeds

    # ========================================
    # 源注册辅助（供未来的 App 管理接口使用）
    # ========================================

    @staticmethod
    def make_source_record(
        name: str,
        route: str,
        param_value: str,
        check_interval: int = 30,
        external_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        构造 sources 表记录（type=douyin）。

        Args:
            name: 展示名称（如"某博主"）
            route: user / search / live
            param_value: sec_uid / keyword / rid
            check_interval: 检查间隔分钟（抖音源建议 ≥30）
            external_id: 稳定标识，缺省用 param_value
        """
        param_key = {"user": "sec_uid", "search": "keyword", "live": "rid"}.get(route, "")
        if not param_key:
            raise ValueError(f"未知抖音路由类型: {route}")
        return {
            "type": "douyin",
            "platform": "douyin",
            "external_id": external_id or param_value,
            "name": name,
            "config": json.dumps({"route": route, param_key: param_value}, ensure_ascii=False),
            "check_interval": max(30, int(check_interval)),  # 抖音源下限 30 分钟
            "selector_config": json.dumps({}),
            "status": "active",
        }
