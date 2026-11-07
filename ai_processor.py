"""
ai_processor.py
---------------
Processes raw developer stories and articles into structured technical digests
using the official Groq Python SDK (`groq`) and `llama-3.3-70b-versatile`
(with automatic rate-limit failover to `llama-3.1-8b-instant` and a built-in
deterministic engineering synthesizer fallback so 24/7 runs never fail).

Supports configurable OUTPUT_LANGUAGE (English or Bengali) while preserving
technical terminology in English.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any

from groq import Groq
from pydantic import BaseModel, Field

from config import PipelineConfig
from scraper import RawDeveloperItem

logger = logging.getLogger("dev_pulse_pipeline")


class DigestEntrySchema(BaseModel):
    uid: str = Field(description="Exact unique identifier (uid) from the input item.")
    title: str = Field(description="Clean, accurate title of the developer story or article.")
    category_tag: str = Field(
        description="Single bracketed category tag such as [AI/ML], [Web Dev], [System Design], [Open Source], [Cloud/DevOps], [Security], or [Systems]."
    )
    takeaway: str = Field(
        description="Concise, high-signal 2-sentence technical takeaway explaining what this is and why it matters to software engineers."
    )


class DigestBatchResponseSchema(BaseModel):
    editorial_headline: str = Field(
        description="A brief 1-sentence executive summary of today's developer pulse."
    )
    items: list[DigestEntrySchema]


@dataclass
class ProcessedDigestItem:
    """Enriched developer digest item combining raw metadata with Groq LPU synthesis."""

    uid: str
    source: str
    title: str
    category_tag: str
    takeaway: str
    url: str
    discussion_url: str
    author: str
    score: int
    comments_count: int
    published_at: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ProcessedDigestBatch:
    """Complete processed digest batch ready for Telegram delivery and archival."""

    generated_at: str
    output_language: str
    model_used: str
    editorial_headline: str
    items: list[ProcessedDigestItem]

    def to_dict(self) -> dict[str, Any]:
        return {
            "generated_at": self.generated_at,
            "output_language": self.output_language,
            "model_used": self.model_used,
            "editorial_headline": self.editorial_headline,
            "items": [item.to_dict() for item in self.items],
        }


def infer_category_tag(raw: RawDeveloperItem) -> str:
    """Deterministic engineering domain classifier."""
    hay = f"{raw.title} {' '.join(raw.tags)} {raw.excerpt}".lower()
    if re.search(r"\b(ai|llm|gpt|llama|groq|inference|neural|model|agent|rag|ml|deep learning|transformer)\b", hay):
        return "[AI/ML]"
    if re.search(r"\b(security|cve|vulnerability|auth|zero-trust|encryption|exploit|hack|crypto|tls)\b", hay):
        return "[Security]"
    if re.search(r"\b(kubernetes|k8s|docker|cloud|aws|gcp|devops|ci/cd|terraform|serverless|container)\b", hay):
        return "[Cloud/DevOps]"
    if re.search(r"\b(architecture|distributed|database|postgres|sql|redis|kafka|scalability|latency|consensus|system design)\b", hay):
        return "[System Design]"
    if re.search(r"\b(rust|kernel|linux|zig|c\+\+|wasm|compiler|embedded|os|memory|performance)\b", hay):
        return "[Systems]"
    if re.search(r"\b(open source|github|repo|release|mit license|apache|fork|community)\b", hay):
        return "[Open Source]"
    if re.search(r"\b(react|angular|vue|typescript|javascript|css|html|frontend|nextjs|node|web|api)\b", hay):
        return "[Web Dev]"
    return "[System Design]"


def build_deterministic_engineering_digest(
    items: list[RawDeveloperItem],
    config: PipelineConfig,
) -> ProcessedDigestBatch:
    """Zero-downtime fallback synthesizer if GROQ_API_KEY is missing or rate-limited."""
    is_bengali = config.output_language.lower() == "bengali"
    enriched: list[ProcessedDigestItem] = []

    for raw in items:
        tag = infer_category_tag(raw)
        clean_excerpt = re.sub(r"\s+", " ", (raw.excerpt or "").strip()).rstrip(".")
        if is_bengali:
            takeaway = (
                f"{raw.title} বিষয়ক এই {tag} আলোচনায় প্রোডাকশন সফটওয়্যার ইঞ্জিনিয়ারিং এবং সিস্টেম আর্কিটেকচারের গুরুত্বপূর্ণ দিক তুলে ধরা হয়েছে। "
                f"{raw.source}-এ এটি ইতোমধ্যে {raw.score} পয়েন্ট এবং {raw.comments_count}টি ডেভেলপার কমেন্ট অর্জন করেছে।"
            )
        else:
            first_sentence = clean_excerpt or f"Examines practical engineering trade-offs around {raw.title}"
            takeaway = (
                f"{first_sentence}. Currently trending on {raw.source} with {raw.score} developer upvotes "
                f"and {raw.comments_count} technical comments."
            )

        enriched.append(
            ProcessedDigestItem(
                uid=raw.uid,
                source=raw.source,
                title=raw.title,
                category_tag=tag,
                takeaway=takeaway,
                url=raw.url,
                discussion_url=raw.discussion_url,
                author=raw.author,
                score=raw.score,
                comments_count=raw.comments_count,
                published_at=raw.published_at,
            )
        )

    headline = (
        f"Hacker News এবং DEV.to থেকে বাছাইকৃত {len(enriched)}টি শীর্ষ ডেভেলপার স্টোরি এবং ইঞ্জিনিয়ারিং আপডেট।"
        if is_bengali
        else f"Curated 6-hour pulse of {len(enriched)} high-signal engineering stories across Hacker News and DEV.to."
    )

    return ProcessedDigestBatch(
        generated_at=datetime.now(timezone.utc).isoformat(),
        output_language=config.output_language,
        model_used=config.groq_model,
        editorial_headline=headline,
        items=enriched,
    )


def build_system_instruction(output_language: str) -> str:
    """Build language-aware system instructions for Groq JSON-mode synthesis."""
    language_directive = (
        "Write the `editorial_headline` and the 2-sentence `takeaway` in clear, professional English."
        if output_language.lower() == "english"
        else (
            f"Write the `editorial_headline` and the 2-sentence `takeaway` in natural, professional {output_language} "
            "(e.g., Bengali script if Bengali is requested), while strictly keeping core technical terms, "
            "framework names, APIs, architectures, and the `category_tag` in English."
        )
    )

    return (
        "You are a Principal Software Engineer and Technical Editor curating the "
        "'Global Developer Pulse & Trending Tech Digest'.\n"
        "You MUST respond strictly with a valid JSON object matching this exact schema:\n"
        "{\n"
        '  "editorial_headline": "1-sentence executive summary of this batch",\n'
        '  "items": [\n'
        "    {\n"
        '      "uid": "exact uid from input",\n'
        '      "title": "clean title",\n'
        '      "category_tag": "[AI/ML] | [Web Dev] | [System Design] | [Open Source] | [Cloud/DevOps] | [Security] | [Systems]",\n'
        '      "takeaway": "2-sentence technical takeaway"\n'
        "    }\n"
        "  ]\n"
        "}\n\n"
        "Rules for every input story/article from Hacker News and DEV.to:\n"
        "1. Assign a precise bracketed `category_tag` from: [AI/ML], [Web Dev], [System Design], "
        "[Open Source], [Cloud/DevOps], [Security], or [Systems].\n"
        "2. Write a sharp, zero-fluff 2-sentence technical `takeaway` explaining the core engineering "
        "concept and why it matters to practicing developers in production.\n"
        f"3. Language rule: {language_directive}\n"
        "4. Preserve the exact `uid` for each item so it maps back deterministically."
    )


def process_developer_batch_with_groq(
    items: list[RawDeveloperItem],
    config: PipelineConfig,
) -> ProcessedDigestBatch:
    """
    Send the batch of raw developer items to Groq (`llama-3.3-70b-versatile`)
    using the official `groq` SDK with JSON object mode, automatic model fallback,
    and deterministic zero-downtime fallback.
    """
    if not items:
        return ProcessedDigestBatch(
            generated_at=datetime.now(timezone.utc).isoformat(),
            output_language=config.output_language,
            model_used=config.groq_model,
            editorial_headline="No new developer items to process in this cycle.",
            items=[],
        )

    if not config.groq_api_key or config.groq_api_key == "YOUR_GROQ_API_KEY":
        logger.warning(
            "GROQ_API_KEY not configured; using built-in deterministic engineering synthesizer."
        )
        return build_deterministic_engineering_digest(items, config)

    client = Groq(api_key=config.groq_api_key, timeout=config.request_timeout_seconds)
    system_instruction = build_system_instruction(config.output_language)

    prompt_payload = [
        {
            "uid": item.uid,
            "source": item.source,
            "title": item.title,
            "url": item.url,
            "score": item.score,
            "comments_count": item.comments_count,
            "tags": item.tags,
            "excerpt": item.excerpt,
        }
        for item in items
    ]

    user_prompt = (
        f"Analyze the following {len(items)} trending developer stories and articles "
        f"and generate a structured JSON technical digest in {config.output_language}:\n\n"
        f"{json.dumps(prompt_payload, ensure_ascii=False, indent=2)}"
    )

    for attempt in range(1, config.max_retries + 1):
        active_model = config.groq_model if attempt < config.max_retries else config.groq_fallback_model
        try:
            logger.info(
                "Invoking Groq LPU API (%s) for %d items [language=%s, attempt=%d/%d]...",
                active_model,
                len(items),
                config.output_language,
                attempt,
                config.max_retries,
            )
            completion = client.chat.completions.create(
                model=active_model,
                messages=[
                    {"role": "system", "content": system_instruction},
                    {"role": "user", "content": user_prompt},
                ],
                response_format={"type": "json_object"},
                temperature=0.2,
                max_completion_tokens=4096,
            )

            raw_text = (completion.choices[0].message.content or "{}").strip()
            parsed = json.loads(raw_text)
            ai_items_by_uid: dict[str, dict[str, Any]] = {
                str(entry.get("uid")): entry
                for entry in parsed.get("items", [])
                if isinstance(entry, dict)
            }

            enriched_items: list[ProcessedDigestItem] = []
            for raw_item in items:
                ai_entry = ai_items_by_uid.get(raw_item.uid, {})
                cat_tag = str(ai_entry.get("category_tag") or infer_category_tag(raw_item)).strip()
                if not cat_tag.startswith("["):
                    cat_tag = f"[{cat_tag}]"

                takeaway = str(
                    ai_entry.get("takeaway")
                    or f"{raw_item.excerpt} Trending on {raw_item.source} with {raw_item.score} reactions."
                ).strip()

                enriched_items.append(
                    ProcessedDigestItem(
                        uid=raw_item.uid,
                        source=raw_item.source,
                        title=str(ai_entry.get("title") or raw_item.title).strip(),
                        category_tag=cat_tag,
                        takeaway=takeaway,
                        url=raw_item.url,
                        discussion_url=raw_item.discussion_url,
                        author=raw_item.author,
                        score=raw_item.score,
                        comments_count=raw_item.comments_count,
                        published_at=raw_item.published_at,
                    )
                )

            headline = str(
                parsed.get("editorial_headline")
                or f"Top {len(enriched_items)} engineering stories across Hacker News and DEV.to."
            ).strip()

            logger.info(
                "Groq (%s) synthesized %d developer takeaways successfully.",
                active_model,
                len(enriched_items),
            )
            return ProcessedDigestBatch(
                generated_at=datetime.now(timezone.utc).isoformat(),
                output_language=config.output_language,
                model_used=active_model,
                editorial_headline=headline,
                items=enriched_items,
            )

        except Exception as exc:
            wait_time = 2 ** (attempt - 1)
            logger.warning(
                "Groq API call failed on model %s (attempt %d/%d): %s. Retrying in %ds...",
                active_model,
                attempt,
                config.max_retries,
                exc,
                wait_time,
            )
            if attempt < config.max_retries:
                time.sleep(wait_time)

    logger.warning(
        "All Groq LPU attempts failed; using deterministic engineering synthesizer so 6h delivery continues."
    )
    return build_deterministic_engineering_digest(items, config)
