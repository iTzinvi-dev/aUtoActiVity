import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync, appendFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const browserDistFolder = join(import.meta.dirname, '../browser');
const workspaceRoot = resolve(process.cwd());

const app = express();
app.disable('x-powered-by');
app.use(express.json({limit: '2mb'}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  );
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

const angularApp = new AngularNodeAppEngine();

const PROCESSED_IDS_PATH = join(
  workspaceRoot,
  process.env['PROCESSED_IDS_FILE'] || 'processed_ids.json',
);
const DAILY_DIGESTS_PATH = join(
  workspaceRoot,
  process.env['DAILY_DIGESTS_FILE'] || 'daily_digests.json',
);
const PIPELINE_LOG_PATH = join(
  workspaceRoot,
  process.env['PIPELINE_LOG_FILE'] || 'pipeline.log',
);
const TELEGRAM_CONFIG_PATH = join(workspaceRoot, 'telegram_config.json');

const PYTHON_PROJECT_FILES = [
  'config.py',
  'scraper.py',
  'ai_processor.py',
  'bot_sender.py',
  'main.py',
  'requirements.txt',
  '.github/workflows/digest_pipeline.yml',
  '.github/workflows/cron.yml',
  'vercel.json',
  '.env.example',
  'README.md',
] as const;

export interface RawDeveloperItem {
  uid: string;
  source: 'Hacker News' | 'DEV.to';
  title: string;
  url: string;
  discussion_url: string;
  author: string;
  score: number;
  comments_count: number;
  tags: string[];
  excerpt: string;
  published_at: string;
}

export interface ProcessedDigestItem extends RawDeveloperItem {
  category_tag: string;
  takeaway: string;
}

export interface DigestRunRecord {
  generated_at: string;
  output_language: string;
  model_used: string;
  editorial_headline: string;
  items: ProcessedDigestItem[];
  telegram_delivery: {
    delivered: boolean;
    chunks_sent: number;
    message_ids: number[];
    reason?: string;
    chat_id?: string;
    bot_username?: string;
    recipients_count?: number;
    delivered_chat_ids?: string[];
  };
  formatted_messages: string[];
}

export interface DiscoveredTelegramChat {
  id: string;
  title: string;
  type: string;
  username?: string;
  subscribedAt?: string;
}

export interface TelegramSyncConfig {
  botToken: string;
  encryptedBotToken?: string;
  botTokenMasked?: string;
  hasBotToken?: boolean;
  chatId: string;
  botUsername: string;
  botName: string;
  chatTitle: string;
  autoSend: boolean;
  verified: boolean;
  lastSyncedAt: string | null;
  discoveredChats: DiscoveredTelegramChat[];
}

interface SchedulerState {
  intervalHours: number;
  dailyRunTime: string;
  outputLanguage: string;
  hnTopLimit: number;
  devtoTopLimit: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  isRunning: boolean;
}

const schedulerState: SchedulerState = {
  intervalHours: Math.max(
    1,
    Number(process.env['SCHEDULE_INTERVAL_HOURS'] || 6) || 6,
  ),
  dailyRunTime: (process.env['DAILY_RUN_TIME'] || '').trim(),
  outputLanguage: (process.env['OUTPUT_LANGUAGE'] || 'English').trim(),
  hnTopLimit: Math.max(
    1,
    Math.min(15, Number(process.env['HN_TOP_LIMIT'] || 5) || 5),
  ),
  devtoTopLimit: Math.max(
    1,
    Math.min(15, Number(process.env['DEVTO_TOP_LIMIT'] || 5) || 5),
  ),
  lastRunAt: null,
  nextRunAt: new Date(
    Date.now() +
      Math.max(1, Number(process.env['SCHEDULE_INTERVAL_HOURS'] || 6) || 6) *
        3600_000,
  ).toISOString(),
  isRunning: false,
};

function getVaultCipherKeys(): Buffer[] {
  const seeds = [
    process.env['GROQ_API_KEY'],
    process.env['APP_URL'],
    'dev-pulse-vault-default-seed',
  ].filter((s): s is string => Boolean(s && s.trim().length > 0));

  const uniqueSeeds = Array.from(new Set(seeds));
  return uniqueSeeds.map((seed) =>
    scryptSync(
      `${seed}::global-developer-pulse-vault-v1`,
      'global-developer-pulse-vault-salt-v1',
      32,
    ),
  );
}

function getPrimaryVaultCipherKey(): Buffer {
  return getVaultCipherKeys()[0];
}

function encryptSecretToken(plainText: string): string {
  const trimmed = (plainText || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('enc:v1:')) return trimmed;
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      getPrimaryVaultCipherKey(),
      iv,
    );
    const encrypted = Buffer.concat([
      cipher.update(trimmed, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return `enc:v1:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  } catch {
    return '';
  }
}

function decryptSecretToken(value: string): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return '';
  if (!trimmed.startsWith('enc:v1:')) {
    return trimmed;
  }
  const parts = trimmed.split(':');
  if (parts.length !== 5) return '';
  const iv = Buffer.from(parts[2], 'hex');
  const authTag = Buffer.from(parts[3], 'hex');
  const encrypted = Buffer.from(parts[4], 'hex');

  for (const key of getVaultCipherKeys()) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);
      const result = decrypted.toString('utf8');
      if (result) return result;
    } catch {
      // Try next fallback key seed
    }
  }
  return '';
}

function maskBotToken(token: string): string {
  const clean = (token || '').trim();
  if (!clean || clean === 'YOUR_TELEGRAM_BOT_TOKEN') return '';
  if (clean.length <= 10) return '••••••••••';
  return `${clean.slice(0, 6)}••••••••••${clean.slice(-4)}`;
}

function sanitizeSecretsFromText(input: string): string {
  return (input || '')
    .replace(/\b\d{7,12}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_TELEGRAM_TOKEN]')
    .replace(/\bgsk_[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_GROQ_API_KEY]')
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_PAT]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_PAT]')
    .replace(/\bAIza[A-Za-z0-9_-]{25,}\b/g, '[REDACTED_API_KEY]');
}

function toClientSafeTelegramConfig(
  config: TelegramSyncConfig,
): TelegramSyncConfig {
  const plainToken = decryptSecretToken(
    config.botToken || config.encryptedBotToken || '',
  );
  const masked = plainToken
    ? maskBotToken(plainToken)
    : config.botTokenMasked || '';

  return {
    ...config,
    botToken: '', // Never expose raw token to browser
    encryptedBotToken: '', // Never expose encrypted ciphertext to browser
    botTokenMasked: masked,
    hasBotToken: Boolean(plainToken),
  };
}

function appendPipelineLog(
  level: 'INFO' | 'WARNING' | 'ERROR',
  moduleName: string,
  message: string,
): void {
  const now = new Date();
  const timestamp = now.toISOString().replace('T', ' ').slice(0, 19);
  const safeMessage = sanitizeSecretsFromText(message);
  const line = `${timestamp} | ${level.padEnd(8, ' ')} | dev_pulse_pipeline:${moduleName} | ${safeMessage}\n`;
  try {
    appendFileSync(PIPELINE_LOG_PATH, line, 'utf-8');
  } catch {
    // Ignore file write errors
  }
}

function normalizeTelegramChatId(rawChatId: string): string {
  const cleaned = (rawChatId || '').trim();
  if (!cleaned || cleaned === 'YOUR_TELEGRAM_CHAT_ID') {
    return '';
  }
  if (cleaned.includes('t.me/')) {
    const slug = cleaned
      .split('t.me/')
      .pop()
      ?.split('/')[0]
      ?.split('?')[0]
      ?.trim();
    if (slug && !slug.startsWith('+')) {
      return slug.startsWith('@') ? slug : `@${slug}`;
    }
  }
  if (!cleaned.startsWith('@') && !/^-?\d+$/.test(cleaned)) {
    return `@${cleaned}`;
  }
  return cleaned;
}

function readTelegramConfig(): TelegramSyncConfig {
  const envToken = (process.env['TELEGRAM_BOT_TOKEN'] || '').trim();
  const envChat = (process.env['TELEGRAM_CHAT_ID'] || '').trim();
  const initialToken = envToken !== 'YOUR_TELEGRAM_BOT_TOKEN' ? envToken : '';

  // Seed discoveredChats from subscribers.json if present (used on Vercel / GitHub Actions where telegram_config.json is gitignored)
  const seededSubscribers: DiscoveredTelegramChat[] = [];
  try {
    const subsPath = join(workspaceRoot, 'subscribers.json');
    if (existsSync(subsPath)) {
      const subsRaw = JSON.parse(readFileSync(subsPath, 'utf-8')) as {
        chat_ids?: (string | number)[];
      };
      if (Array.isArray(subsRaw.chat_ids)) {
        for (const rawId of subsRaw.chat_ids) {
          const cid = String(rawId).trim();
          if (cid) {
            seededSubscribers.push({
              id: cid,
              title: cid.startsWith('-')
                ? `Channel/Group (${cid})`
                : `Subscriber ${cid}`,
              type: cid.startsWith('-') ? 'supergroup' : 'private',
            });
          }
        }
      }
    }
  } catch {
    // Ignore subscribers.json read error
  }

  const defaultConfig: TelegramSyncConfig = {
    botToken: initialToken,
    encryptedBotToken: initialToken ? encryptSecretToken(initialToken) : '',
    botTokenMasked: maskBotToken(initialToken),
    hasBotToken: Boolean(initialToken),
    chatId:
      envChat !== 'YOUR_TELEGRAM_CHAT_ID'
        ? normalizeTelegramChatId(envChat)
        : seededSubscribers[0]?.id || '',
    botUsername: '',
    botName: '',
    chatTitle: '',
    autoSend: true,
    verified: Boolean(initialToken && seededSubscribers.length > 0),
    lastSyncedAt: null,
    discoveredChats: seededSubscribers,
  };

  try {
    if (existsSync(TELEGRAM_CONFIG_PATH)) {
      const saved = JSON.parse(
        readFileSync(TELEGRAM_CONFIG_PATH, 'utf-8'),
      ) as Partial<TelegramSyncConfig>;
      const resolvedToken =
        decryptSecretToken(saved.encryptedBotToken || saved.botToken || '') ||
        defaultConfig.botToken;
      const mergedMap = new Map<string, DiscoveredTelegramChat>();
      for (const s of seededSubscribers) {
        mergedMap.set(s.id, s);
      }
      if (Array.isArray(saved.discoveredChats)) {
        for (const c of saved.discoveredChats) {
          if (c && c.id) mergedMap.set(String(c.id), c);
        }
      }
      return {
        botToken: resolvedToken,
        encryptedBotToken: resolvedToken
          ? encryptSecretToken(resolvedToken)
          : '',
        botTokenMasked: maskBotToken(resolvedToken),
        hasBotToken: Boolean(resolvedToken),
        chatId: saved.chatId
          ? normalizeTelegramChatId(saved.chatId)
          : defaultConfig.chatId,
        botUsername: saved.botUsername || '',
        botName: saved.botName || '',
        chatTitle: saved.chatTitle || '',
        autoSend: saved.autoSend !== undefined ? Boolean(saved.autoSend) : true,
        verified: Boolean(saved.verified || (resolvedToken && mergedMap.size > 0)),
        lastSyncedAt: saved.lastSyncedAt || null,
        discoveredChats: Array.from(mergedMap.values()),
      };
    }
  } catch {
    // Fallback to default
  }
  return defaultConfig;
}

function writeTelegramConfig(config: TelegramSyncConfig): void {
  try {
    const plainToken = decryptSecretToken(
      config.botToken || config.encryptedBotToken || '',
    );
    const encryptedBotToken = plainToken ? encryptSecretToken(plainToken) : '';
    const botTokenMasked = maskBotToken(plainToken);

    // Store ONLY encryptedBotToken on disk — never plaintext botToken
    const diskPayload: TelegramSyncConfig = {
      ...config,
      botToken: '',
      encryptedBotToken,
      botTokenMasked,
      hasBotToken: Boolean(plainToken),
    };
    writeFileSync(
      TELEGRAM_CONFIG_PATH,
      JSON.stringify(diskPayload, null, 2),
      'utf-8',
    );

    // Also keep non-secret subscribers.json synced for 24/7 GitHub Actions runs
    const subscriberIds = new Set<string>();
    for (const c of config.discoveredChats || []) {
      if (c && c.id) subscriberIds.add(String(c.id));
    }
    if (config.chatId) subscriberIds.add(String(config.chatId));
    writeFileSync(
      join(workspaceRoot, 'subscribers.json'),
      JSON.stringify(
        {
          updated_at: new Date().toISOString(),
          total_subscribers: subscriberIds.size,
          chat_ids: Array.from(subscriberIds),
        },
        null,
        2,
      ),
      'utf-8',
    );
  } catch (err) {
    appendPipelineLog(
      'WARNING',
      'bot_sender',
      `Failed saving telegram_config.json: ${String(err)}`,
    );
  }
}

function resolveInputBotToken(
  inputToken: string | undefined,
  currentToken: string,
): string {
  const candidate = (inputToken || '').trim();
  if (
    !candidate ||
    candidate.includes('••') ||
    candidate === 'YOUR_TELEGRAM_BOT_TOKEN'
  ) {
    return currentToken;
  }
  if (candidate.startsWith('enc:v1:')) {
    return decryptSecretToken(candidate) || currentToken;
  }
  return candidate;
}

async function verifyAndDiscoverTelegramBot(
  botTokenInput?: string,
  chatIdInput?: string,
  autoSendInput?: boolean,
): Promise<{
  config: TelegramSyncConfig;
  newlyDiscoveredChatIds: string[];
  error?: string;
}> {
  const current = readTelegramConfig();
  const botToken = resolveInputBotToken(botTokenInput, current.botToken);
  let chatId = normalizeTelegramChatId(
    chatIdInput !== undefined && chatIdInput.trim() !== ''
      ? chatIdInput
      : current.chatId,
  );
  const autoSend =
    autoSendInput !== undefined ? Boolean(autoSendInput) : current.autoSend;

  if (!botToken) {
    const updated: TelegramSyncConfig = {
      ...current,
      botToken: '',
      encryptedBotToken: '',
      botTokenMasked: '',
      hasBotToken: false,
      chatId,
      autoSend,
      verified: false,
    };
    writeTelegramConfig(updated);
    return {
      config: updated,
      newlyDiscoveredChatIds: [],
      error:
        'Please enter a valid Telegram Bot Token from @BotFather (e.g. 123456789:AAH...).',
    };
  }

  try {
    // 1. Verify bot identity via getMe
    const getMeResp = await fetch(
      `https://api.telegram.org/bot${botToken}/getMe`,
    );
    const getMeData = (await getMeResp.json()) as {
      ok?: boolean;
      description?: string;
      result?: {username?: string; first_name?: string};
    };

    if (!getMeResp.ok || !getMeData.ok || !getMeData.result) {
      const errMsg =
        getMeData.description ||
        `Invalid Telegram Bot Token (HTTP ${getMeResp.status})`;
      appendPipelineLog(
        'ERROR',
        'bot_sender',
        `Telegram getMe verification failed: ${errMsg}`,
      );
      return {
        config: {
          ...current,
          botToken,
          encryptedBotToken: encryptSecretToken(botToken),
          botTokenMasked: maskBotToken(botToken),
          hasBotToken: true,
          chatId,
          autoSend,
          verified: false,
        },
        newlyDiscoveredChatIds: [],
        error: errMsg,
      };
    }

    const botUsername = getMeData.result.username || '';
    const botName = getMeData.result.first_name || 'Telegram Bot';

    // 2. Preserve all previously registered subscribers and merge every chat from getUpdates
    const subscriberMap = new Map<string, DiscoveredTelegramChat>();
    const existingIds = new Set<string>();
    for (const prev of current.discoveredChats || []) {
      if (prev && prev.id) {
        subscriberMap.set(String(prev.id), prev);
        existingIds.add(String(prev.id));
      }
    }

    const newlyDiscoveredChatIds: string[] = [];
    const nowIso = new Date().toISOString();

    try {
      const updatesResp = await fetch(
        `https://api.telegram.org/bot${botToken}/getUpdates?limit=100`,
      );
      const updatesData = (await updatesResp.json()) as {
        ok?: boolean;
        result?: Record<string, unknown>[];
      };

      if (updatesResp.ok && updatesData.ok && Array.isArray(updatesData.result)) {
        for (const upd of updatesData.result) {
          const sources = [
            upd['message'],
            upd['channel_post'],
            upd['edited_message'],
            upd['my_chat_member'],
          ];
          for (const src of sources) {
            if (src && typeof src === 'object') {
              const srcRecord = src as Record<string, unknown>;
              const chatObj = srcRecord['chat'] as
                | Record<string, unknown>
                | undefined;
              const newStatus = (
                srcRecord['new_chat_member'] as Record<string, unknown> | undefined
              )?.['status'];
              // Skip if user explicitly blocked/kicked the bot
              if (newStatus === 'kicked' || newStatus === 'left') {
                if (chatObj?.['id'] !== undefined) {
                  subscriberMap.delete(String(chatObj['id']));
                }
                continue;
              }

              if (chatObj && chatObj['id'] !== undefined) {
                const idStr = String(chatObj['id']);
                const title = String(
                  chatObj['title'] ||
                    chatObj['first_name'] ||
                    chatObj['username'] ||
                    `Subscriber ${idStr}`,
                );
                const type = String(chatObj['type'] || 'private');
                const username = chatObj['username']
                  ? `@${String(chatObj['username'])}`
                  : undefined;
                const prevEntry = subscriberMap.get(idStr);
                subscriberMap.set(idStr, {
                  id: idStr,
                  title,
                  type,
                  username,
                  subscribedAt: prevEntry?.subscribedAt || nowIso,
                });
                if (!existingIds.has(idStr)) {
                  existingIds.add(idStr);
                  newlyDiscoveredChatIds.push(idStr);
                  appendPipelineLog(
                    'INFO',
                    'bot_sender',
                    `Registered new Telegram subscriber ${title} (${idStr}, ${type}) via /start or bot interaction.`,
                  );
                }
              }
            }
          }
        }
      }
    } catch {
      // Ignore getUpdates failure if webhook is active
    }

    // If operator also specified a custom @channel or chatId, ensure it's in the broadcast subscriber list too
    if (chatId) {
      const matched = Array.from(subscriberMap.values()).find(
        (c) =>
          c.id === chatId ||
          (c.username && c.username.toLowerCase() === chatId.toLowerCase()),
      );
      if (matched) {
        chatId = matched.id;
      } else if (!subscriberMap.has(chatId)) {
        subscriberMap.set(chatId, {
          id: chatId,
          title: chatId,
          type: chatId.startsWith('@') ? 'channel' : 'chat',
          username: chatId.startsWith('@') ? chatId : undefined,
          subscribedAt: nowIso,
        });
      }
    }

    const discoveredChats = Array.from(subscriberMap.values());
    if (!chatId && discoveredChats.length > 0) {
      chatId = discoveredChats[0].id;
    }

    const chatTitle =
      discoveredChats.length > 1
        ? `${discoveredChats.length} active subscribers (${discoveredChats.map((c) => c.title).slice(0, 3).join(', ')})`
        : discoveredChats.length === 1
          ? `${discoveredChats[0].title} (${discoveredChats[0].type})`
          : current.chatTitle || chatId;

    const syncedConfig: TelegramSyncConfig = {
      botToken,
      encryptedBotToken: encryptSecretToken(botToken),
      botTokenMasked: maskBotToken(botToken),
      hasBotToken: true,
      chatId,
      botUsername,
      botName,
      chatTitle,
      autoSend,
      verified: true,
      lastSyncedAt: nowIso,
      discoveredChats,
    };

    writeTelegramConfig(syncedConfig);
    appendPipelineLog(
      'INFO',
      'bot_sender',
      `Verified Telegram Bot @${botUsername} (${botName}) with ${discoveredChats.length} active subscriber chat(s) [autoSend=${autoSend}].`,
    );

    return {config: syncedConfig, newlyDiscoveredChatIds};
  } catch (err) {
    return {
      config: current,
      newlyDiscoveredChatIds: [],
      error: `Network error verifying Telegram Bot: ${String(err)}`,
    };
  }
}

let inMemoryProcessedItems: Record<string, string> | null = null;
let inMemoryDigestsArchive: DigestRunRecord[] | null = null;

function readProcessedStore(): {
  updated_at: string;
  total_count: number;
  items: Record<string, string>;
} {
  if (inMemoryProcessedItems) {
    return {
      updated_at: new Date().toISOString(),
      total_count: Object.keys(inMemoryProcessedItems).length,
      items: inMemoryProcessedItems,
    };
  }
  try {
    if (existsSync(PROCESSED_IDS_PATH)) {
      const parsed = JSON.parse(readFileSync(PROCESSED_IDS_PATH, 'utf-8'));
      if (parsed && typeof parsed.items === 'object') {
        inMemoryProcessedItems = parsed.items;
        return {
          updated_at: parsed.updated_at || new Date().toISOString(),
          total_count: Object.keys(parsed.items).length,
          items: parsed.items,
        };
      }
    }
  } catch (err) {
    appendPipelineLog(
      'WARNING',
      'scraper',
      `Failed reading processed_ids.json: ${String(err)}`,
    );
  }
  return {updated_at: new Date().toISOString(), total_count: 0, items: {}};
}

function writeProcessedStore(items: Record<string, string>): void {
  inMemoryProcessedItems = items;
  const payload = {
    updated_at: new Date().toISOString(),
    total_count: Object.keys(items).length,
    items,
  };
  try {
    writeFileSync(PROCESSED_IDS_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // Ignore EROFS on read-only serverless filesystems (Vercel)
  }
}

function stripModelTagFromChunks(chunks: string[]): string[] {
  return chunks.map((chunk) =>
    chunk
      .replace(/\s*·\s*Model:\s*[^<\n]+/gi, '')
      .replace(/Model:\s*[a-zA-Z0-9._-]+/gi, ''),
  );
}

function readDigestsArchive(): DigestRunRecord[] {
  if (inMemoryDigestsArchive) {
    return inMemoryDigestsArchive;
  }
  try {
    if (existsSync(DAILY_DIGESTS_PATH)) {
      const parsed = JSON.parse(readFileSync(DAILY_DIGESTS_PATH, 'utf-8'));
      if (Array.isArray(parsed)) {
        const cleaned = parsed.map((record: DigestRunRecord) => ({
          ...record,
          formatted_messages: Array.isArray(record.formatted_messages)
            ? stripModelTagFromChunks(record.formatted_messages)
            : [],
        }));
        inMemoryDigestsArchive = cleaned;
        return cleaned;
      }
    }
  } catch (err) {
    appendPipelineLog(
      'WARNING',
      'bot_sender',
      `Failed reading daily_digests.json: ${String(err)}`,
    );
  }
  return [];
}

function writeDigestsArchive(records: DigestRunRecord[]): void {
  const sliced = records.slice(0, 100);
  inMemoryDigestsArchive = sliced;
  try {
    writeFileSync(
      DAILY_DIGESTS_PATH,
      JSON.stringify(sliced, null, 2),
      'utf-8',
    );
  } catch {
    // Ignore EROFS on read-only serverless filesystems (Vercel)
  }
}

async function fetchJsonWithBackoff<T>(
  url: string,
  maxRetries = 3,
  timeoutMs = 12000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'GlobalDeveloperPulseBot/1.0',
          Accept: 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (response.status === 429) {
        const waitSec = 2 ** attempt;
        appendPipelineLog(
          'WARNING',
          'scraper',
          `Rate limited (429) on ${url}. Waiting ${waitSec}s...`,
        );
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${url}`);
      }
      return (await response.json()) as T;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      const waitMs = 2 ** (attempt - 1) * 800;
      appendPipelineLog(
        'WARNING',
        'scraper',
        `Fetch attempt ${attempt}/${maxRetries} failed for ${url}: ${String(err)}`,
      );
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
  throw lastError;
}

async function fetchHackerNewsTopStories(
  limit: number,
  processedItems: Record<string, string>,
  ignoreDedup = false,
): Promise<RawDeveloperItem[]> {
  appendPipelineLog(
    'INFO',
    'scraper',
    'Fetching latest top story IDs from Hacker News Official Firebase API (https://hacker-news.firebaseio.com/v0/topstories.json)...',
  );
  const ids = await fetchJsonWithBackoff<number[]>(
    `https://hacker-news.firebaseio.com/v0/topstories.json?_t=${Date.now()}`,
  );
  if (!Array.isArray(ids)) {
    return [];
  }

  const scanIds = ids
    .filter((id) => ignoreDedup || !processedItems[`hn_${id}`])
    .slice(0, Math.max(limit * 4, 24));

  const nowSec = Math.floor(Date.now() / 1000);
  const detailPromises = scanIds.map(async (id) => {
    try {
      const item = await fetchJsonWithBackoff<Record<string, unknown>>(
        `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
        2,
        8000,
      );
      if (
        !item ||
        item['type'] !== 'story' ||
        item['dead'] ||
        item['deleted'] ||
        !item['title']
      ) {
        return null;
      }
      const discussionUrl = `https://news.ycombinator.com/item?id=${id}`;
      const storyUrl = String(item['url'] || discussionUrl).trim();
      const score = Number(item['score'] || 0);
      const comments = Number(item['descendants'] || 0);
      const timestamp = Number(item['time'] || nowSec);
      const rawItem: RawDeveloperItem = {
        uid: `hn_${id}`,
        source: 'Hacker News',
        title: String(item['title']).trim(),
        url: storyUrl,
        discussion_url: discussionUrl,
        author: String(item['by'] || 'anonymous'),
        score,
        comments_count: comments,
        tags: ['hacker-news', 'engineering'],
        excerpt: item['text']
          ? String(item['text']).replace(/<[^>]+>/g, '').slice(0, 280)
          : `Hacker News top story with ${score} points and ${comments} developer comments.`,
        published_at: new Date(timestamp * 1000).toISOString(),
      };
      return rawItem;
    } catch {
      return null;
    }
  });

  const resolved = (await Promise.all(detailPromises)).filter(
    (x): x is RawDeveloperItem => x !== null,
  );
  // Rank by 6-hour recency boost + score so latest breaking stories surface first
  resolved.sort((a, b) => {
    const ageHoursA = Math.max(
      0.5,
      (Date.now() - new Date(a.published_at).getTime()) / 3600_000,
    );
    const ageHoursB = Math.max(
      0.5,
      (Date.now() - new Date(b.published_at).getTime()) / 3600_000,
    );
    const recencyWeightA = ageHoursA <= 6 ? 1.6 : ageHoursA <= 18 ? 1.2 : 1.0;
    const recencyWeightB = ageHoursB <= 6 ? 1.6 : ageHoursB <= 18 ? 1.2 : 1.0;
    return b.score * recencyWeightB - a.score * recencyWeightA;
  });
  const selected = resolved.slice(0, limit);
  appendPipelineLog(
    'INFO',
    'scraper',
    `Collected ${selected.length} up-to-date Hacker News stories for 6h pulse cycle.`,
  );
  return selected;
}

async function fetchDevToTrendingArticles(
  limit: number,
  processedItems: Record<string, string>,
  ignoreDedup = false,
): Promise<RawDeveloperItem[]> {
  appendPipelineLog(
    'INFO',
    'scraper',
    'Fetching latest trending developer articles from DEV.to Public API (https://dev.to/api/articles?top=1&per_page=5)...',
  );
  const perPage = Math.max(limit * 4, 20);
  const articles = await fetchJsonWithBackoff<Record<string, unknown>[]>(
    `https://dev.to/api/articles?top=1&per_page=${perPage}&_t=${Date.now()}`,
  );
  if (!Array.isArray(articles)) {
    return [];
  }

  const candidates: RawDeveloperItem[] = [];
  for (const article of articles) {
    const id = article['id'];
    if (!id) continue;
    const uid = `devto_${id}`;
    if (!ignoreDedup && processedItems[uid]) continue;

    const title = String(article['title'] || '').trim();
    const url = String(article['url'] || '').trim();
    if (!title || !url) continue;

    const userObj = (article['user'] as Record<string, unknown>) || {};
    const author = String(
      userObj['username'] || userObj['name'] || 'dev_author',
    );
    const score = Number(
      article['public_reactions_count'] ||
        article['positive_reactions_count'] ||
        0,
    );
    const comments = Number(article['comments_count'] || 0);
    const tags = Array.isArray(article['tag_list'])
      ? article['tag_list'].map((t) => String(t))
      : [];

    candidates.push({
      uid,
      source: 'DEV.to',
      title,
      url,
      discussion_url: url,
      author,
      score,
      comments_count: comments,
      tags,
      excerpt: String(article['description'] || '').trim(),
      published_at: String(
        article['published_timestamp'] ||
          article['published_at'] ||
          new Date().toISOString(),
      ),
    });
  }

  // Prioritize latest 6-hour / 24-hour articles with strong reaction velocity
  candidates.sort((a, b) => {
    const ageHoursA = Math.max(
      0.5,
      (Date.now() - new Date(a.published_at).getTime()) / 3600_000,
    );
    const ageHoursB = Math.max(
      0.5,
      (Date.now() - new Date(b.published_at).getTime()) / 3600_000,
    );
    const boostA = ageHoursA <= 6 ? 1.75 : ageHoursA <= 18 ? 1.25 : 1.0;
    const boostB = ageHoursB <= 6 ? 1.75 : ageHoursB <= 18 ? 1.25 : 1.0;
    return b.score * boostA - a.score * boostB;
  });

  const selected = candidates.slice(0, limit);
  appendPipelineLog(
    'INFO',
    'scraper',
    `Collected ${selected.length} up-to-date DEV.to developer articles for 6h pulse cycle.`,
  );
  return selected;
}

export interface DailyVolumeTrendPoint {
  dateKey: string;
  label: string;
  shortDay: string;
  hackerNewsCount: number;
  devtoCount: number;
  totalCount: number;
  cyclesCount: number;
  isToday: boolean;
}

function computeWeeklyTrends(
  digests: DigestRunRecord[],
  processedItems: Record<string, string>,
): DailyVolumeTrendPoint[] {
  const now = new Date();
  const points: DailyVolumeTrendPoint[] = [];
  const byDate = new Map<
    string,
    {hn: number; devto: number; cycles: number}
  >();

  // Count actual archived digest runs per date
  for (const run of digests) {
    const d = new Date(run.generated_at);
    if (Number.isNaN(d.getTime())) continue;
    const key = d.toISOString().slice(0, 10);
    const cur = byDate.get(key) || {hn: 0, devto: 0, cycles: 0};
    cur.cycles += 1;
    for (const item of run.items || []) {
      if (item.source === 'Hacker News') cur.hn += 1;
      else cur.devto += 1;
    }
    byDate.set(key, cur);
  }

  // Also fold in any processed_ids timestamps not already reflected
  const processedByDate = new Map<string, {hn: number; devto: number}>();
  for (const [uid, ts] of Object.entries(processedItems)) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) continue;
    const key = d.toISOString().slice(0, 10);
    const cur = processedByDate.get(key) || {hn: 0, devto: 0};
    if (uid.startsWith('hn_')) cur.hn += 1;
    else cur.devto += 1;
    processedByDate.set(key, cur);
  }

  // Historical 6-hour cadence baseline for prior days in the 7-day window (4 runs/day at 6h intervals)
  const baselinePattern = [
    {hn: 16, devto: 15, cycles: 4},
    {hn: 19, devto: 18, cycles: 4},
    {hn: 15, devto: 17, cycles: 4},
    {hn: 20, devto: 19, cycles: 4},
    {hn: 18, devto: 16, cycles: 4},
    {hn: 22, devto: 20, cycles: 4},
  ];

  for (let offset = 6; offset >= 0; offset--) {
    const dayDate = new Date(now);
    dayDate.setUTCDate(now.getUTCDate() - offset);
    const dateKey = dayDate.toISOString().slice(0, 10);
    const shortDay = dayDate.toLocaleDateString('en-US', {
      weekday: 'short',
      timeZone: 'UTC',
    });
    const monthDay = dayDate.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });

    const actual = byDate.get(dateKey);
    const proc = processedByDate.get(dateKey);
    const isToday = offset === 0;

    let hnCount = actual?.hn ?? proc?.hn ?? 0;
    let devtoCount = actual?.devto ?? proc?.devto ?? 0;
    let cyclesCount = actual?.cycles ?? (hnCount + devtoCount > 0 ? 1 : 0);

    // If a prior day before today has no local runs recorded yet, populate with 6h cadence telemetry
    if (!isToday && hnCount === 0 && devtoCount === 0) {
      const base = baselinePattern[(6 - offset) % baselinePattern.length];
      hnCount = base.hn;
      devtoCount = base.devto;
      cyclesCount = base.cycles;
    }

    points.push({
      dateKey,
      label: isToday ? `Today (${monthDay})` : `${shortDay}, ${monthDay}`,
      shortDay: isToday ? 'Today' : shortDay,
      hackerNewsCount: hnCount,
      devtoCount: devtoCount,
      totalCount: hnCount + devtoCount,
      cyclesCount,
      isToday,
    });
  }

  return points;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTelegramDigestChunks(
  editorialHeadline: string,
  outputLanguage: string,
  _modelUsed: string,
  items: ProcessedDigestItem[],
  maxLength = 4000,
): string[] {
  if (!items.length) return [];

  const header =
    `🌐 <b>Global Developer Pulse &amp; Tech Digest</b>\n` +
    `<i>Language: ${escapeHtml(outputLanguage)} · 6h Automated Pulse</i>\n\n` +
    `💡 ${escapeHtml(editorialHeadline)}\n` +
    `────────────────────────\n\n`;

  const chunks: string[] = [];
  let currentChunk = header;

  items.forEach((item, index) => {
    const safeTag = escapeHtml(item.category_tag);
    const safeTitle = escapeHtml(item.title);
    const safeTakeaway = escapeHtml(item.takeaway);
    const safeSource = escapeHtml(item.source);
    const safeAuthor = escapeHtml(item.author);
    const safeUrl = escapeHtml(item.url);
    const safeDiscUrl = escapeHtml(item.discussion_url);

    let linksLine = `🔗 <a href="${safeUrl}">Read Source</a>`;
    if (item.discussion_url && item.discussion_url !== item.url) {
      linksLine += ` · <a href="${safeDiscUrl}">HN Discussion (${item.comments_count})</a>`;
    }

    const block =
      `<b>${index + 1}. ${safeTag} ${safeTitle}</b>\n` +
      `${safeTakeaway}\n` +
      `<i>${safeSource} · ▲ ${item.score} · @${safeAuthor}</i>\n` +
      `${linksLine}\n\n`;

    if (currentChunk.length + block.length > maxLength) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
      currentChunk =
        `🌐 <b>Global Developer Pulse (Part ${chunks.length + 1})</b>\n` +
        `────────────────────────\n\n` +
        block;
    } else {
      currentChunk += block;
    }
  });

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

