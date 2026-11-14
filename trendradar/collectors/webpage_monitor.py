# coding=utf-8
"""
URL 监控采集器（WebpageMonitor）

职责：接收一个 URL，定期抓取，检测实质内容变更，产出可回答"哪里变了"的变更事件。

防噪声六规则（详见 docs/jingliu-refactor-plan.md 交付物 5）：
1. 选择器限域：用户 CSS 选择器优先，自动模式用文本密度启发式
2. 规范化文本：NFKC、空白折叠、空行剔除
3. 动态噪声掩码：时间戳/访问计数/倒计时等默认正则 + 用户 ignore_rules
4. 变更幅度阈值：有效变更字符数低于 min_change_chars 不产出推送事件
5. 结构化 diff：按块（标题/段落）对齐，产出 changed_blocks
6. 首次检查只建基线（is_baseline=True），永不触发推送

依赖：beautifulsoup4（HTML 解析与选择器匹配），延迟导入。
"""

import difflib
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

# 默认动态噪声掩码（changedetection.io 思路的最小集），预编译
DEFAULT_IGNORE_PATTERNS = [
    re.compile(r"\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日]?\s*\d{1,2}:\d{2}"),          # 日期时间戳
    re.compile(r"\d+\s*(秒|分钟|小时|天)前"),                                      # 相对时间
    re.compile(r"(浏览量|阅读量|点击量|评论数|浏览|阅读|点击|评论|点赞|收藏|转发|views?|reads?|clicks?|likes?|comments?)\s*[：:：]?\s*[\d,.]+\s*[万kKwW+]?"),  # 计数器
    re.compile(r"(更新|发布|修改)(于|时间)?\s*[：:：]?\s*\S{0,30}"),               # "更新于 xx"
]

# 参与有效变更字符统计的字符（中文 + 字母数字）
_EFFECTIVE_CHAR_RE = re.compile(r"[\u4e00-\u9fff\u3040-\u30ffA-Za-z0-9]")

# 块级元素：参与结构化 diff 的标签
_BLOCK_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "blockquote", "pre"]
_HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}

# 自动模式下候选正文容器
_AUTO_CONTAINER_SELECTORS = ["article", "main", "#content", ".content", "#main", ".main", "body"]

# 单块文本长度上限（防止超长块撑爆台账）
_MAX_BLOCK_TEXT = 2000
_MAX_BLOCKS = 400


@dataclass
class WebpageChangeEvent:
    """网页变更事件：必须能回答"哪里变了"。"""

    source_id: int
    url: str
    name: str
    previous_fingerprint: str
    current_fingerprint: str
    changed_blocks: List[Dict[str, str]] = field(default_factory=list)
    change_chars: int = 0
    selector_used: str = ""
    is_baseline: bool = False   # 首次检查只建基线
    blocks_snapshot: List[Dict[str, str]] = field(default_factory=list)  # 当前块快照（供台账存储，下次 diff 用）
    min_change_chars: int = 0   # 源级变更幅度阈值（selector_config 优先，全局兜底）


