"""
bot_sender.py
-------------
Formats processed developer digests into clean HTML messages for Telegram,
handles Telegram's 4096-character limit with intelligent item-boundary chunking,
persists all /start subscriber chat IDs in subscribers.json so subscribers receive
updates forever (even after Telegram's 24h getUpdates window), enforces rate-limit &
exponential backoff protection, and archives digests in daily_digests.json.
"""

from __future__ import annotations

import html
import json
import logging
import time
from pathlib import Path
from typing import Any
import requests

from ai_processor import ProcessedDigestBatch, ProcessedDigestItem
from config import BASE_DIR, PipelineConfig

logger = logging.getLogger("dev_pulse_pipeline")

SUBSCRIBERS_FILE = BASE_DIR / "subscribers.json"


def format_single_item_html(index: int, item: ProcessedDigestItem) -> str:
    """Format a single digest item using safe Telegram HTML tags."""
    safe_tag = html.escape(item.category_tag)
    safe_title = html.escape(item.title)
    safe_takeaway = html.escape(item.takeaway)
    safe_source = html.escape(item.source)
    safe_author = html.escape(item.author)
    safe_url = html.escape(item.url, quote=True)
    safe_disc_url = html.escape(item.discussion_url, quote=True)

    links_line = f'🔗 <a href="{safe_url}">Read Source</a>'
    if item.discussion_url and item.discussion_url != item.url:
        links_line += f' · <a href="{safe_disc_url}">HN Discussion ({item.comments_count})</a>'

    return (
        f"<b>{index}. {safe_tag} {safe_title}</b>\n"
        f"{safe_takeaway}\n"
        f"<i>{safe_source} · ▲ {item.score} · @{safe_author}</i>\n"
        f"{links_line}"
    )


def format_digest_chunks(
    batch: ProcessedDigestBatch,
    max_length: int = 4000,
) -> list[str]:
    """
    Build clean Telegram HTML messages while respecting Telegram's 4096-character limit
    (using a safe 4000-char ceiling so HTML tags are never split mid-element).
    """
    if not batch.items:
        return []

    header = (
        f"🌐 <b>Global Developer Pulse &amp; Tech Digest</b>\n"
        f"<i>Language: {html.escape(batch.output_language)} · 6h Automated Pulse</i>\n\n"
        f"💡 {html.escape(batch.editorial_headline)}\n"
        f"────────────────────────\n\n"
    )

    chunks: list[str] = []
    current_chunk = header

    for idx, item in enumerate(batch.items, start=1):
        item_block = format_single_item_html(idx, item) + "\n\n"
        if len(current_chunk) + len(item_block) > max_length:
            if current_chunk.strip():
                chunks.append(current_chunk.strip())
            continuation_header = (
                f"🌐 <b>Global Developer Pulse (Part {len(chunks) + 1})</b>\n"
                f"────────────────────────\n\n"
            )
            current_chunk = continuation_header + item_block
        else:
            current_chunk += item_block

    if current_chunk.strip():
        chunks.append(current_chunk.strip())

    return chunks


def normalize_chat_id(raw_chat_id: str) -> str:
    """Normalize Telegram channel URLs (https://t.me/channel) or usernames into @channel or numeric ID."""
    cleaned = raw_chat_id.strip()
    if not cleaned or cleaned == "YOUR_TELEGRAM_CHAT_ID":
        return ""
    if "t.me/" in cleaned:
        slug = cleaned.split("t.me/")[-1].split("/")[0].split("?")[0].strip()
        if slug and not slug.startswith("+"):
            return f"@{slug}" if not slug.startswith("@") else slug
    if not cleaned.startswith("@") and not cleaned.lstrip("-").isdigit():
        return f"@{cleaned}"
    return cleaned