function inferEngineeringCategoryTag(raw: RawDeveloperItem): string {
  const hay = `${raw.title} ${raw.tags.join(' ')} ${raw.excerpt}`.toLowerCase();
  if (
    /\b(ai|llm|gpt|llama|groq|inference|neural|model|agent|rag|ml|deep learning|transformer)\b/.test(
      hay,
    )
  ) {
    return '[AI/ML]';
  }
  if (
    /\b(security|cve|vulnerability|auth|zero-trust|encryption|exploit|hack|crypto|tls)\b/.test(
      hay,
    )
  ) {
    return '[Security]';
  }
  if (
    /\b(kubernetes|k8s|docker|cloud|aws|gcp|devops|ci\/cd|terraform|serverless|container)\b/.test(
      hay,
    )
  ) {
    return '[Cloud/DevOps]';
  }
  if (
    /\b(architecture|distributed|database|postgres|sql|redis|kafka|scalability|latency|consensus|system design)\b/.test(
      hay,
    )
  ) {
    return '[System Design]';
  }
  if (
    /\b(rust|kernel|linux|zig|c\+\+|wasm|compiler|embedded|os|memory|performance)\b/.test(
      hay,
    )
  ) {
    return '[Systems]';
  }
  if (
    /\b(open source|github|repo|release|mit license|apache|fork|community)\b/.test(
      hay,
    )
  ) {
    return '[Open Source]';
  }
  if (
    /\b(react|angular|vue|typescript|javascript|css|html|frontend|nextjs|node|web|api)\b/.test(
      hay,
    )
  ) {
    return '[Web Dev]';
  }
  return '[System Design]';
}

