# Global Developer Pulse & Trending Tech Digest Pipeline

An automated, production-ready **Python 3.11+ Automation Workflow & Bot Pipeline** (paired with a live full-stack Control Center UI) that fetches real-time daily developer news, open-source trends, and engineering discussions worldwide, synthesizes them into structured technical takeaways using the **Groq LPU API (`groq` / `llama-3.3-70b-versatile`)**, and broadcasts formatted digests to all **Telegram Bot Subscribers (`/start`) and Channels**.

---

## Pipeline Architecture

1. **Trigger & Authentic Data Ingestion (`scraper.py`)**
   - **Hacker News Official Firebase API**: Queries `https://hacker-news.firebaseio.com/v0/topstories.json` and fetches item details to select the top 5 highest-voted tech/coding stories of the day.
   - **DEV.to Official Public API**: Queries `https://dev.to/api/articles?top=1&per_page=5` to fetch the top 5 trending developer articles published in the last 24 hours.
   - **Persistent Deduplication**: Tracks every processed story ID in `processed_ids.json` (and Firebase Firestore `/processed_items`) so no story or article is ever summarized or dispatched twice.

2. **Groq LPU Synthesis & Categorization (`ai_processor.py`)**
   - Uses the official **`groq`** Python SDK with model **`llama-3.3-70b-versatile`** (and automatic failover to **`llama-3.1-8b-instant`**) in structured JSON object mode.
   - Assigns a clean domain tag (`[AI/ML]`, `[Web Dev]`, `[System Design]`, `[Open Source]`, `[Cloud/DevOps]`, `[Security]`, `[Systems]`).
   - Generates a concise **2-sentence technical takeaway** explaining why the story matters to practicing developers.
   - Supports `OUTPUT_LANGUAGE` (`English` by default, or `Bengali` while preserving technical terms in English).

3. **Multi-Subscriber Telegram Broadcast & Archival (`bot_sender.py`)**
   - Automatically discovers all users, groups, and channels that send `/start` to your bot via `getUpdates` and broadcasts HTML-formatted digests to every subscriber simultaneously.
   - Automatically splits digests across item boundaries to stay cleanly below Telegram's 4096-character limit.
   - Saves a complete backup log of all generated digests in `daily_digests.json` and Firebase Firestore `/digest_runs`.

4. **24/7 Resilient Scheduling & Zero-Plaintext Security (`main.py` & `config.py`)**
   - Executes once immediately on startup for verification, then runs automatically every **6 hours** (or at a fixed daily time via `DAILY_RUN_TIME` in `.env`) using `schedule`.
   - Encrypts bot credentials at rest using AES-256-GCM and automatically redacts secret tokens from `pipeline.log`.

---

## Project Structure

```text
├── config.py             # Environment variable loading, validation, and secret-redacting logger
├── scraper.py            # Hacker News & DEV.to API fetchers + processed_ids.json deduplication
├── ai_processor.py       # Groq LPU (llama-3.3-70b-versatile) structured JSON digest synthesis
├── bot_sender.py         # Multi-subscriber Telegram Bot broadcaster & daily_digests.json logger
├── main.py               # Pipeline orchestrator & 6-hour / daily schedule runner
├── requirements.txt      # Python 3.11+ dependencies (groq, requests, schedule, pydantic, dotenv)
├── .env.example          # Template for environment variables
├── processed_ids.json    # Local deduplication store
├── daily_digests.json    # Local backup archive of generated digests
└── pipeline.log          # Structured execution and error log
```

---

## How to Obtain Credentials

### 1. Groq API Key (`GROQ_API_KEY`)
1. Visit [GroqCloud Console API Keys](https://console.groq.com/keys).
2. Sign in and click **Create API Key**.
3. Copy the key (`gsk_...`) and set `GROQ_API_KEY="your_key_here"` in your `.env` file or AI Studio Secrets panel.

### 2. Telegram Bot Token (`TELEGRAM_BOT_TOKEN`)
1. Open Telegram and start a chat with **[@BotFather](https://t.me/BotFather)**.
2. Send the command `/newbot` and follow the prompts to name your bot and choose a username ending in `bot`.
3. Copy the HTTP API token provided by BotFather (e.g., `1234567890:AAHxyz...`) and set `TELEGRAM_BOT_TOKEN` in `.env`.

### 3. Telegram Subscribers (`/start`) & Channel ID (`TELEGRAM_CHAT_ID`)
- **Automatic Subscriber Broadcast**: Anyone who opens your bot in Telegram and presses **Start (`/start`)** is automatically discovered and receives every 6-hour digest broadcast.
- **Optional Channel**: Add your bot as an Administrator to a channel and set `TELEGRAM_CHAT_ID="@your_channel"` in `.env`.

---

## Step-by-Step Setup & Execution (Python 3.11+)

### 1. Create and Activate a Virtual Environment
```bash
python3 -m venv .venv
source .venv/bin/activate   # On Windows: .venv\Scripts\activate
```

### 2. Install Dependencies
```bash
pip install -r requirements.txt
```

### 3. Configure `.env`
```bash
cp .env.example .env
```
Edit `.env` and fill in your credentials:
```env
GROQ_API_KEY="gsk_..."
GROQ_MODEL="llama-3.3-70b-versatile"
TELEGRAM_BOT_TOKEN="123456789:AAF..."
TELEGRAM_CHAT_ID="@your_channel_or_chat_id"
OUTPUT_LANGUAGE="English"          # Or "Bengali"
SCHEDULE_INTERVAL_HOURS="6"        # Runs every 6 hours
DAILY_RUN_TIME=""                  # Optional fixed time e.g. "08:00"
```

### 4. Run the Pipeline
```bash
python main.py
```
On startup, `main.py` immediately executes a full fetch → Groq LPU synthesis → multi-subscriber Telegram broadcast cycle, logs progress to console and `pipeline.log`, updates `processed_ids.json` and `daily_digests.json`, and continues running every 6 hours.