def load_persisted_subscriber_ids() -> list[str]:
    """Load previously registered /start subscriber chat IDs from subscribers.json."""
    ids: list[str] = []
    seen: set[str] = set()
    if SUBSCRIBERS_FILE.exists():
        try:
            data = json.loads(SUBSCRIBERS_FILE.read_text(encoding="utf-8"))
            raw_list = data.get("chat_ids", []) if isinstance(data, dict) else data
            if isinstance(raw_list, list):
                for item in raw_list:
                    cid = str(item.get("id") if isinstance(item, dict) else item).strip()
                    if cid and cid not in seen:
                        seen.add(cid)
                        ids.append(cid)
        except Exception as exc:
            logger.warning("Failed reading subscribers.json: %s", exc)
    return ids


def save_persisted_subscriber_ids(chat_ids: list[str]) -> None:
    """Persist all known /start subscriber chat IDs to subscribers.json."""
    unique_ids: list[str] = []
    seen: set[str] = set()
    for cid in chat_ids:
        clean = str(cid).strip()
        if clean and clean not in seen:
            seen.add(clean)
            unique_ids.append(clean)
    payload = {
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "total_subscribers": len(unique_ids),
        "chat_ids": unique_ids,
    }
    try:
        SUBSCRIBERS_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except Exception as exc:
        logger.warning("Failed saving subscribers.json: %s", exc)


def discover_all_subscriber_chats(bot_token: str, timeout: int = 10) -> list[str]:
    """
    Merge persisted subscribers from subscribers.json with live /start interactions
    from Telegram's getUpdates API so no subscriber is ever lost after 24 hours.
    """
    subscribers: list[str] = load_persisted_subscriber_ids()
    seen: set[str] = set(subscribers)
    try:
        url = f"https://api.telegram.org/bot{bot_token}/getUpdates?limit=100"
        resp = requests.get(url, timeout=timeout)
        if resp.ok:
            data = resp.json()
            results = data.get("result") or []
            for update in results:
                for key in ("message", "channel_post", "edited_message", "my_chat_member"):
                    obj = update.get(key)
                    if isinstance(obj, dict) and isinstance(obj.get("chat"), dict):
                        new_status = (obj.get("new_chat_member") or {}).get("status")
                        cid = obj["chat"].get("id")
                        if cid is not None:
                            cid_str = str(cid)
                            if new_status in ("kicked", "left"):
                                if cid_str in seen:
                                    seen.remove(cid_str)
                                    subscribers = [x for x in subscribers if x != cid_str]
                                continue
                            if cid_str not in seen:
                                seen.add(cid_str)
                                subscribers.append(cid_str)
    except Exception as exc:
        logger.warning("Could not discover Telegram subscribers via getUpdates: %s", exc)

    save_persisted_subscriber_ids(subscribers)
    return subscribers