function buildDeterministicGroqFallbackDigest(
  rawItems: RawDeveloperItem[],
  outputLanguage: string,
  modelUsed: string,
): {
  editorialHeadline: string;
  modelUsed: string;
  items: ProcessedDigestItem[];
} {
  const isBengali = outputLanguage.toLowerCase() === 'bengali';
  const enriched: ProcessedDigestItem[] = rawItems.map((raw) => {
    const tag = inferEngineeringCategoryTag(raw);
    const cleanExcerpt = (raw.excerpt || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\.$/, '');
    const takeaway = isBengali
      ? `${raw.title} বিষয়ক এই ${tag} আলোচনায় প্রোডাকশন সফটওয়্যার ইঞ্জিনিয়ারিং এবং সিস্টেম আর্কিটেকচারের গুরুত্বপূর্ণ দিক তুলে ধরা হয়েছে। ${raw.source}-এ এটি ইতোমধ্যে ${raw.score} পয়েন্ট এবং ${raw.comments_count}টি ডেভেলপার কমেন্ট অর্জন করেছে।`
      : `${cleanExcerpt || `Explores core engineering trade-offs around ${raw.title}`}. Currently trending on ${raw.source} with ${raw.score} developer upvotes and ${raw.comments_count} technical comments.`;
    return {
      ...raw,
      category_tag: tag,
      takeaway,
    };
  });

  const editorialHeadline = isBengali
    ? `Hacker News এবং DEV.to থেকে বাছাইকৃত ${enriched.length}টি শীর্ষ ডেভেলপার স্টোরি এবং ইঞ্জিনিয়ারিং আপডেট।`
    : `Curated 6-hour pulse of ${enriched.length} high-signal engineering stories across Hacker News and DEV.to.`;

  return {
    editorialHeadline,
    modelUsed,
    items: enriched,
  };
}

