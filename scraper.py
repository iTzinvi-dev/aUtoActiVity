"""
scraper.py
----------
Fetches real-time authentic developer stories from:
1. Hacker News Official Firebase API (https://hacker-news.firebaseio.com/v0/topstories.json)
2. DEV.to Official Public API (https://dev.to/api/articles?top=1&per_page=5)

Includes exponential backoff retry logic and local deduplication via processed_ids.json.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import requests

from config import PipelineConfig

logger = logging.getLogger("dev_pulse_pipeline")

HN_TOP_STORIES_URL = "https://hacker-news.firebaseio.com/v0/topstories.json"
HN_ITEM_URL_TEMPLATE = "https://hacker-news.firebaseio.com/v0/item/{item_id}.json"
DEVTO_TOP_ARTICLES_URL = "https://dev.to/api/articles"


@dataclass
class RawDeveloperItem:
    """Normalized representation of a developer story or article across sources."""

    uid: str
    source: str  # "Hacker News" or "DEV.to"
    title: str
    url: str
    discussion_url: str
    author: str
    score: int
    comments_count: int
    tags: list[str]
    excerpt: str
    published_at: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class DeduplicationStore:
    """Manages persistent deduplication state in processed_ids.json."""

    def __init__(self, file_path: Path) -> None:
        self.file_path = file_path
        self._processed: dict[str, str] = self._load()

    def _load(self) -> dict[str, str]:
        if not self.file_path.exists():
            return {}
        try:
            raw = json.loads(self.file_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and "items" in raw and isinstance(raw["items"], dict):
                return dict(raw["items"])
            if isinstance(raw, list):
                return {str(item_id): datetime.now(timezone.utc).isoformat() for item_id in raw}
            if isinstance(raw, dict):
                return {str(k): str(v) for k, v in raw.items()}
        except Exception as exc:
            logger.warning("Failed to parse %s (%s). Starting with fresh deduplication store.", self.file_path, exc)
        return {}

    def is_processed(self, uid: str) -> bool:
        return uid in self._processed

    def mark_processed(self, uids: list[str]) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        for uid in uids:
            self._processed[uid] = now_iso
        self.save()

    def save(self) -> None:
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "total_count": len(self._processed),
            "items": self._processed,
        }
        self.file_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def request_with_backoff(
    url: str,
    params: dict[str, Any] | None = None,
    timeout: int = 15,
    max_retries: int = 3,
) -> Any:
    """
    Perform an HTTP GET request with exponential backoff retry protection.
    """
    headers = {
        "User-Agent": "GlobalDeveloperPulseBot/1.0 (+https://github.com/dev-pulse-pipeline)",
        "Accept": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
    }
    last_error: Exception | None = None

    for attempt in range(1, max_retries + 1):
        try:
            response = requests.get(url, params=params, headers=headers, timeout=timeout)
            if response.status_code == 429:
                retry_after = int(response.headers.get("Retry-After", 2 ** attempt))
                logger.warning("Rate limited (429) by %s. Sleeping %ds...", url, retry_after)
                time.sleep(retry_after)
                continue

            response.raise_for_status()
            return response.json()
        except Exception as exc:
            last_error = exc
            sleep_seconds = 2 ** (attempt - 1)
            logger.warning(
                "HTTP GET failed for %s (attempt %d/%d): %s. Retrying in %ds...",
                url,
                attempt,
                max_retries,
                exc,
                sleep_seconds,
            )
            if attempt < max_retries:
                time.sleep(sleep_seconds)

    raise RuntimeError(f"Exhausted {max_retries} retries fetching {url}: {last_error}") from last_error


def fetch_hacker_news_top_stories(
    config: PipelineConfig,
    dedup_store: DeduplicationStore,
) -> list[RawDeveloperItem]:
    """
    Fetch top N highest-voted stories from Hacker News Official Firebase API,
    skipping already-processed story IDs.
    """
    logger.info("Fetching top story IDs from Hacker News Official Firebase API...")
    story_ids = request_with_backoff(
        HN_TOP_STORIES_URL,
        timeout=config.request_timeout_seconds,
        max_retries=config.max_retries,
    )

    if not isinstance(story_ids, list):
        logger.error("Unexpected response payload from Hacker News topstories endpoint.")
        return []

    candidate_items: list[RawDeveloperItem] = []
    # Scan top 35 IDs to collect enough unseen stories and sort by highest score
    scan_pool = story_ids[:35]

    for item_id in scan_pool:
        uid = f"hn_{item_id}"
        if dedup_store.is_processed(uid):
            continue

        try:
            item_url = HN_ITEM_URL_TEMPLATE.format(item_id=item_id)
            item_data = request_with_backoff(
                item_url,
                timeout=config.request_timeout_seconds,
                max_retries=config.max_retries,
            )
            if not isinstance(item_data, dict):
                continue

            if item_data.get("type") != "story" or item_data.get("dead") or item_data.get("deleted"):
                continue

            title = str(item_data.get("title", "")).strip()
            if not title:
                continue

            hn_discussion_url = f"https://news.ycombinator.com/item?id={item_id}"
            story_url = str(item_data.get("url") or hn_discussion_url).strip()
            score = int(item_data.get("score") or 0)
            comments_count = int(item_data.get("descendants") or 0)
            author = str(item_data.get("by") or "anonymous")
            timestamp = int(item_data.get("time") or int(time.time()))
            published_iso = datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()
            raw_text = str(item_data.get("text") or "").strip()

            candidate_items.append(
                RawDeveloperItem(
                    uid=uid,
                    source="Hacker News",
                    title=title,
                    url=story_url,
                    discussion_url=hn_discussion_url,
                    author=author,
                    score=score,
                    comments_count=comments_count,
                    tags=["hacker-news", "engineering"],
                    excerpt=raw_text[:300] if raw_text else f"Hacker News discussion ({score} points, {comments_count} comments).",
                    published_at=published_iso,
                )
            )

            # Stop scanning once we have enough candidates to pick the top-voted ones
            if len(candidate_items) >= config.hn_top_limit * 2:
                break

        except Exception as exc:
            logger.warning("Skipping HN item %s due to error: %s", item_id, exc)

    # Sort by highest score descending and return top N
    candidate_items.sort(key=lambda item: item.score, reverse=True)
    selected = candidate_items[: config.hn_top_limit]
    logger.info("Collected %d new top Hacker News stories.", len(selected))
    return selected


def fetch_devto_trending_articles(
    config: PipelineConfig,
    dedup_store: DeduplicationStore,
) -> list[RawDeveloperItem]:
    """
    Fetch top N trending developer articles published in the last 24 hours from DEV.to API.
    """
    logger.info("Fetching trending developer articles from DEV.to Public API...")
    # Request a slightly larger page to allow deduplication while still returning 5 fresh items
    per_page = max(config.devto_top_limit * 3, 15)
    articles = request_with_backoff(
        DEVTO_TOP_ARTICLES_URL,
        params={"top": 1, "per_page": per_page},
        timeout=config.request_timeout_seconds,
        max_retries=config.max_retries,
    )

    if not isinstance(articles, list):
        logger.error("Unexpected response payload from DEV.to articles endpoint.")
        return []

    selected: list[RawDeveloperItem] = []

    for article in articles:
        if not isinstance(article, dict):
            continue

        article_id = article.get("id")
        if not article_id:
            continue

        uid = f"devto_{article_id}"
        if dedup_store.is_processed(uid):
            continue

        title = str(article.get("title") or "").strip()
        url = str(article.get("url") or "").strip()
        if not title or not url:
            continue

        user_obj = article.get("user") or {}
        author = str(user_obj.get("username") or user_obj.get("name") or "dev_author")
        reactions = int(article.get("public_reactions_count") or article.get("positive_reactions_count") or 0)
        comments = int(article.get("comments_count") or 0)
        tag_list = article.get("tag_list") if isinstance(article.get("tag_list"), list) else []
        description = str(article.get("description") or "").strip()
        published_at = str(article.get("published_timestamp") or article.get("published_at") or datetime.now(timezone.utc).isoformat())

        selected.append(
            RawDeveloperItem(
                uid=uid,
                source="DEV.to",
                title=title,
                url=url,
                discussion_url=url,
                author=author,
                score=reactions,
                comments_count=comments,
                tags=[str(t) for t in tag_list],
                excerpt=description,
                published_at=published_at,
            )
        )

        if len(selected) >= config.devto_top_limit:
            break

    logger.info("Collected %d new trending DEV.to articles.", len(selected))
    return selected


def fetch_daily_developer_batch(
    config: PipelineConfig,
) -> tuple[list[RawDeveloperItem], DeduplicationStore]:
    """
    Orchestrates fetching from both Hacker News and DEV.to APIs with deduplication.
    Returns the combined batch of unseen items and the DeduplicationStore instance.
    """
    dedup_store = DeduplicationStore(config.processed_ids_file)
    batch: list[RawDeveloperItem] = []

    try:
        hn_items = fetch_hacker_news_top_stories(config, dedup_store)
        batch.extend(hn_items)
    except Exception as exc:
        logger.error("Failed to fetch Hacker News stories: %s", exc)

    try:
        devto_items = fetch_devto_trending_articles(config, dedup_store)
        batch.extend(devto_items)
    except Exception as exc:
        logger.error("Failed to fetch DEV.to articles: %s", exc)

    logger.info("Total new deduplicated developer items ready for AI processing: %d", len(batch))
    return batch, dedup_store
