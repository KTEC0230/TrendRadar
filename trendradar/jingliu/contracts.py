# coding=utf-8
"""
推送契约层（PushContractBuilder）

位于筛选之后、推送渲染之前。职责：
1. 从本轮实际匹配数据生成带命中理由（hit_reason）的推送契约
2. 三道门控：指纹唯一性（跨运行周期持久）→ 跨源去重 → URL 变更幅度阈值
3. 推送后写台账，保证同一内容指纹只实际推送一次

hit_reason 一律取自本轮匹配的实际数据（关键词/AI 分数/diff 内容），
禁止事后编造——这是"推送即契约"的硬约束。
"""

import hashlib
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional

Confidence = Literal["high", "medium", "low"]

_CONFIDENCE_ORDER = {"high": 3, "medium": 2, "low": 1}


def make_fingerprint(*parts: str) -> str:
    """
    生成内容指纹：sha256(规范化部件拼接)

    Args:
        parts: 参与指纹的字符串（url 优先于 title）

    Returns:
        十六进制指纹
    """
    canonical = "\x1f".join(p.strip().lower() for p in parts if p and p.strip())
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass
class HitReason:
    """命中理由。text 直接进通知，detail 为结构化附言。"""

    kind: Literal["keyword", "ai", "webpage_change", "digest"]
    text: str
    detail: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {"kind": self.kind, "text": self.text, "detail": self.detail}


@dataclass
class SourceAttribution:
    """来源归属：平台 + 原始链接。"""

    platform: str
    platform_name: str
    url: str = ""
    mobile_url: str = ""
    source_type: str = "hotlist"  # hotlist / rss / webpage / douyin

    def to_dict(self) -> Dict[str, Any]:
        return {
            "platform": self.platform,
            "platform_name": self.platform_name,
            "url": self.url,
            "mobile_url": self.mobile_url,
            "source_type": self.source_type,
        }


@dataclass
class PushContract:
    """一条待推送契约。"""

    content_fingerprint: str
    interest_id: str
    hit_reason: HitReason
    source_attribution: SourceAttribution
    confidence: Confidence
    source_row_id: Optional[int] = None   # webpage/douyin 源在 sources 表的 id
    contract_row_id: Optional[int] = None  # push_contracts 表行 id（gate 落库后填充）

    def to_notification_payload(self) -> Dict[str, Any]:
        """
        生成移动端通知载荷（渠道无关）。
        APNs/FCM 模块据此包装各自协议格式。
        """
        return {
            "title": f"静流 · {self.source_attribution.platform_name}",
            "body": self.hit_reason.text,
            "fingerprint": self.content_fingerprint,
            "interest_id": self.interest_id,
            "hit_reason": self.hit_reason.to_dict(),
            "confidence": self.confidence,
            "url": self.source_attribution.url,
            "source_type": self.source_attribution.source_type,
        }

    def to_record(self) -> Dict[str, Any]:
        """转为 push_contracts 表记录（pushed_at 由调用方决定）"""
        return {
            "content_fingerprint": self.content_fingerprint,
            "interest_id": self.interest_id,
            "hit_reason": self.hit_reason.to_dict(),
            "confidence": self.confidence,
            "source_attribution": self.source_attribution.to_dict(),
            "payload": self.to_notification_payload(),
            "pushed_at": None,
            "channel": "",
        }


@dataclass
class GateResult:
    """门控结果。"""

    pushable: List[PushContract] = field(default_factory=list)
    suppressed: List[Dict[str, Any]] = field(default_factory=list)