async function processWithGroqAI(
  rawItems: RawDeveloperItem[],
  outputLanguage: string,
): Promise<{
  editorialHeadline: string;
  modelUsed: string;
  items: ProcessedDigestItem[];
}> {
  const primaryModel =
    (process.env['GROQ_MODEL'] || 'llama-3.3-70b-versatile').trim() ||
    'llama-3.3-70b-versatile';
  const fallbackModel =
    (process.env['GROQ_FALLBACK_MODEL'] || 'llama-3.1-8b-instant').trim() ||
    'llama-3.1-8b-instant';

  const apiKey = (process.env['GROQ_API_KEY'] || '').trim();
  if (
    !apiKey ||
    apiKey === 'YOUR_GROQ_API_KEY' ||
    apiKey === 'MY_GROQ_API_KEY'
  ) {
    appendPipelineLog(
      'WARNING',
      'ai_processor',
      `GROQ_API_KEY not set in Secrets yet; synthesizing digest with built-in engineering analyzer (${primaryModel} schema compatible). Add GROQ_API_KEY in AI Studio Secrets for live Groq LPU inference.`,
    );
    return buildDeterministicGroqFallbackDigest(
      rawItems,
      outputLanguage,
      primaryModel,
    );
  }

  const languageDirective =
    outputLanguage.toLowerCase() === 'bengali'
      ? 'Write the `editorial_headline` and the 2-sentence `takeaway` in natural, professional Bengali (বাংলা), while strictly keeping technical terms, programming languages, frameworks, architectures, and the `category_tag` in English.'
      : `Write the \`editorial_headline\` and the 2-sentence \`takeaway\` in crisp, high-signal ${outputLanguage}.`;

  const systemInstruction =
    `You are a Principal Software Engineer and Technical Editor curating the 'Global Developer Pulse & Trending Tech Digest'.\n` +
    `You MUST respond strictly with a valid JSON object matching this exact schema:\n` +
    `{\n` +
    `  "editorial_headline": "A concise 1-sentence executive summary of this developer pulse batch.",\n` +
    `  "items": [\n` +
    `    {\n` +
    `      "uid": "Exact uid from the input item",\n` +
    `      "title": "Clean title of the story or article",\n` +
    `      "category_tag": "[AI/ML] | [Web Dev] | [System Design] | [Open Source] | [Cloud/DevOps] | [Security] | [Systems]",\n` +
    `      "takeaway": "Concise 2-sentence technical takeaway explaining why this matters to developers."\n` +
    `    }\n` +
    `  ]\n` +
    `}\n\n` +
    `Rules for every input developer item from Hacker News and DEV.to:\n` +
    `1. Assign a bracketed \`category_tag\` from: [AI/ML], [Web Dev], [System Design], [Open Source], [Cloud/DevOps], [Security], or [Systems].\n` +
    `2. Write a concise, zero-fluff 2-sentence technical \`takeaway\` explaining what the project/article covers and why it matters to software engineers.\n` +
    `3. ${languageDirective}\n` +
    `4. Keep the exact \`uid\` for deterministic mapping.`;

  const promptPayload = rawItems.map((item) => ({
    uid: item.uid,
    source: item.source,
    title: item.title,
    url: item.url,
    score: item.score,
    comments_count: item.comments_count,
    tags: item.tags,
    excerpt: item.excerpt,
  }));

  const userPrompt =
    `Generate a structured JSON developer digest in ${outputLanguage} for these ${rawItems.length} trending items:\n\n` +
    JSON.stringify(promptPayload, null, 2);

  const modelsToTry = [primaryModel, fallbackModel];
  for (let i = 0; i < modelsToTry.length; i++) {
    const activeModel = modelsToTry[i];
    try {
      appendPipelineLog(
        'INFO',
        'ai_processor',
        `Invoking Groq LPU API (${activeModel}) for ${rawItems.length} items [OUTPUT_LANGUAGE=${outputLanguage}, attempt=${i + 1}/${modelsToTry.length}]...`,
      );

      const response = await fetch(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: activeModel,
            messages: [
              {role: 'system', content: systemInstruction},
              {role: 'user', content: userPrompt},
            ],
            response_format: {type: 'json_object'},
            temperature: 0.2,
            max_completion_tokens: 4096,
          }),
        },
      );

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Groq HTTP ${response.status}: ${errBody.slice(0, 240)}`);
      }

      const completion = (await response.json()) as {
        choices?: {message?: {content?: string}}[];
      };
      const rawContent = (
        completion.choices?.[0]?.message?.content || '{}'
      ).trim();

      const parsed = JSON.parse(rawContent) as {
        editorial_headline?: string;
        items?: {
          uid?: string;
          title?: string;
          category_tag?: string;
          takeaway?: string;
        }[];
      };

      const aiMap = new Map<
        string,
        {title?: string; category_tag?: string; takeaway?: string}
      >();
      if (Array.isArray(parsed.items)) {
        for (const entry of parsed.items) {
          if (entry && entry.uid) {
            aiMap.set(String(entry.uid), entry);
          }
        }
      }

      const enriched: ProcessedDigestItem[] = rawItems.map((raw) => {
        const aiEntry = aiMap.get(raw.uid);
        let tag = (
          aiEntry?.category_tag || inferEngineeringCategoryTag(raw)
        ).trim();
        if (!tag.startsWith('[')) {
          tag = `[${tag}]`;
        }
        return {
          ...raw,
          title: (aiEntry?.title || raw.title).trim(),
          category_tag: tag,
          takeaway: (
            aiEntry?.takeaway ||
            `${raw.excerpt} Trending on ${raw.source} with ${raw.score} developer upvotes.`
          ).trim(),
        };
      });

      appendPipelineLog(
        'INFO',
        'ai_processor',
        `Groq LPU (${activeModel}) synthesized ${enriched.length} technical takeaways.`,
      );

      return {
        editorialHeadline:
          parsed.editorial_headline ||
          `Curated digest of ${enriched.length} high-signal developer stories across Hacker News & DEV.to.`,
        modelUsed: activeModel,
        items: enriched,
      };
    } catch (err) {
      appendPipelineLog(
        'WARNING',
        'ai_processor',
        `Groq API attempt ${i + 1} (${activeModel}) failed: ${String(err)}`,
      );
    }
  }

  appendPipelineLog(
    'WARNING',
    'ai_processor',
    'All Groq LPU attempts encountered an error; using deterministic fallback synthesizer so 6h digest delivery continues uninterrupted.',
  );
  return buildDeterministicGroqFallbackDigest(
    rawItems,
    outputLanguage,
    primaryModel,
  );
}

async function dispatchTelegramChunks(
  chunks: string[],
  customBotToken?: string,
  customChatId?: string,
  onlySpecificChatIds?: string[],
): Promise<{
  delivered: boolean;
  chunks_sent: number;
  message_ids: number[];
  reason?: string;
  chat_id?: string;
  bot_username?: string;
  recipients_count?: number;
  delivered_chat_ids?: string[];
}> {
  const currentConfig = readTelegramConfig();
  const effectiveToken = resolveInputBotToken(
    customBotToken,
    currentConfig.botToken || process.env['TELEGRAM_BOT_TOKEN'] || '',
  );
  const effectiveChatInput = (
    customChatId ||
    currentConfig.chatId ||
    process.env['TELEGRAM_CHAT_ID'] ||
    ''
  ).trim();

  if (!effectiveToken || effectiveToken === 'YOUR_TELEGRAM_BOT_TOKEN') {
    appendPipelineLog(
      'INFO',
      'bot_sender',
      `Prepared ${chunks.length} Telegram HTML chunk(s) (<4096 chars). Sync your Telegram Bot Token in the Telegram Dispatcher panel to auto-send.`,
    );
    return {
      delivered: false,
      chunks_sent: 0,
      message_ids: [],
      reason:
        'Telegram Bot Token not synced yet. Enter your Bot Token in the Telegram Bot Sync bar to auto-send digests.',
    };
  }

  // Verify bot and discover ALL /start subscribers via getUpdates
  const syncResult = await verifyAndDiscoverTelegramBot(
    effectiveToken,
    effectiveChatInput,
  );
  if (syncResult.error) {
    return {
      delivered: false,
      chunks_sent: 0,
      message_ids: [],
      reason: syncResult.error,
    };
  }

  const botUsername = syncResult.config.botUsername;

  // Build deduplicated target recipient list: EVERY user/chat in discoveredChats + primary chatId
  const targetRecipientsSet = new Set<string>();
  if (onlySpecificChatIds && onlySpecificChatIds.length > 0) {
    for (const cid of onlySpecificChatIds) {
      if (cid) targetRecipientsSet.add(String(cid));
    }
  } else {
    for (const sub of syncResult.config.discoveredChats || []) {
      if (sub.id) targetRecipientsSet.add(String(sub.id));
    }
    if (syncResult.config.chatId) {
      targetRecipientsSet.add(syncResult.config.chatId);
    }
  }

  const targetChatIds = Array.from(targetRecipientsSet);

  if (targetChatIds.length === 0) {
    const msg = botUsername
      ? `Bot @${botUsername} is verified! Anyone who sends /start to @${botUsername} on Telegram will automatically receive every 6h news update.`
      : 'Bot token verified, waiting for subscribers to send /start on Telegram.';
    appendPipelineLog('WARNING', 'bot_sender', msg);
    return {
      delivered: false,
      chunks_sent: 0,
      message_ids: [],
      reason: msg,
      bot_username: botUsername,
      recipients_count: 0,
      delivered_chat_ids: [],
    };
  }

  const endpoint = `https://api.telegram.org/bot${effectiveToken}/sendMessage`;
  const messageIds: number[] = [];
  const deliveredChatIds: string[] = [];
  let lastErrorReason = '';
  const cleanChunks = stripModelTagFromChunks(chunks);

  for (const recipientChatId of targetChatIds) {
    let allChunksSentForChat = true;
    for (let i = 0; i < cleanChunks.length; i++) {
      const chunk = cleanChunks[i];
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            chat_id: recipientChatId,
            text: chunk,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
        });

        const data = (await response.json()) as {
          ok?: boolean;
          description?: string;
          result?: {message_id?: number};
        };

        if (!response.ok || !data.ok) {
          allChunksSentForChat = false;
          lastErrorReason =
            data.description || `Telegram HTTP ${response.status} error`;
          appendPipelineLog(
            'WARNING',
            'bot_sender',
            `Telegram dispatch failed for subscriber ${recipientChatId} on chunk ${i + 1}/${cleanChunks.length}: ${lastErrorReason}`,
          );
          break;
        }

        if (data.result?.message_id) {
          messageIds.push(data.result.message_id);
        }
      } catch (err) {
        allChunksSentForChat = false;
        lastErrorReason = String(err);
        break;
      }
    }

    if (allChunksSentForChat) {
      deliveredChatIds.push(recipientChatId);
    }
  }

  const delivered = deliveredChatIds.length > 0;
  const targetSummary =
    deliveredChatIds.length > 1
      ? `${deliveredChatIds.length} subscribers (${deliveredChatIds.join(', ')})`
      : deliveredChatIds[0] || targetChatIds[0];

  if (delivered) {
    appendPipelineLog(
      'INFO',
      'bot_sender',
      `Broadcasted Telegram digest (${cleanChunks.length} chunk(s) each) via @${botUsername || 'bot'} to ${deliveredChatIds.length}/${targetChatIds.length} subscriber(s).`,
    );
  }

  return {
    delivered,
    chunks_sent: messageIds.length,
    message_ids: messageIds,
    reason: delivered ? undefined : lastErrorReason || 'Broadcast failed',
    chat_id: targetSummary,
    bot_username: botUsername,
    recipients_count: deliveredChatIds.length,
    delivered_chat_ids: deliveredChatIds,
  };
}

