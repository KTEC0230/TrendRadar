# coding=utf-8
"""
静流（JingLiu）核心层

「推送即契约」：每条推送自带命中理由，跨运行周期持久判重。
- contracts: PushContractBuilder，位于筛选之后、推送渲染之前
- monitor_scheduler: URL 监控独立调度（与热榜 timeline 无关）
"""

from trendradar.jingliu.contracts import (
    Confidence,
    GateResult,
    HitReason,
    PushContract,
    PushContractBuilder,
    SourceAttribution,
    make_fingerprint,
)

__all__ = [
    "Confidence",
    "GateResult",
    "HitReason",
    "PushContract",
    "PushContractBuilder",
    "SourceAttribution",
    "make_fingerprint",
]