class PushContractBuilder:
    """
    推送契约构建器与门控。

    state_store 依赖窄接口（便于测试替换）：
    - is_fingerprint_pushed(fingerprint: str) -> bool
    - save_push_contract(record: Dict) -> int
    - mark_contract_pushed(contract_id: int, channel: str, pushed_at_iso: str) -> bool
    """

    def __init__(self, config: Dict[str, Any], state_store: Any, get_time_func=None):
        self.config = config
        self.state_store = state_store
        self.get_time = get_time_func
        jingliu_config = config.get("JINGLIU", {})
        webpage_config = jingliu_config.get("WEBPAGE", {})
        # URL 监控的变更幅度阈值（正文有效变化字符数低于此值不触发推送）
        self.min_change_chars = webpage_config.get("MIN_CHANGE_CHARS", 50)

    # ========================================
    # 构建（hit_reason 来自本轮实际匹配数据）
    # ========================================

    def build_from_stats(
        self,
        stats: List[Dict],
        filter_method: str = "keyword",
        source_type: str = "hotlist",
    ) -> List[PushContract]:
        """
        从关键词/AI 筛选产出的 stats 构建契约。

        两种路径的 stats 结构一致（[{word, count, titles: [...]}]）：
        - keyword：命中词即 stat["word"]（core/analyzer.py count_word_frequency 按词分组）
        - ai：word 为标签名，title 携带 relevance_score / reason（filter_pipeline 透传）

        Args:
            stats: 筛选统计列表
            filter_method: "keyword" | "ai"
            source_type: "hotlist" | "rss"

        Returns:
            契约列表
        """
        contracts: List[PushContract] = []
        for stat in stats or []:
            word = stat.get("word", "")
            if not word:
                continue
            for entry in stat.get("titles", []):
                title = entry.get("title", "")
                if not title:
                    continue
                url = entry.get("url", "") or ""
                platform = entry.get("source_name", "") or source_type

                if filter_method == "ai":
                    score = float(entry.get("relevance_score", 0.5) or 0.5)
                    llm_reason = (entry.get("reason") or "").strip()
                    if llm_reason:
                        reason_text = llm_reason
                    else:
                        reason_text = f"与你的兴趣『{word}』相关度 {score:.2f}"
                    hit_reason = HitReason(
                        kind="ai",
                        text=reason_text,
                        detail={
                            "tag": word,
                            "relevance_score": score,
                            "llm_reason": llm_reason or None,
                        },
                    )
                    confidence = self._score_to_confidence(score)
                else:
                    hit_reason = HitReason(
                        kind="keyword",
                        text=f"命中了关键词『{word}』",
                        detail={"matched_word": word, "source_type": source_type},
                    )
                    # 关键词是用户显式配置的兴趣表达，视为高置信度
                    confidence = "high"

                contracts.append(PushContract(
                    content_fingerprint=make_fingerprint(url or title, platform),
                    interest_id=word,
                    hit_reason=hit_reason,
                    source_attribution=SourceAttribution(
                        platform=platform,
                        platform_name=platform,
                        url=url,
                        mobile_url=entry.get("mobile_url", "") or "",
                        source_type=source_type,
                    ),
                    confidence=confidence,
                ))
        return contracts

    def build_from_webpage_event(self, event) -> PushContract:
        """
        从网页变更事件构建契约。

        hit_reason 按 diff 类型生成，回答"哪里变了"。
        """
        blocks = event.changed_blocks or []
        title_blocks = [b for b in blocks if b.get("type") == "title"]
        para_blocks = [b for b in blocks if b.get("type") != "title"]

        if title_blocks:
            first = title_blocks[0]
            reason_text = f"网页标题从『{first.get('old', '')}』变为『{first.get('new', '')}』"
        elif para_blocks:
            first = para_blocks[0]
            new_text = str(first.get("new", ""))[:40]
            reason_text = f"正文内容更新：『{new_text}…』" if len(str(first.get("new", ""))) > 40 \
                else f"正文内容更新：『{new_text}』"
        else:
            reason_text = "页面内容发生变化"

        if title_blocks and (len(title_blocks) > 1 or para_blocks):
            confidence = "high"   # 标题变更 + 其他变更
        elif title_blocks:
            confidence = "high"   # 标题变更为强信号
        elif len(para_blocks) >= 2:
            confidence = "high"
        elif para_blocks and event.change_chars >= self.min_change_chars:
            confidence = "medium"
        else:
            confidence = "low"

        return PushContract(
            content_fingerprint=make_fingerprint(event.url, event.current_fingerprint),
            interest_id=f"source:{event.source_id}",
            hit_reason=HitReason(
                kind="webpage_change",
                text=reason_text,
                detail={
                    "changed_blocks": blocks,
                    "change_chars": event.change_chars,
                    "selector_used": event.selector_used,
                    # 源级阈值随契约带入，门控闸 3 优先使用
                    "min_change_chars": getattr(event, "min_change_chars", 0) or self.min_change_chars,
                },
            ),
            source_attribution=SourceAttribution(
                platform="webpage",
                platform_name=event.name or "网页监控",
                url=event.url,
                source_type="webpage",
            ),
            confidence=confidence,
            source_row_id=event.source_id,
        )

    @staticmethod
    def _score_to_confidence(score: float) -> Confidence:
        if score >= 0.8:
            return "high"
        if score >= 0.5:
            return "medium"
        return "low"

    # ========================================
    # 门控（独立于现有 filter）
    # ========================================

    def gate_and_rank(self, contracts: List[PushContract], source_kind: str = "push") -> GateResult:
        """
        三道闸，顺序执行：
        1. 指纹唯一性：跨运行周期持久判重（已推送过的指纹一律抑制）
        2. 跨源去重：同指纹保留 confidence 最高的一条，其余静默
        3. URL 变更幅度阈值：webpage 源 change_chars 低于阈值抑制

        通过的契约先落库（pushed_at 为空），推送成功后由 record_pushed 标记。

        Returns:
            GateResult
        """
        result = GateResult()

        # 闸 1：持久指纹判重
        fresh: List[PushContract] = []
        for contract in contracts:
            if contract.hit_reason.kind == "webpage_change":
                # webpage 指纹包含内容指纹，同一 URL 的每次变更指纹不同，
                # 持久判重对其没有意义（也避免误杀），走闸 3 与闸 2
                fresh.append(contract)
                continue
            try:
                if self.state_store.is_fingerprint_pushed(contract.content_fingerprint):
                    result.suppressed.append({
                        "contract": contract,
                        "reason": "duplicate_fingerprint",
                    })
                    continue
            except Exception as e:
                print(f"[静流] 指纹判重查询失败（按未推送处理）: {e}")
            fresh.append(contract)

        # 闸 2：跨源去重（同指纹保留置信度最高的一条）
        best_by_fingerprint: Dict[str, PushContract] = {}
        for contract in fresh:
            existing = best_by_fingerprint.get(contract.content_fingerprint)
            if existing is None:
                best_by_fingerprint[contract.content_fingerprint] = contract
                continue
            winner = self._pick_better(contract, existing)
            loser = existing if winner is contract else contract
            best_by_fingerprint[contract.content_fingerprint] = winner
            result.suppressed.append({"contract": loser, "reason": "lower_confidence_cross_source"})

        # 闸 3：webpage 变更幅度阈值（源级阈值随契约携带，全局配置兜底）
        for contract in best_by_fingerprint.values():
            if contract.hit_reason.kind == "webpage_change":
                detail = contract.hit_reason.detail
                change_chars = int(detail.get("change_chars", 0))
                threshold = int(detail.get("min_change_chars", 0)) or self.min_change_chars
                if change_chars < threshold:
                    result.suppressed.append({
                        "contract": contract,
                        "reason": "below_change_threshold",
                    })
                    continue
            self._persist_pending(contract, result)

        if result.suppressed:
            reasons = {}
            for item in result.suppressed:
                reasons[item["reason"]] = reasons.get(item["reason"], 0) + 1
            reason_summary = ", ".join(f"{k}×{v}" for k, v in reasons.items())
            print(f"[静流] 门控抑制 {len(result.suppressed)} 条（{reason_summary}）")
        print(f"[静流] 门控通过 {len(result.pushable)} 条")

        return result

    def _pick_better(self, a: PushContract, b: PushContract) -> PushContract:
        """置信度优先；相同则 interest_id 字典序最小，保证确定性"""
        order_a = _CONFIDENCE_ORDER.get(a.confidence, 0)
        order_b = _CONFIDENCE_ORDER.get(b.confidence, 0)
        if order_a != order_b:
            return a if order_a > order_b else b
        if a.interest_id != b.interest_id:
            return a if a.interest_id <= b.interest_id else b
        return a

    def _persist_pending(self, contract: PushContract, result: GateResult) -> None:
        """通过的契约落库为 pending 记录，推送成功后标记"""
        try:
            record = contract.to_record()
            contract.contract_row_id = self.state_store.save_push_contract(record)
        except Exception as e:
            print(f"[静流] 契约落库失败（仍尝试推送）: {e}")
        result.pushable.append(contract)

    # ========================================
    # 推送回写
    # ========================================

    def record_pushed(self, contracts: List[PushContract], results: Dict[str, bool]) -> None:
        """
        推送后写台账。channel 取 results 中第一个成功的渠道。

        Args:
            contracts: 已尝试推送的契约
            results: dispatch_contracts 返回的 {渠道: 是否成功}
        """
        channel = next((name for name, ok in (results or {}).items() if ok), "")
        now_iso = ""
        if self.get_time:
            try:
                now_iso = self.get_time().isoformat(timespec="seconds")
            except Exception:
                now_iso = ""
        if not now_iso:
            from datetime import datetime

            now_iso = datetime.now().isoformat(timespec="seconds")
        for contract in contracts:
            if contract.contract_row_id is None:
                continue
            try:
                self.state_store.mark_contract_pushed(contract.contract_row_id, channel, now_iso)
            except Exception as e:
                print(f"[静流] 标记推送台账失败: {e}")