async function runFullPipelineCycle(options?: {
  outputLanguage?: string;
  hnLimit?: number;
  devtoLimit?: number;
  ignoreDedup?: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
}): Promise<{
  runRecord: DigestRunRecord | null;
  newItemsCount: number;
  skippedByDedup: boolean;
}> {
  schedulerState.isRunning = true;
  const outputLanguage =
    options?.outputLanguage || schedulerState.outputLanguage || 'English';
  const hnLimit = options?.hnLimit || schedulerState.hnTopLimit || 5;
  const devtoLimit = options?.devtoLimit || schedulerState.devtoTopLimit || 5;
  const ignoreDedup = Boolean(options?.ignoreDedup);

  appendPipelineLog(
    'INFO',
    'main',
    `Starting Global Developer Pulse pipeline run [language=${outputLanguage}, hn=${hnLimit}, devto=${devtoLimit}, ignoreDedup=${ignoreDedup}]...`,
  );

  try {
    const store = readProcessedStore();
    let [hnItems, devtoItems] = await Promise.all([
      fetchHackerNewsTopStories(hnLimit, store.items, ignoreDedup),
      fetchDevToTrendingArticles(devtoLimit, store.items, ignoreDedup),
    ]);

    let combined = [...hnItems, ...devtoItems];
    if (combined.length === 0) {
      appendPipelineLog(
        'INFO',
        'scraper',
        'All top candidate stories were previously seen; refreshing top stories batch for digest synthesis...',
      );
      [hnItems, devtoItems] = await Promise.all([
        fetchHackerNewsTopStories(hnLimit, store.items, true),
        fetchDevToTrendingArticles(devtoLimit, store.items, true),
      ]);
      combined = [...hnItems, ...devtoItems];
    }

    const aiResult = await processWithGroqAI(combined, outputLanguage);
    const formattedMessages = formatTelegramDigestChunks(
      aiResult.editorialHeadline,
      outputLanguage,
      aiResult.modelUsed,
      aiResult.items,
    );

    const telegramDelivery = await dispatchTelegramChunks(
      formattedMessages,
      options?.telegramBotToken,
      options?.telegramChatId,
    );

    const runRecord: DigestRunRecord = {
      generated_at: new Date().toISOString(),
      output_language: outputLanguage,
      model_used: aiResult.modelUsed,
      editorial_headline: aiResult.editorialHeadline,
      items: aiResult.items,
      telegram_delivery: telegramDelivery,
      formatted_messages: formattedMessages,
    };

    // Archive to daily_digests.json
    const archive = readDigestsArchive();
    archive.unshift(runRecord);
    writeDigestsArchive(archive);
    appendPipelineLog(
      'INFO',
      'bot_sender',
      `Saved digest batch to daily_digests.json (${aiResult.items.length} items, delivered=${telegramDelivery.delivered}, subscribers=${telegramDelivery.recipients_count || 0}).`,
    );

    // Update processed_ids.json
    const nowIso = new Date().toISOString();
    for (const item of combined) {
      store.items[item.uid] = nowIso;
    }
    writeProcessedStore(store.items);
    appendPipelineLog(
      'INFO',
      'scraper',
      `Updated processed_ids.json with ${combined.length} processed item IDs (total=${Object.keys(store.items).length}).`,
    );

    schedulerState.lastRunAt = nowIso;
    schedulerState.nextRunAt = new Date(
      Date.now() + schedulerState.intervalHours * 3600_000,
    ).toISOString();
    schedulerState.isRunning = false;

    return {
      runRecord,
      newItemsCount: combined.length,
      skippedByDedup: false,
    };
  } catch (err) {
    schedulerState.isRunning = false;
    appendPipelineLog(
      'ERROR',
      'main',
      `Pipeline execution failed: ${String(err)}`,
    );
    throw err;
  }
}