class WebpageMonitor:
    """URL 监控采集器。"""

    def __init__(self, config: Dict[str, Any], get_time_func=None, proxy_url: Optional[str] = None):
        self.config = config
        self.get_time = get_time_func
        self.proxy_url = proxy_url
        webpage_config = config.get("JINGLIU", {}).get("WEBPAGE", {})
        self.request_timeout = webpage_config.get("REQUEST_TIMEOUT", 15)
        self.min_change_chars = webpage_config.get("MIN_CHANGE_CHARS", 50)

    # ========================================
    # 抓取
    # ========================================

    def _fetch(self, url: str) -> str:
        import requests

        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml",
        }
        proxies = {"http": self.proxy_url, "https": self.proxy_url} if self.proxy_url else None
        response = requests.get(url, headers=headers, timeout=self.request_timeout, proxies=proxies)
        response.raise_for_status()
        response.encoding = response.apparent_encoding or "utf-8"
        return response.text

    # ========================================
    # 提取与规范化
    # ========================================

    def analyze(self, html: str, selector_config: Dict[str, Any]) -> Dict[str, Any]:
        """
        解析 HTML，产出块列表、标题与规范化指纹。

        Args:
            html: 页面 HTML
            selector_config: {"title_selector": str, "body_selector": str,
                              "ignore_rules": [正则...]}

        Returns:
            {"title": str, "blocks": [{type, text}], "fingerprint": str}
        """
        title, blocks = extract_blocks(html, selector_config)
        normalized_blocks = [normalize_text(b["text"], selector_config.get("ignore_rules")) for b in blocks]
        fingerprint = make_content_fingerprint(normalized_blocks)
        return {
            "title": title,
            "blocks": [
                {"type": blocks[i]["type"], "text": normalized_blocks[i]}
                for i in range(len(blocks))
                if normalized_blocks[i]
            ],
            "fingerprint": fingerprint,
        }

    def check_source(self, source: Dict, previous: Optional[Dict[str, Any]]) -> Optional[WebpageChangeEvent]:
        """
        检查单个源。

        Args:
            source: sources 表记录（config.url / selector_config）
            previous: {"fingerprint": str, "blocks": [...]}，首次检查传 None

        Returns:
            变更事件；无实质变更返回 None；首次检查返回 is_baseline 事件
        """
        source_config = source.get("config", {})
        url = source_config.get("url", "")
        if not url:
            print(f"[静流] 源 {source.get('name', source.get('id'))} 缺少 config.url，跳过")
            return None

        selector_config = source.get("selector_config", {}) or {}
        html = self._fetch(url)
        current = self.analyze(html, selector_config)

        previous_fingerprint = (previous or {}).get("fingerprint", "")
        if not previous_fingerprint:
            return WebpageChangeEvent(
                source_id=source.get("id", 0),
                url=url,
                name=source.get("name", ""),
                previous_fingerprint="",
                current_fingerprint=current["fingerprint"],
                changed_blocks=[],
                change_chars=0,
                selector_used=selector_config.get("body_selector", "") or "auto",
                is_baseline=True,
                blocks_snapshot=current["blocks"],
                min_change_chars=self._source_threshold(selector_config),
            )

        if current["fingerprint"] == previous_fingerprint:
            return None

        changed_blocks, change_chars = diff_blocks(
            (previous or {}).get("blocks", []), current["blocks"]
        )
        return WebpageChangeEvent(
            source_id=source.get("id", 0),
            url=url,
            name=source.get("name", ""),
            previous_fingerprint=previous_fingerprint,
            current_fingerprint=current["fingerprint"],
            changed_blocks=changed_blocks,
            change_chars=change_chars,
            selector_used=selector_config.get("body_selector", "") or "auto",
            is_baseline=False,
            blocks_snapshot=current["blocks"],
            min_change_chars=self._source_threshold(selector_config),
        )

    def _source_threshold(self, selector_config: Dict[str, Any]) -> int:
        """源级阈值优先（selector_config.min_change_chars），全局配置兜底"""
        try:
            return int(selector_config.get("min_change_chars", self.min_change_chars))
        except (ValueError, TypeError):
            return self.min_change_chars

    def is_meaningful_change(self, event: WebpageChangeEvent) -> bool:
        """变更幅度是否达到推送阈值（闸 3 的采集侧预检，门控层还会复核）"""
        threshold = event.min_change_chars or self.min_change_chars
        return event.change_chars >= threshold


# ========================================
# 模块级纯函数（便于单测）
# ========================================

def make_content_fingerprint(normalized_blocks: List[str]) -> str:
    """内容指纹 = 规范化块列表的 sha256"""
    import hashlib

    canonical = "\x1e".join(b.strip().lower() for b in normalized_blocks if b and b.strip())
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def normalize_text(text: str, ignore_rules: Optional[List[str]] = None) -> str:
    """
    规范化单块文本：
    1. NFKC（全角→半角等）
    2. 逐行应用噪声掩码（默认 + 用户 ignore_rules）
    3. 空白折叠、空行剔除
    """
    if not text:
        return ""

    patterns = list(DEFAULT_IGNORE_PATTERNS)
    for rule in ignore_rules or []:
        try:
            patterns.append(re.compile(rule))
        except re.error:
            print(f"[静流] 忽略规则正则非法，已跳过: {rule}")

    normalized = unicodedata.normalize("NFKC", text)
    kept_lines = []
    for line in normalized.splitlines():
        for pattern in patterns:
            line = pattern.sub(" ", line)
        line = re.sub(r"\s+", " ", line).strip()
        if line:
            kept_lines.append(line)
    return "\n".join(kept_lines)


