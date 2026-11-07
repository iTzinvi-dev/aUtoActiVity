"""
main.py
-------
Production Pipeline Orchestrator & Scheduler for the Global Developer Pulse & Trending Tech Digest Pipeline.
Supports two execution modes:
1. Single-shot Cron Mode (`python main.py --once` or `RUN_ONCE=true`):
   Ideal for GitHub Actions (`0 */6 * * *`), Cloud Run Jobs, or systemd timers.
2. Continuous 24/7 Daemon Mode (`python main.py`):
   Runs immediately once on startup, then schedules recurring runs every 6 hours.
"""

from __future__ import annotations

import os
import signal
import sys
import time
from types import FrameType
import schedule

from ai_processor import process_developer_batch_with_groq
from bot_sender import save_digest_to_archive, send_telegram_digest
from config import PipelineConfig, load_config, setup_logging
from scraper import fetch_daily_developer_batch


def execute_pipeline_cycle(config: PipelineConfig) -> bool:
    """
    Execute a single end-to-end cycle of the Developer Pulse pipeline:
    1. Scrape & deduplicate top stories from Hacker News & DEV.to
    2. Summarize & categorize with Groq LPU API (`llama-3.3-70b-versatile`)
    3. Format & broadcast to all Telegram Bot subscribers + archive to `daily_digests.json`
    4. Commit processed story IDs to `processed_ids.json`
    """
    logger = setup_logging(config.pipeline_log_file)
    logger.info("================================================================")
    logger.info("Starting Global Developer Pulse & Trending Tech Digest cycle...")

    try:
        raw_batch, dedup_store = fetch_daily_developer_batch(config)
        if not raw_batch:
            logger.info("No new unseen stories found in this cycle. Skipping AI & Telegram steps.")
            return True

        processed_batch = process_developer_batch_with_groq(raw_batch, config)
        delivery_result = send_telegram_digest(processed_batch, config)
        save_digest_to_archive(processed_batch, delivery_result, config.daily_digests_file)

        # Mark items as processed only after digest generation and archival succeed
        dedup_store.mark_processed([item.uid for item in raw_batch])
        logger.info(
            "Pipeline cycle completed successfully: %d items processed, Telegram delivered=%s.",
            len(processed_batch.items),
            delivery_result.get("delivered"),
        )
        return True

    except Exception as exc:
        logger.exception("Unhandled error during pipeline cycle execution: %s", exc)
        return False


def main() -> None:
    """Entrypoint: validate configuration, run once (--once) or start the 24/7 scheduler loop."""
    config = load_config()
    logger = setup_logging(config.pipeline_log_file)
    run_once_mode = "--once" in sys.argv or os.getenv("RUN_ONCE", "").strip().lower() in ("1", "true", "yes")

    logger.info("Initializing Global Developer Pulse & Trending Tech Digest Pipeline (Python 3.11+ & Groq LPU)...")
    try:
        warnings = config.validate(require_telegram=False)
        for warning in warnings:
            logger.warning("Configuration notice: %s", warning)
    except ValueError as err:
        logger.critical("Configuration validation failed: %s", err)
        sys.exit(1)

    if run_once_mode:
        logger.info("Executing single-shot cron cycle (--once mode for GitHub Actions / Cron)...")
        success = execute_pipeline_cycle(config)
        sys.exit(0 if success else 1)

    # Graceful shutdown handler for Docker / systemd / terminal SIGINT & SIGTERM
    running = True

    def handle_shutdown(signum: int, _frame: FrameType | None) -> None:
        nonlocal running
        logger.info("Received signal %d. Shutting down scheduler gracefully...", signum)
        running = False

    signal.signal(signal.SIGINT, handle_shutdown)
    signal.signal(signal.SIGTERM, handle_shutdown)

    # Step 1: Run immediately on startup for instant verification
    logger.info("Running initial startup digest cycle now...")
    execute_pipeline_cycle(config)

    # Step 2: Configure recurring schedule
    if config.daily_run_time:
        logger.info("Scheduling daily pipeline execution at %s UTC/local time.", config.daily_run_time)
        schedule.every().day.at(config.daily_run_time).do(execute_pipeline_cycle, config=config)
    else:
        logger.info(
            "Scheduling recurring pipeline execution every %d hours.",
            config.schedule_interval_hours,
        )
        schedule.every(config.schedule_interval_hours).hours.do(execute_pipeline_cycle, config=config)

    # Continuous 24/7 loop
    while running:
        try:
            schedule.run_pending()
        except Exception as exc:
            logger.error("Scheduler loop caught exception (recovering): %s", exc)
        time.sleep(5)

    logger.info("Pipeline stopped cleanly.")


if __name__ == "__main__":
    main()