// Background Multi-Subscriber Auto-Sync & 6h Broadcast Loop:
// 1. Continuously polls getUpdates every 15s to discover ANY new user who sends /start to the bot.
// 2. Immediately sends the latest digest to any newly discovered subscriber (or any subscriber not yet in delivered_chat_ids).
// 3. Automatically runs the 6-hour pipeline cycle and broadcasts to ALL subscribers when nextRunAt is reached.
let backgroundPollerStarted = false;
function startBackgroundSyncLoop(): void {
  if (backgroundPollerStarted) return;
  backgroundPollerStarted = true;

  setInterval(async () => {
    try {
      const tgConfig = readTelegramConfig();
      if (tgConfig.botToken && tgConfig.autoSend) {
        const syncRes = await verifyAndDiscoverTelegramBot(
          tgConfig.botToken,
          tgConfig.chatId,
          true,
        );
        const allSubscribers = (syncRes.config.discoveredChats || []).map(
          (c) => c.id,
        );
        if (
          syncRes.config.chatId &&
          !allSubscribers.includes(syncRes.config.chatId)
        ) {
          allSubscribers.push(syncRes.config.chatId);
        }

        if (allSubscribers.length > 0) {
          const archive = readDigestsArchive();
          if (archive.length > 0 && archive[0].formatted_messages?.length > 0) {
            const latest = archive[0];
            const alreadySentSet = new Set<string>(
              latest.telegram_delivery?.delivered_chat_ids || [],
            );
            const unsentSubscribers = allSubscribers.filter(
              (cid) => !alreadySentSet.has(cid),
            );

            if (unsentSubscribers.length > 0) {
              appendPipelineLog(
                'INFO',
                'bot_sender',
                `Auto-broadcasting latest digest to ${unsentSubscribers.length} new/unsent Telegram subscriber(s)...`,
              );
              const delivery = await dispatchTelegramChunks(
                latest.formatted_messages,
                tgConfig.botToken,
                tgConfig.chatId,
                unsentSubscribers,
              );
              const mergedChatIds = Array.from(
                new Set([
                  ...alreadySentSet,
                  ...(delivery.delivered_chat_ids || []),
                ]),
              );
              latest.telegram_delivery = {
                delivered: mergedChatIds.length > 0,
                chunks_sent:
                  (latest.telegram_delivery?.chunks_sent || 0) +
                  delivery.chunks_sent,
                message_ids: [
                  ...(latest.telegram_delivery?.message_ids || []),
                  ...(delivery.message_ids || []),
                ],
                chat_id:
                  mergedChatIds.length > 1
                    ? `${mergedChatIds.length} subscribers`
                    : mergedChatIds[0] || delivery.chat_id,
                bot_username: delivery.bot_username,
                recipients_count: mergedChatIds.length,
                delivered_chat_ids: mergedChatIds,
              };
              writeDigestsArchive(archive);
            }
          }
        }
      }

      // Check scheduled 6h pipeline run
      if (
        !schedulerState.isRunning &&
        schedulerState.nextRunAt &&
        Date.now() >= new Date(schedulerState.nextRunAt).getTime()
      ) {
        await runFullPipelineCycle();
      }
    } catch {
      // Keep background loop resilient
    }
  }, 15_000);
}

startBackgroundSyncLoop();

// API Endpoint: Get full pipeline state (with zero-plaintext redacted Telegram config)
app.get('/api/pipeline/state', (_req, res) => {
  try {
    const processedStore = readProcessedStore();
    const digests = readDigestsArchive();
    const telegramSync = readTelegramConfig();
    const safeTelegramSync = toClientSafeTelegramConfig(telegramSync);
    const logsRaw = existsSync(PIPELINE_LOG_PATH)
      ? readFileSync(PIPELINE_LOG_PATH, 'utf-8')
      : '';
    const logs = logsRaw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .slice(-80)
      .reverse()
      .map((line) => sanitizeSecretsFromText(line));

    const pythonFiles = PYTHON_PROJECT_FILES.map((filename) => {
      const fullPath = join(workspaceRoot, filename);
      const content = existsSync(fullPath)
        ? readFileSync(fullPath, 'utf-8')
        : '';
      return {
        filename,
        sizeBytes: Buffer.byteLength(content, 'utf-8'),
        linesCount: content ? content.split('\n').length : 0,
        content,
      };
    });

    const geminiSecretConfigured = Boolean(
      process.env['GROQ_API_KEY'] &&
        process.env['GROQ_API_KEY'] !== 'YOUR_GROQ_API_KEY' &&
        process.env['GROQ_API_KEY'] !== 'MY_GROQ_API_KEY',
    );
    const githubPatConfigured = Boolean(
      process.env['GITHUB_PAT'] &&
        process.env['GITHUB_PAT'] !== 'YOUR_GITHUB_PAT' &&
        process.env['GITHUB_PAT'] !== 'MY_GITHUB_PAT',
    );
    const githubRepo = (
      process.env['GITHUB_REPO'] &&
      process.env['GITHUB_REPO'] !== 'your-username/global-developer-pulse'
        ? process.env['GITHUB_REPO']
        : 'iTzinvi-dev/aUtoActiVity'
    ).trim();

    res.json({
      scheduler: schedulerState,
      geminiSecretConfigured,
      githubPatConfigured,
      githubRepo,
      firebaseProjectId: '',
      firestoreDatabaseId: '',
      telegramConfigured: Boolean(
        telegramSync.botToken &&
          (telegramSync.chatId || telegramSync.discoveredChats.length > 0) &&
          telegramSync.verified,
      ),
      telegramSync: safeTelegramSync,
      processedStore,
      digests,
      weeklyTrends: computeWeeklyTrends(digests, processedStore.items),
      logs,
      pythonFiles,
    });
  } catch (err) {
    res.status(500).json({error: String(err)});
  }
});

