"""
config.py
---------
Centralized environment variable loader, configuration schema, and structured logger setup
for the Global Developer Pulse & Trending Tech Digest Pipeline (powered by Groq LPU API).
"""

from __future__ import annotations

import logging
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables from .env file if present
load_dotenv()

BASE_DIR = Path(__file__).resolve().parent


class SecretRedactingFilter(logging.Filter):
    """Redacts Telegram bot tokens, GitHub PATs, and Groq API keys from log records."""

    _TOKEN_RE = re.compile(r"\b\d{7,12}:[A-Za-z0-9_-]{20,}\b")
    _GROQ_KEY_RE = re.compile(r"\bgsk_[A-Za-z0-9_-]{20,}\b")
    _GH_PAT_RE = re.compile(r"\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b")

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        sanitized = self._TOKEN_RE.sub("[REDACTED_TELEGRAM_TOKEN]", msg)
        sanitized = self._GROQ_KEY_RE.sub("[REDACTED_GROQ_KEY]", sanitized)
        sanitized = self._GH_PAT_RE.sub("[REDACTED_GITHUB_PAT]", sanitized)
        record.msg = sanitized
        record.args = ()
        return True


@dataclass(frozen=True)
class PipelineConfig:
    """Immutable configuration container validated at startup."""

    groq_api_key: str
    groq_model: str
    groq_fallback_model: str
    telegram_bot_token: str
    telegram_chat_id: str
    output_language: str
    hn_top_limit: int
    devto_top_limit: int
    schedule_interval_hours: int
    daily_run_time: str
    processed_ids_file: Path
    daily_digests_file: Path
    pipeline_log_file: Path
    request_timeout_seconds: int = 20
    max_retries: int = 3
    telegram_max_message_length: int = 4096

    def validate(self, require_telegram: bool = False) -> list[str]:
        """
        Validate environment variables and return a list of non-fatal warnings.
        Never crashes startup so 24/7 GitHub Actions / cron jobs always run cleanly.
        """
        warnings: list[str] = []

        if not self.groq_api_key or self.groq_api_key == "YOUR_GROQ_API_KEY":
            warnings.append(
                "GROQ_API_KEY is not set in environment/GitHub Secrets. "
                "Using built-in deterministic engineering synthesizer until GROQ_API_KEY is added."
            )

        if not self.telegram_bot_token or self.telegram_bot_token == "YOUR_TELEGRAM_BOT_TOKEN":
            msg = (
                "TELEGRAM_BOT_TOKEN is not configured. Digests will be generated and "
                "saved to daily_digests.json, but Telegram dispatch will be skipped."
            )
            if require_telegram:
                raise ValueError(msg)
            warnings.append(msg)

        if not self.telegram_chat_id or self.telegram_chat_id == "YOUR_TELEGRAM_CHAT_ID":
            msg = (
                "TELEGRAM_CHAT_ID is not configured. Digests will still be broadcast to all "
                "active /start bot subscribers in subscribers.json and getUpdates."
            )
            if require_telegram:
                raise ValueError(msg)
            warnings.append(msg)

        if self.output_language not in ("English", "Bengali"):
            warnings.append(
                f"Unrecognized OUTPUT_LANGUAGE='{self.output_language}'. "
                "Supported primary options are 'English' or 'Bengali'. Proceeding with custom language instruction."
            )

        return warnings


def setup_logging(log_file: Path) -> logging.Logger:
    """
    Configure structured logging to both stdout console and rotating pipeline.log file
    with automatic credential redaction.
    """
    log_file.parent.mkdir(parents=True, exist_ok=True)

    logger = logging.getLogger("dev_pulse_pipeline")
    logger.setLevel(logging.INFO)

    if logger.handlers:
        return logger

    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)-8s | %(name)s:%(module)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    redactor = SecretRedactingFilter()

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(logging.INFO)
    console_handler.setFormatter(formatter)
    console_handler.addFilter(redactor)

    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    file_handler.setLevel(logging.INFO)
    file_handler.setFormatter(formatter)
    file_handler.addFilter(redactor)

    logger.addHandler(console_handler)
    logger.addHandler(file_handler)

    return logger


def load_config() -> PipelineConfig:
    """Load configuration from environment variables with sensible production defaults."""
    output_lang = os.getenv("OUTPUT_LANGUAGE", "English").strip() or "English"

    try:
        hn_limit = max(1, min(20, int(os.getenv("HN_TOP_LIMIT", "5"))))
    except ValueError:
        hn_limit = 5

    try:
        devto_limit = max(1, min(20, int(os.getenv("DEVTO_TOP_LIMIT", "5"))))
    except ValueError:
        devto_limit = 5

    try:
        interval_hours = max(1, int(os.getenv("SCHEDULE_INTERVAL_HOURS", "6")))
    except ValueError:
        interval_hours = 6

    processed_file = BASE_DIR / os.getenv("PROCESSED_IDS_FILE", "processed_ids.json")
    digests_file = BASE_DIR / os.getenv("DAILY_DIGESTS_FILE", "daily_digests.json")
    log_file = BASE_DIR / os.getenv("PIPELINE_LOG_FILE", "pipeline.log")
    tg_config_file = BASE_DIR / "telegram_config.json"

    tg_token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    tg_chat_id = os.getenv("TELEGRAM_CHAT_ID", "").strip()

    if tg_config_file.exists():
        try:
            import json
            synced_tg = json.loads(tg_config_file.read_text(encoding="utf-8"))
            if (not tg_token or tg_token == "YOUR_TELEGRAM_BOT_TOKEN") and synced_tg.get("botToken"):
                tg_token = str(synced_tg["botToken"]).strip()
            if (not tg_chat_id or tg_chat_id == "YOUR_TELEGRAM_CHAT_ID") and synced_tg.get("chatId"):
                tg_chat_id = str(synced_tg["chatId"]).strip()
        except Exception:
            pass

    return PipelineConfig(
        groq_api_key=os.getenv("GROQ_API_KEY", "").strip(),
        groq_model=os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile").strip() or "llama-3.3-70b-versatile",
        groq_fallback_model=os.getenv("GROQ_FALLBACK_MODEL", "llama-3.1-8b-instant").strip() or "llama-3.1-8b-instant",
        telegram_bot_token=tg_token,
        telegram_chat_id=tg_chat_id,
        output_language=output_lang,
        hn_top_limit=hn_limit,
        devto_top_limit=devto_limit,
        schedule_interval_hours=interval_hours,
        daily_run_time=os.getenv("DAILY_RUN_TIME", "").strip(),
        processed_ids_file=processed_file,
        daily_digests_file=digests_file,
        pipeline_log_file=log_file,
    )