def extract_blocks(html: str, selector_config: Dict[str, Any]) -> Tuple[str, List[Dict[str, str]]]:
    """
    从 HTML 提取有序内容块。

    - title_selector 命中的元素作为标题块（type="title"）
    - body_selector 限定正文区域；未指定时用文本密度启发式选容器
    - 块 = 区域内按文档顺序的 h1-h6/p/li/blockquote/pre 元素

    Returns:
        (title, blocks)：title 为页面标题；blocks = [{"type": "title"|"paragraph", "text": ...}]
    """
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        print("[静流] 缺少依赖 beautifulsoup4，请运行: uv add beautifulsoup4")
        return "", []

    soup = BeautifulSoup(html, "html.parser")
    for element in soup(["script", "style", "noscript", "template", "svg", "iframe"]):
        element.decompose()

    title = ""
    title_selector = selector_config.get("title_selector", "")
    if title_selector:
        node = soup.select_one(title_selector)
        if node:
            title = node.get_text(" ", strip=True)
    if not title and soup.title:
        title = soup.title.get_text(" ", strip=True)

    body_selector = selector_config.get("body_selector", "")
    if body_selector:
        container = soup.select_one(body_selector)
        selector_used_note = body_selector
        if container is None:
            print(f"[静流] body_selector 未命中: {body_selector}，回退自动提取")
            container = _pick_auto_container(soup)
    else:
        container = _pick_auto_container(soup)

    blocks: List[Dict[str, str]] = []
    if title:
        blocks.append({"type": "title", "text": title})

    if container is not None:
        for node in container.find_all(_BLOCK_TAGS):
            text = node.get_text(" ", strip=True)[:_MAX_BLOCK_TEXT]
            if not text:
                continue
            blocks.append({
                "type": "title" if node.name in _HEADING_TAGS else "paragraph",
                "text": text,
            })
            if len(blocks) >= _MAX_BLOCKS:
                break

    return title, blocks


def _pick_auto_container(soup):
    """自动正文容器：候选选择器中取文本量最大的元素"""
    best, best_len = None, -1
    for selector in _AUTO_CONTAINER_SELECTORS:
        for node in soup.select(selector):
            text_len = len(node.get_text(" ", strip=True))
            if text_len > best_len:
                best, best_len = node, text_len
    return best


def diff_blocks(
    previous_blocks: List[Dict[str, str]],
    current_blocks: List[Dict[str, str]],
) -> Tuple[List[Dict[str, str]], int]:
    """
    结构化 diff：按块对齐，产出变更块与有效变更字符数。

    Returns:
        (changed_blocks, change_chars)
        changed_blocks = [{"type": "title"|"paragraph", "old": str, "new": str}]
        change_chars = 变更文本中的中文/字母数字字符数
    """
    old_texts = [b.get("text", "") for b in previous_blocks or []]
    new_texts = [b.get("text", "") for b in current_blocks or []]
    old_types = [b.get("type", "paragraph") for b in previous_blocks or []]
    new_types = [b.get("type", "paragraph") for b in current_blocks or []]

    matcher = difflib.SequenceMatcher(a=old_texts, b=new_texts, autojunk=False)
    changed: List[Dict[str, str]] = []
    change_chars = 0

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        if tag == "delete":
            for i in range(i1, i2):
                changed.append({"type": old_types[i], "old": old_texts[i], "new": ""})
                change_chars += _effective_chars(old_texts[i])
        elif tag == "insert":
            for j in range(j1, j2):
                changed.append({"type": new_types[j], "old": "", "new": new_texts[j]})
                change_chars += _effective_chars(new_texts[j])
        else:  # replace：逐对配对输出
            old_range = list(range(i1, i2))
            new_range = list(range(j1, j2))
            pair_count = max(len(old_range), len(new_range))
            for k in range(pair_count):
                old_text = old_texts[old_range[k]] if k < len(old_range) else ""
                new_text = new_texts[new_range[k]] if k < len(new_range) else ""
                changed.append({
                    "type": new_types[new_range[k]] if k < len(new_range) else old_types[old_range[k]],
                    "old": old_text,
                    "new": new_text,
                })
                # 块内字符级 diff，只统计确实变化的有效字符（等长替换也能算出）
                change_chars += _changed_effective_chars(old_text, new_text)

    return changed, change_chars


def _changed_effective_chars(old_text: str, new_text: str) -> int:
    """两段文本间真实变化的有效字符数（字符级 diff；纯标点/空白变化计 0）"""
    if old_text == new_text:
        return 0
    sm = difflib.SequenceMatcher(a=old_text or "", b=new_text or "", autojunk=False)
    count = 0
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        count += _effective_chars(old_text[i1:i2]) + _effective_chars(new_text[j1:j2])
    return count


def _effective_chars(text: str) -> int:
    """有效字符数：中文/字母数字（剔除标点与空白，避免纯标点变化触发推送）"""
    return len(_EFFECTIVE_CHAR_RE.findall(text or ""))