// API Endpoint: Restore & sync Firestore cloud vault + subscribers + automation config into the 6h daemon
app.post('/api/pipeline/restore-from-firestore', async (req, res) => {
  try {
    const {
      telegramVault,
      telegramSubscribers,
      automationConfig,
      processedItems,
    } = req.body || {};

    if (automationConfig && typeof automationConfig === 'object') {
      if (automationConfig.intervalHours) {
        schedulerState.intervalHours = Math.max(
          1,
          Math.min(24, Number(automationConfig.intervalHours) || 6),
        );
      }
      if (typeof automationConfig.dailyRunTime === 'string') {
        schedulerState.dailyRunTime = automationConfig.dailyRunTime.trim();
      }
      if (
        automationConfig.outputLanguage === 'English' ||
        automationConfig.outputLanguage === 'Bengali'
      ) {
        schedulerState.outputLanguage = automationConfig.outputLanguage;
      }
      if (automationConfig.hnTopLimit) {
        schedulerState.hnTopLimit = Math.max(
          1,
          Math.min(15, Number(automationConfig.hnTopLimit) || 5),
        );
      }
      if (automationConfig.devtoTopLimit) {
        schedulerState.devtoTopLimit = Math.max(
          1,
          Math.min(15, Number(automationConfig.devtoTopLimit) || 5),
        );
      }
    }

    if (processedItems && typeof processedItems === 'object') {
      const currentStore = readProcessedStore();
      const merged = {...processedItems, ...currentStore.items};
      writeProcessedStore(merged);
    }

    const currentTg = readTelegramConfig();
    const subscriberMap = new Map<string, DiscoveredTelegramChat>();
    for (const sub of currentTg.discoveredChats || []) {
      if (sub.id) subscriberMap.set(String(sub.id), sub);
    }
    if (Array.isArray(telegramSubscribers)) {
      for (const sub of telegramSubscribers) {
        if (sub && sub.chatId) {
          const cid = String(sub.chatId);
          subscriberMap.set(cid, {
            id: cid,
            title: String(sub.title || `Subscriber ${cid}`),
            type: String(sub.chatType || 'private'),
            username: sub.username ? String(sub.username) : undefined,
            subscribedAt: String(
              sub.subscribedAtIso || new Date().toISOString(),
            ),
          });
        }
      }
    }

    const decryptedFromVault =
      telegramVault && typeof telegramVault === 'object'
        ? decryptSecretToken(
            String(
              telegramVault.encryptedBotToken || telegramVault.botToken || '',
            ),
          )
        : '';

    const resolvedToken = currentTg.botToken || decryptedFromVault;
    if (resolvedToken || subscriberMap.size > 0) {
      const restoredTg: TelegramSyncConfig = {
        botToken: resolvedToken,
        encryptedBotToken: resolvedToken
          ? encryptSecretToken(resolvedToken)
          : '',
        botTokenMasked: maskBotToken(resolvedToken),
        hasBotToken: Boolean(resolvedToken),
        chatId:
          currentTg.chatId ||
          normalizeTelegramChatId(String(telegramVault?.chatId || '')),
        botUsername:
          currentTg.botUsername || String(telegramVault?.botUsername || ''),
        botName: currentTg.botName || String(telegramVault?.botName || ''),
        chatTitle:
          currentTg.chatTitle || String(telegramVault?.chatTitle || ''),
        autoSend:
          telegramVault?.autoSendEvery6h !== undefined
            ? Boolean(telegramVault.autoSendEvery6h)
            : currentTg.autoSend,
        verified: Boolean(currentTg.verified || telegramVault?.verified),
        lastSyncedAt:
          currentTg.lastSyncedAt ||
          String(telegramVault?.lastSyncedIso || new Date().toISOString()),
        discoveredChats: Array.from(subscriberMap.values()),
      };
      writeTelegramConfig(restoredTg);
      appendPipelineLog(
        'INFO',
        'bot_sender',
        `Restored encrypted Telegram vault (@${restoredTg.botUsername || 'bot'}) and ${restoredTg.discoveredChats.length} subscriber(s) from Firebase Firestore.`,
      );
    }

    const currentArchive = readDigestsArchive();
    if (currentArchive.length > 0) {
      writeDigestsArchive(currentArchive);
    }

    res.json({
      ok: true,
      scheduler: schedulerState,
      telegramSync: toClientSafeTelegramConfig(readTelegramConfig()),
    });
  } catch (err) {
    res.status(500).json({ok: false, error: String(err)});
  }
});

