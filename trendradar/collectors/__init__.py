# coding=utf-8
"""
静流数据采集器

- webpage_monitor: URL 监控（实质内容变更检测）
- douyin_adapter: 抖音源 → RSSHub 路由适配（不自建爬虫）
"""

from trendradar.collectors.webpage_monitor import WebpageChangeEvent, WebpageMonitor

__all__ = [
    "WebpageChangeEvent",
    "WebpageMonitor",
]