def send_telegram_digest(
    batch: ProcessedDigestBatch,
    config: PipelineConfig,
) -> dict[str, Any]:
    """
    Broadcast formatted digest chunks to ALL Telegram subscribers (everyone who sent /start
    plus any configured TELEGRAM_CHAT_ID) via Telegram Bot API.
    """
    chunks = format_digest_chunks(batch, max_length=min(4000, config.telegram_max_message_length - 96))
    if not chunks:
        logger.info("No digest chunks to send to Telegram.")
        return {"delivered": False, "chunks_sent": 0, "reason": "Empty batch"}

    if not config.telegram_bot_token or config.telegram_bot_token == "YOUR_TELEGRAM_BOT_TOKEN":
        logger.warning("Telegram Bot Token not configured; skipping live Telegram Bot API dispatch.")
        return {
            "delivered": False,
            "chunks_sent": 0,
            "reason": "TELEGRAM_BOT_TOKEN not configured",
            "preview_chunks": chunks,
        }

    recipient_chat_ids: list[str] = discover_all_subscriber_chats(
        config.telegram_bot_token,
        config.request_timeout_seconds,
    )
    configured_chat_id = normalize_chat_id(config.telegram_chat_id)
    if configured_chat_id and configured_chat_id not in recipient_chat_ids:
        recipient_chat_ids.append(configured_chat_id)
        save_persisted_subscriber_ids(recipient_chat_ids)

    if not recipient_chat_ids:
        logger.warning("No Telegram subscribers found yet via getUpdates or TELEGRAM_CHAT_ID.")
        return {
            "delivered": False,
            "chunks_sent": 0,
            "reason": "Waiting for users to send /start to the Telegram bot.",
            "preview_chunks": chunks,
        }

    endpoint = f"https://api.telegram.org/bot{config.telegram_bot_token}/sendMessage"
    message_ids: list[int] = []
    delivered_chats: list[str] = []

    for target_chat_id in recipient_chat_ids:
        chat_ok = True
        for chunk_idx, text_chunk in enumerate(chunks, start=1):
            payload = {
                "chat_id": target_chat_id,
                "text": text_chunk,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            }

            sent = False
            for attempt in range(1, config.max_retries + 1):
                try:
                    response = requests.post(endpoint, json=payload, timeout=config.request_timeout_seconds)
                    if response.status_code == 429:
                        retry_after = int(
                            response.json().get("parameters", {}).get("retry_after", 2 ** attempt)
                        )
                        logger.warning("Telegram rate limit hit. Waiting %ds...", retry_after)
                        time.sleep(retry_after)
                        continue

                    response.raise_for_status()
                    body = response.json()
                    msg_id = body.get("result", {}).get("message_id")
                    if msg_id:
                        message_ids.append(int(msg_id))
                    sent = True
                    break
                except Exception as exc:
                    backoff = 2 ** (attempt - 1)
                    logger.warning(
                        "Telegram sendMessage failed for chat %s chunk %d/%d (attempt %d/%d): %s.",
                        target_chat_id,
                        chunk_idx,
                        len(chunks),
                        attempt,
                        config.max_retries,
                        exc,
                    )
                    if attempt < config.max_retries:
                        time.sleep(backoff)

            if not sent:
                chat_ok = False
                break

            if chunk_idx < len(chunks):
                time.sleep(0.5)

        if chat_ok:
            delivered_chats.append(target_chat_id)

    logger.info(
        "Broadcasted Telegram digest to %d/%d subscriber(s).",
        len(delivered_chats),
        len(recipient_chat_ids),
    )

    return {
        "delivered": len(delivered_chats) > 0,
        "chunks_sent": len(message_ids),
        "message_ids": message_ids,
        "recipients_count": len(delivered_chats),
        "delivered_chat_ids": delivered_chats,
        "preview_chunks": chunks,
    }


def save_digest_to_archive(
    batch: ProcessedDigestBatch,
    delivery_status: dict[str, Any],
    archive_file: Path,
) -> None:
    """
    Append the generated daily digest and delivery telemetry to daily_digests.json.
    """
    archive_file.parent.mkdir(parents=True, exist_ok=True)
    history: list[dict[str, Any]] = []

    if archive_file.exists():
        try:
            existing = json.loads(archive_file.read_text(encoding="utf-8"))
            if isinstance(existing, list):
                history = existing
        except Exception as exc:
            logger.warning("Could not read existing %s (%s). Initializing new archive list.", archive_file, exc)

    record = {
        **batch.to_dict(),
        "telegram_delivery": {
            "delivered": delivery_status.get("delivered", False),
            "chunks_sent": delivery_status.get("chunks_sent", 0),
            "message_ids": delivery_status.get("message_ids", []),
            "reason": delivery_status.get("reason"),
            "recipients_count": delivery_status.get("recipients_count", 0),
            "delivered_chat_ids": delivery_status.get("delivered_chat_ids", []),
        },
        "formatted_messages": delivery_status.get("preview_chunks", []),
    }

    history.insert(0, record)
    # Keep the most recent 100 digest runs
    history = history[:100]
    archive_file.write_text(json.dumps(history, indent=2, ensure_ascii=False), encoding="utf-8")
    logger.info("Archived digest run to %s (total stored runs: %d).", archive_file.name, len(history))