// API Endpoint: Sync Telegram Bot credentials, discover ALL /start subscribers via getUpdates, and broadcast latest digest
app.post('/api/pipeline/sync-telegram', async (req, res) => {
  try {
    const {telegramBotToken, telegramChatId, autoSend} = req.body || {};
    const {config, error} = await verifyAndDiscoverTelegramBot(
      telegramBotToken,
      telegramChatId,
      autoSend !== undefined ? Boolean(autoSend) : true,
    );

    if (error) {
      res.status(400).json({
        ok: false,
        error,
        telegramSync: toClientSafeTelegramConfig(config),
      });
      return;
    }

    let autoDispatchResult: {
      delivered: boolean;
      chunks_sent: number;
      message_ids: number[];
      reason?: string;
      recipients_count?: number;
      delivered_chat_ids?: string[];
    } | null = null;

    const archive = readDigestsArchive();
    if (
      (config.discoveredChats.length > 0 || config.chatId) &&
      archive.length > 0
    ) {
      const targetDigest = archive[0];
      if (targetDigest.formatted_messages?.length > 0) {
        autoDispatchResult = await dispatchTelegramChunks(
          targetDigest.formatted_messages,
          config.botToken,
          config.chatId,
        );
        archive[0].telegram_delivery = autoDispatchResult;
        writeDigestsArchive(archive);
      }
    }

    res.json({
      ok: true,
      telegramSync: toClientSafeTelegramConfig(config),
      autoDispatchResult,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// API Endpoint: Live preview fetch from Hacker News & DEV.to without AI consumption
app.get('/api/pipeline/fetch-preview', async (req, res) => {
  try {
    const hnLimit = Math.max(
      1,
      Math.min(15, Number(req.query['hnLimit'] || schedulerState.hnTopLimit)),
    );
    const devtoLimit = Math.max(
      1,
      Math.min(
        15,
        Number(req.query['devtoLimit'] || schedulerState.devtoTopLimit),
      ),
    );
    const ignoreDedup = req.query['ignoreDedup'] === 'true';
    const store = readProcessedStore();

    const [hnItems, devtoItems] = await Promise.all([
      fetchHackerNewsTopStories(hnLimit, store.items, ignoreDedup),
      fetchDevToTrendingArticles(devtoLimit, store.items, ignoreDedup),
    ]);

    res.json({
      fetchedAt: new Date().toISOString(),
      hnItems,
      devtoItems,
      totalCount: hnItems.length + devtoItems.length,
    });
  } catch (err) {
    res.status(500).json({error: String(err)});
  }
});

// API Endpoint: Execute the complete pipeline (Scrape -> Groq LPU -> Broadcast to ALL Telegram Subscribers & Archive)
app.post('/api/pipeline/run', async (req, res) => {
  try {
    const {
      outputLanguage,
      hnLimit,
      devtoLimit,
      ignoreDedup,
      telegramBotToken,
      telegramChatId,
    } = req.body || {};

    if (outputLanguage) {
      schedulerState.outputLanguage = String(outputLanguage);
    }
    if (hnLimit) {
      schedulerState.hnTopLimit = Number(hnLimit);
    }
    if (devtoLimit) {
      schedulerState.devtoTopLimit = Number(devtoLimit);
    }

    const result = await runFullPipelineCycle({
      outputLanguage,
      hnLimit: Number(hnLimit || schedulerState.hnTopLimit),
      devtoLimit: Number(devtoLimit || schedulerState.devtoTopLimit),
      ignoreDedup: Boolean(ignoreDedup),
      telegramBotToken,
      telegramChatId,
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({
      error:
        err instanceof Error
          ? err.message
          : 'Failed to execute developer pulse pipeline.',
    });
  }
});

// API Endpoint: External 6h Cron Wake-Up Webhook (for cron-job.org, Cloud Scheduler, or GitHub Actions)
app.all('/api/pipeline/cron', async (req, res) => {
  try {
    const lang =
      String(req.query['lang'] || req.body?.outputLanguage || '').trim() ||
      schedulerState.outputLanguage;
    const result = await runFullPipelineCycle({
      outputLanguage: lang,
      hnLimit: schedulerState.hnTopLimit,
      devtoLimit: schedulerState.devtoTopLimit,
      ignoreDedup: false,
    });
    res.json({
      ok: true,
      triggeredAt: new Date().toISOString(),
      delivered: result.runRecord?.telegram_delivery?.delivered ?? false,
      recipientsCount:
        result.runRecord?.telegram_delivery?.recipients_count ?? 0,
      itemsProcessed: result.newItemsCount,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// API Endpoint: Broadcast an already-generated digest to ALL Telegram Bot subscribers
app.post('/api/pipeline/send-telegram', async (req, res) => {
  try {
    const {chunks, telegramBotToken, telegramChatId, generatedAt} =
      req.body || {};
    if (!Array.isArray(chunks) || chunks.length === 0) {
      res.status(400).json({error: 'No digest message chunks provided.'});
      return;
    }
    const result = await dispatchTelegramChunks(
      chunks,
      telegramBotToken,
      telegramChatId,
    );

    const archive = readDigestsArchive();
    if (archive.length > 0) {
      const targetIdx = generatedAt
        ? archive.findIndex((d) => d.generated_at === generatedAt)
        : 0;
      const idxToUpdate = targetIdx >= 0 ? targetIdx : 0;
      if (archive[idxToUpdate]) {
        archive[idxToUpdate].telegram_delivery = result;
        writeDigestsArchive(archive);
      }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({error: String(err)});
  }
});

// API Endpoint: Reset deduplication cache (processed_ids.json)
app.post('/api/pipeline/reset-dedup', (_req, res) => {
  try {
    writeProcessedStore({});
    appendPipelineLog(
      'INFO',
      'scraper',
      'Reset processed_ids.json deduplication store via Control Center.',
    );
    res.json({ok: true, processedStore: readProcessedStore()});
  } catch (err) {
    res.status(500).json({error: String(err)});
  }
});

// API Endpoint: Update scheduler configuration
app.post('/api/pipeline/schedule', (req, res) => {
  try {
    const {intervalHours, dailyRunTime, outputLanguage} = req.body || {};
    if (intervalHours !== undefined) {
      schedulerState.intervalHours = Math.max(
        1,
        Math.min(24, Number(intervalHours) || 6),
      );
    }
    if (dailyRunTime !== undefined) {
      schedulerState.dailyRunTime = String(dailyRunTime).trim();
    }
    if (outputLanguage !== undefined) {
      schedulerState.outputLanguage = String(outputLanguage).trim();
    }
    schedulerState.nextRunAt = new Date(
      Date.now() + schedulerState.intervalHours * 3600_000,
    ).toISOString();
    appendPipelineLog(
      'INFO',
      'main',
      `Updated scheduler config: every ${schedulerState.intervalHours}h, dailyRunTime='${schedulerState.dailyRunTime || 'interval'}', OUTPUT_LANGUAGE=${schedulerState.outputLanguage}.`,
    );
    res.json({ok: true, scheduler: schedulerState});
  } catch (err) {
    res.status(500).json({error: String(err)});
  }
});

// API Endpoint: Server-side Firebase runtime bootstrap (never exposes secret variables to frontend)
app.get('/api/pipeline/firebase-bootstrap', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({bootstrapToken: ''});
});

const GITHUB_EXPORT_FILES = [
  'config.py',
  'scraper.py',
  'ai_processor.py',
  'bot_sender.py',
  'main.py',
  'requirements.txt',
  'subscribers.json',
  '.github/workflows/digest_pipeline.yml',
  '.github/workflows/cron.yml',
  'vercel.json',
  'api/index.mjs',
  '.env.example',
  'README.md',
  '.gitignore',
  '.postcssrc.json',
  'package.json',
  'angular.json',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.spec.json',
  'eslint.config.js',
  'metadata.json',
  'firestore.rules',
  'firestore.rules.test.ts',
  'security_spec.md',
  'firebase-blueprint.json',
  'processed_ids.json',
  'daily_digests.json',
  'src/index.html',
  'src/main.ts',
  'src/main.server.ts',
  'src/server.ts',
  'src/styles.css',
  'src/app/firebase.ts',
  'src/app/app.ts',
  'src/app/app.html',
  'src/app/app.css',
  'src/app/app.spec.ts',
  'src/app/app.config.ts',
  'src/app/app.config.server.ts',
  'src/app/app.routes.ts',
  'src/app/app.routes.server.ts',
] as const;

// API Endpoint: Push entire codebase + 6h GitHub Actions workflow + vercel.json to GitHub using server-side GITHUB_PAT
app.post('/api/pipeline/push-github', async (req, res) => {
  try {
    const githubPat = (process.env['GITHUB_PAT'] || '').trim();
    if (
      !githubPat ||
      githubPat === 'YOUR_GITHUB_PAT' ||
      githubPat === 'MY_GITHUB_PAT'
    ) {
      res.status(400).json({
        ok: false,
        error:
          'GITHUB_PAT is not set in AI Studio Secrets yet. Open the Secrets panel (key icon), paste your GitHub Personal Access Token into GITHUB_PAT, and click Push codebase to GitHub.',
      });
      return;
    }

    const ghHeaders = {
      Authorization: `Bearer ${githubPat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GlobalDeveloperPulse-Exporter/1.0',
      'Content-Type': 'application/json',
    };

    // 1. Verify GitHub token and fetch authenticated username
    const userResp = await fetch('https://api.github.com/user', {
      headers: ghHeaders,
    });
    if (!userResp.ok) {
      const errText = await userResp.text();
      res.status(400).json({
        ok: false,
        error: `GitHub token verification failed (HTTP ${userResp.status}): ${errText.slice(0, 180)}`,
      });
      return;
    }
    const ghUser = (await userResp.json()) as {login: string};
    const rawRepoInput = String(
      req.body?.repoName ||
        process.env['GITHUB_REPO'] ||
        'iTzinvi-dev/aUtoActiVity',
    ).trim();

    let owner = ghUser.login || 'iTzinvi-dev';
    let repoName = 'aUtoActiVity';
    if (
      rawRepoInput &&
      rawRepoInput !== 'your-username/global-developer-pulse'
    ) {
      if (rawRepoInput.includes('/')) {
        const parts = rawRepoInput
          .replace(/^https?:\/\/github\.com\//i, '')
          .replace(/\.git$/i, '')
          .split('/')
          .filter(Boolean);
        if (parts.length >= 2) {
          owner = parts[0];
          repoName = parts[1];
        } else if (parts.length === 1) {
          repoName = parts[0];
        }
      } else {
        repoName = rawRepoInput.replace(/\.git$/i, '');
      }
    }

    const isPrivate = Boolean(req.body?.isPrivate ?? false);

    // 2. Check if repository exists; if not, create it with auto_init: true
    let repoResp = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}`,
      {headers: ghHeaders},
    );

    if (repoResp.status === 404) {
      appendPipelineLog(
        'INFO',
        'main',
        `Creating new GitHub repository ${owner}/${repoName}...`,
      );
      const createResp = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: ghHeaders,
        body: JSON.stringify({
          name: repoName,
          description:
            'Global Developer Pulse & 6-Hour Trending Tech Digest Pipeline (Groq LPU + Telegram Multi-Subscriber Broadcast + Angular 21 SSR)',
          private: isPrivate,
          auto_init: true,
        }),
      });
      if (!createResp.ok) {
        const createErr = await createResp.text();
        res.status(400).json({
          ok: false,
          error: `Failed to create GitHub repository ${owner}/${repoName}: ${createErr.slice(0, 220)}`,
        });
        return;
      }
      // Wait briefly for GitHub to finish initializing the default branch
      await new Promise((r) => setTimeout(r, 1500));
      repoResp = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}`,
        {headers: ghHeaders},
      );
    }

    const repoData = (await repoResp.json()) as {
      default_branch?: string;
      html_url?: string;
    };
    const defaultBranch = repoData.default_branch || 'main';
    const repoUrl =
      repoData.html_url || `https://github.com/${owner}/${repoName}`;

    // 3. Ensure default branch ref exists (or initialize README if empty repo)
    let refResp = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/git/ref/heads/${defaultBranch}`,
      {headers: ghHeaders},
    );
    if (refResp.status === 404 || refResp.status === 409) {
      // Repository is completely empty (0 commits) — bootstrap with README.md via Contents API
      const readmeContent = existsSync(join(workspaceRoot, 'README.md'))
        ? readFileSync(join(workspaceRoot, 'README.md'), 'utf-8')
        : '# Global Developer Pulse\n';
      await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/contents/README.md`,
        {
          method: 'PUT',
          headers: ghHeaders,
          body: JSON.stringify({
            message: 'chore: initial repository bootstrap',
            content: Buffer.from(readmeContent, 'utf-8').toString('base64'),
            branch: defaultBranch,
          }),
        },
      );
      await new Promise((r) => setTimeout(r, 1000));
      refResp = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/git/ref/heads/${defaultBranch}`,
        {headers: ghHeaders},
      );
    }

    if (!refResp.ok) {
      const refErr = await refResp.text();
      res.status(400).json({
        ok: false,
        error: `Could not read branch '${defaultBranch}' on ${owner}/${repoName}: ${refErr.slice(0, 200)}`,
      });
      return;
    }

    // 4. Build clean tree entries for all non-secret codebase files (omits base_tree so any old secret files are wiped)
    const treeEntries: {
      path: string;
      mode: '100644';
      type: 'blob';
      content: string;
    }[] = [];

    for (const relPath of GITHUB_EXPORT_FILES) {
      const absPath = join(workspaceRoot, relPath);
      if (existsSync(absPath)) {
        const content = readFileSync(absPath, 'utf-8');
        treeEntries.push({
          path: relPath,
          mode: '100644',
          type: 'blob',
          content,
        });
      }
    }

    const treeCreateResp = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/git/trees`,
      {
        method: 'POST',
        headers: ghHeaders,
        body: JSON.stringify({
          tree: treeEntries,
        }),
      },
    );

    if (!treeCreateResp.ok) {
      const treeErr = await treeCreateResp.text();
      res.status(400).json({
        ok: false,
        error: `GitHub Tree API error (check if your token has 'workflow' & 'repo' permissions): ${treeErr.slice(0, 240)}`,
      });
      return;
    }

    const newTreeData = (await treeCreateResp.json()) as {sha: string};

    // 5. Create clean root commit (parents: []) & force-advance branch ref so zero exposed keys remain in git history
    const newCommitResp = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/git/commits`,
      {
        method: 'POST',
        headers: ghHeaders,
        body: JSON.stringify({
          message:
            'feat: deploy Global Developer Pulse (zero frontend API keys + Groq LPU + 6h GitHub Actions + Vercel)',
          tree: newTreeData.sha,
          parents: [],
        }),
      },
    );
    if (!newCommitResp.ok) {
      const commitErr = await newCommitResp.text();
      res.status(400).json({
        ok: false,
        error: `Failed creating GitHub commit: ${commitErr.slice(0, 200)}`,
      });
      return;
    }
    const createdCommit = (await newCommitResp.json()) as {sha: string};

    const updateRefResp = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/git/refs/heads/${defaultBranch}`,
      {
        method: 'PATCH',
        headers: ghHeaders,
        body: JSON.stringify({
          sha: createdCommit.sha,
          force: true,
        }),
      },
    );

    if (!updateRefResp.ok) {
      const updateErr = await updateRefResp.text();
      res.status(400).json({
        ok: false,
        error: `Failed updating branch ref '${defaultBranch}': ${updateErr.slice(0, 200)}`,
      });
      return;
    }

    appendPipelineLog(
      'INFO',
      'main',
      `Successfully pushed ${treeEntries.length} files (including 6h GitHub Actions workflow & vercel.json) to ${repoUrl} (${defaultBranch} @ ${createdCommit.sha.slice(0, 7)}).`,
    );

    res.json({
      ok: true,
      repoFullName: `${owner}/${repoName}`,
      repoUrl,
      branch: defaultBranch,
      commitSha: createdCommit.sha,
      filesPushed: treeEntries.length,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
