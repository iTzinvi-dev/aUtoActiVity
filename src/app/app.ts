import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {isPlatformBrowser} from '@angular/common';
import {HttpClient} from '@angular/common/http';
import {FormControl, FormGroup, ReactiveFormsModule} from '@angular/forms';
import {MatIconModule} from '@angular/material/icon';
import * as d3 from 'd3';
import {
  auth,
  db,
  googleProvider,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  getDocs,
  serverTimestamp,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  testFirestoreConnection,
  ensureFirebaseInitialized,
  handleFirestoreError,
  OperationType,
  User,
} from './firebase';


export interface ProcessedDigestItem {
  uid: string;
  source: 'Hacker News' | 'DEV.to';
  title: string;
  category_tag: string;
  takeaway: string;
  url: string;
  discussion_url: string;
  author: string;
  score: number;
  comments_count: number;
  tags: string[];
  excerpt: string;
  published_at: string;
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

export interface CategoryTagCloudItem {
  tag: string;
  count: number;
  archiveCount: number;
  sharePercent: number;
  tier: 'lg' | 'md' | 'sm';
}


export interface PythonProjectFile {
  filename: string;
  sizeBytes: number;
  linesCount: number;
  content: string;
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

export interface SchedulerState {
  intervalHours: number;
  dailyRunTime: string;
  outputLanguage: string;
  hnTopLimit: number;
  devtoTopLimit: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  isRunning: boolean;
}

export interface PipelineStateResponse {
  scheduler: SchedulerState;
  geminiSecretConfigured?: boolean;
  githubPatConfigured?: boolean;
  githubRepo?: string;
  firebaseProjectId?: string;
  firestoreDatabaseId?: string;
  telegramConfigured: boolean;
  telegramSync?: TelegramSyncConfig;
  processedStore: {
    updated_at: string;
    total_count: number;
    items: Record<string, string>;
  };
  digests: DigestRunRecord[];
  weeklyTrends?: DailyVolumeTrendPoint[];
  logs: string[];
  pythonFiles: PythonProjectFile[];
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [ReactiveFormsModule, MatIconModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly platformId = inject(PLATFORM_ID);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  readonly trendsChartSvg =
    viewChild<ElementRef<SVGSVGElement>>('trendsChartSvg');

  readonly activeSection = signal<'digest' | 'telegram' | 'codebase' | 'logs'>(
    'digest',
  );
  readonly sourceFilter = signal<'all' | 'Hacker News' | 'DEV.to'>('all');
  readonly categoryFilter = signal<string>('all');
  readonly searchQuery = signal<string>('');

  readonly isLoadingState = signal<boolean>(true);
  readonly isRunningPipeline = signal<boolean>(false);
  readonly isSyncingTelegram = signal<boolean>(false);
  readonly isSendingTelegram = signal<boolean>(false);
  readonly isSyncingFirestore = signal<boolean>(false);
  readonly firestoreConnected = signal<boolean>(false);
  readonly currentUser = signal<User | null>(null);
  readonly firestoreLastSyncedAt = signal<string | null>(null);
  readonly firestoreSyncedDocsCount = signal<number>(0);
  readonly geminiSecretActive = signal<boolean>(true);
  readonly githubPatActive = signal<boolean>(false);
  readonly isPushingGitHub = signal<boolean>(false);
  readonly pushedGitHubUrl = signal<string | null>(null);
  readonly githubRepoControl = new FormControl<string>(
    'iTzinvi-dev/aUtoActiVity',
    {nonNullable: true},
  );
  readonly firebaseProjectId = signal<string>('');

  readonly statusBanner = signal<{
    type: 'info' | 'success' | 'error';
    message: string;
  } | null>(null);

  readonly scheduler = signal<SchedulerState>({
    intervalHours: 6,
    dailyRunTime: '',
    outputLanguage: 'English',
    hnTopLimit: 5,
    devtoTopLimit: 5,
    lastRunAt: null,
    nextRunAt: null,
    isRunning: false,
  });

  readonly nextCycleCountdown = signal<string>('05:59:59');

  readonly telegramConfigured = signal<boolean>(false);
  readonly telegramSync = signal<TelegramSyncConfig>({
    botToken: '',
    chatId: '',
    botUsername: '',
    botName: '',
    chatTitle: '',
    autoSend: true,
    verified: false,
    lastSyncedAt: null,
    discoveredChats: [],
  });

  readonly processedStore = signal<{
    updated_at: string;
    total_count: number;
    items: Record<string, string>;
  }>({
    updated_at: '',
    total_count: 0,
    items: {},
  });

  readonly digests = signal<DigestRunRecord[]>([]);
  readonly weeklyTrends = signal<DailyVolumeTrendPoint[]>([]);
  readonly hoveredTrendPoint = signal<DailyVolumeTrendPoint | null>(null);
  readonly selectedDigestIndex = signal<number>(0);
  readonly logs = signal<string[]>([]);
  readonly pythonFiles = signal<PythonProjectFile[]>([]);
  readonly selectedFileName = signal<string>('main.py');
  readonly copiedLabel = signal<string | null>(null);

  readonly pipelineForm = new FormGroup({
    outputLanguage: new FormControl<'English' | 'Bengali'>('English', {
      nonNullable: true,
    }),
    hnLimit: new FormControl<number>(5, {nonNullable: true}),
    devtoLimit: new FormControl<number>(5, {nonNullable: true}),
    intervalHours: new FormControl<number>(6, {nonNullable: true}),
    dailyRunTime: new FormControl<string>('', {nonNullable: true}),
    ignoreDedup: new FormControl<boolean>(false, {nonNullable: true}),
    telegramBotToken: new FormControl<string>('', {nonNullable: true}),
    telegramChatId: new FormControl<string>('', {nonNullable: true}),
    autoSendTelegram: new FormControl<boolean>(true, {nonNullable: true}),
  });

  readonly searchControl = new FormControl<string>('', {nonNullable: true});

  readonly activeDigest = computed<DigestRunRecord | null>(() => {
    const list = this.digests();
    const idx = this.selectedDigestIndex();
    return list[idx] ?? list[0] ?? null;
  });

  readonly weeklyTotalArticles = computed<number>(() =>
    this.weeklyTrends().reduce((sum, pt) => sum + pt.totalCount, 0),
  );

  readonly weeklyDailyAverage = computed<number>(() => {
    const pts = this.weeklyTrends();
    if (!pts.length) return 0;
    return Math.round(this.weeklyTotalArticles() / pts.length);
  });

  readonly availableCategories = computed<string[]>(() => {
    const digest = this.activeDigest();
    if (!digest) return [];
    const set = new Set<string>();
    for (const item of digest.items) {
      if (item.category_tag) {
        set.add(item.category_tag);
      }
    }
    return Array.from(set);
  });

  readonly activeSourceItemsCount = computed<number>(() => {
    const digest = this.activeDigest();
    if (!digest) return 0;
    const src = this.sourceFilter();
    return digest.items.filter((item) => src === 'all' || item.source === src)
      .length;
  });

  readonly categoryTagCloud = computed<CategoryTagCloudItem[]>(() => {
    const digest = this.activeDigest();
    if (!digest) return [];
    const src = this.sourceFilter();
    const allDigests = this.digests();

    const archiveCounts = new Map<string, number>();
    for (const run of allDigests) {
      for (const item of run.items) {
        if (!item.category_tag) continue;
        if (src !== 'all' && item.source !== src) continue;
        archiveCounts.set(
          item.category_tag,
          (archiveCounts.get(item.category_tag) || 0) + 1,
        );
      }
    }

    const activeCounts = new Map<string, number>();
    let totalInScope = 0;
    for (const item of digest.items) {
      if (!item.category_tag) continue;
      if (src !== 'all' && item.source !== src) continue;
      activeCounts.set(
        item.category_tag,
        (activeCounts.get(item.category_tag) || 0) + 1,
      );
      totalInScope++;
    }

    const entries = Array.from(activeCounts.entries());
    if (entries.length === 0) return [];

    const counts = entries.map(([, c]) => c);
    const maxCount = Math.max(...counts);
    const minCount = Math.min(...counts);

    return entries
      .map(([tag, count]) => {
        const archiveCount = archiveCounts.get(tag) || count;
        const sharePercent =
          totalInScope > 0 ? Math.round((count / totalInScope) * 100) : 0;
        let tier: 'lg' | 'md' | 'sm' = 'md';
        if (maxCount === minCount) {
          tier = count >= 2 ? 'lg' : 'md';
        } else if (count === maxCount) {
          tier = 'lg';
        } else if (count === minCount) {
          tier = 'sm';
        }
        return {
          tag,
          count,
          archiveCount,
          sharePercent,
          tier,
        };
      })
      .sort(
        (a, b) =>
          b.count - a.count ||
          b.archiveCount - a.archiveCount ||
          a.tag.localeCompare(b.tag),
      );
  });

  readonly filteredDigestItems = computed<ProcessedDigestItem[]>(() => {
    const digest = this.activeDigest();
    if (!digest) return [];
    const src = this.sourceFilter();
    const cat = this.categoryFilter();
    const q = this.searchQuery().trim().toLowerCase();

    return digest.items.filter((item) => {
      if (src !== 'all' && item.source !== src) return false;
      if (cat !== 'all' && item.category_tag !== cat) return false;
      if (q) {
        const hay =
          `${item.title} ${item.takeaway} ${item.category_tag} ${item.author}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  readonly selectedPythonFile = computed<PythonProjectFile | null>(() => {
    const files = this.pythonFiles();
    const target = this.selectedFileName();
    return files.find((f) => f.filename === target) ?? files[0] ?? null;
  });

  readonly processedEntriesList = computed<{uid: string; timestamp: string}[]>(
    () => {
      const items = this.processedStore().items || {};
      return Object.entries(items)
        .map(([uid, timestamp]) => ({uid, timestamp}))
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    },
  );

  constructor() {
    effect(() => {
      const svgRef = this.trendsChartSvg();
      const data = this.weeklyTrends();
      const section = this.activeSection();
      if (
        isPlatformBrowser(this.platformId) &&
        section === 'digest' &&
        svgRef?.nativeElement &&
        data.length > 0
      ) {
        this.renderD3TrendsChart(svgRef.nativeElement, data);
      }
    });
  }

  ngOnInit(): void {
    this.searchControl.valueChanges.subscribe((val) => {
      this.searchQuery.set(val);
    });

    if (isPlatformBrowser(this.platformId)) {
      ensureFirebaseInitialized().then((ready) => {
        if (!ready) return;
        testFirestoreConnection().then((ok) => {
          this.firestoreConnected.set(ok);
        });

        onAuthStateChanged(auth, (user) => {
          this.currentUser.set(user);
          if (user) {
            this.restoreFromFirestoreAndSync(user);
          }
        });
      });

      this.loadPipelineState(true);
      this.pollTimer = setInterval(() => {
        if (!this.isRunningPipeline() && !this.isSyncingTelegram()) {
          this.loadPipelineState(false, true);
        }
      }, 15_000);

      this.countdownTimer = setInterval(() => {
        this.updateCountdownClock();
      }, 1000);
    }
  }

  ngOnDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  private updateCountdownClock(): void {
    const nextIso = this.scheduler().nextRunAt;
    if (!nextIso) {
      this.nextCycleCountdown.set('06:00:00');
      return;
    }
    const diffMs = Math.max(0, new Date(nextIso).getTime() - Date.now());
    if (diffMs === 0 && !this.isRunningPipeline()) {
      this.triggerPipelineRun(false, true);
      return;
    }
    const totalSec = Math.floor(diffMs / 1000);
    const hrs = String(Math.floor(totalSec / 3600)).padStart(2, '0');
    const mins = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
    const secs = String(totalSec % 60).padStart(2, '0');
    this.nextCycleCountdown.set(`${hrs}:${mins}:${secs}`);
  }

  /**
   * Renders the D3.js 7-day volume chart following heydamir/unslop Pass 7:
   * - Muted hairline grid (rgba(237, 237, 237, 0.06))
   * - Muted mono labels (#85858b), sentence case day labels
   * - One primary accent (#4cc38a) for the leading series / Today highlight,
   *   and calm neutral graphite steps (#3f3f44) for secondary comparison
   */
  private renderD3TrendsChart(
    svgEl: SVGSVGElement,
    data: DailyVolumeTrendPoint[],
  ): void {
    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    const width = 760;
    const height = 272;
    const margin = {top: 24, right: 20, bottom: 36, left: 36};
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    svg.attr('viewBox', `0 0 ${width} ${height}`);

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const x0 = d3
      .scaleBand<string>()
      .domain(data.map((d) => d.label))
      .range([0, innerWidth])
      .paddingInner(0.36)
      .paddingOuter(0.16);

    const x1 = d3
      .scaleBand<string>()
      .domain(['Hacker News', 'DEV.to'])
      .range([0, x0.bandwidth()])
      .padding(0.14);

    const maxVal = Math.max(
      24,
      d3.max(data, (d) =>
        Math.max(d.totalCount, d.hackerNewsCount, d.devtoCount),
      ) || 24,
    );

    const y = d3
      .scaleLinear()
      .domain([0, Math.ceil(maxVal * 1.18)])
      .nice()
      .range([innerHeight, 0]);

    // Muted 1px gridlines
    const yAxisGrid = d3
      .axisLeft(y)
      .ticks(4)
      .tickSize(-innerWidth)
      .tickFormat(() => '');

    g.append('g')
      .call(yAxisGrid)
      .call((sel) => sel.select('.domain').remove())
      .call((sel) =>
        sel.selectAll('line').attr('stroke', 'rgba(237, 237, 237, 0.06)'),
      );

    // Y Axis labels in muted mono (#85858b)
    g.append('g')
      .call(d3.axisLeft(y).ticks(4))
      .call((sel) => sel.select('.domain').remove())
      .call((sel) => sel.selectAll('line').remove())
      .call((sel) =>
        sel
          .selectAll('text')
          .attr('fill', '#85858b')
          .attr('font-family', 'IBM Plex Mono, monospace')
          .attr('font-size', '11px'),
      );

    // X Axis labels in sentence case
    g.append('g')
      .attr('transform', `translate(0,${innerHeight})`)
      .call(d3.axisBottom(x0).tickSize(0))
      .call((sel) =>
        sel.select('.domain').attr('stroke', 'rgba(237, 237, 237, 0.08)'),
      )
      .call((sel) =>
        sel
          .selectAll('text')
          .attr('dy', '1.5em')
          .attr('fill', (d) =>
            String(d).startsWith('Today') ? '#ededed' : '#85858b',
          )
          .attr('font-family', 'IBM Plex Mono, monospace')
          .attr('font-size', '11px')
          .attr('font-weight', (d) =>
            String(d).startsWith('Today') ? '500' : '400',
          ),
      );

    const dayGroups = g
      .selectAll('.day-group')
      .data(data)
      .enter()
      .append('g')
      .attr('class', 'day-group')
      .attr('transform', (d) => `translate(${x0(d.label) || 0},0)`)
      .style('cursor', 'pointer')
      .on('mouseenter', (_event, d) => {
        this.hoveredTrendPoint.set(d);
      })
      .on('mouseleave', () => {
        this.hoveredTrendPoint.set(null);
      });

    // Subtle surface step for Today column
    dayGroups
      .append('rect')
      .attr('x', -6)
      .attr('y', 0)
      .attr('width', x0.bandwidth() + 12)
      .attr('height', innerHeight)
      .attr('rx', 6)
      .attr('fill', (d) =>
        d.isToday ? 'rgba(237, 237, 237, 0.03)' : 'transparent',
      );

    // Leading series: Hacker News (#4cc38a toned semantic accent)
    dayGroups
      .append('rect')
      .attr('x', () => x1('Hacker News') || 0)
      .attr('y', (d) => y(d.hackerNewsCount))
      .attr('width', x1.bandwidth())
      .attr('height', (d) => Math.max(0, innerHeight - y(d.hackerNewsCount)))
      .attr('rx', 3)
      .attr('fill', '#4cc38a')
      .attr('fill-opacity', (d) => (d.isToday ? 1 : 0.82));

    // Secondary series: DEV.to (quiet graphite step #52525b)
    dayGroups
      .append('rect')
      .attr('x', () => x1('DEV.to') || 0)
      .attr('y', (d) => y(d.devtoCount))
      .attr('width', x1.bandwidth())
      .attr('height', (d) => Math.max(0, innerHeight - y(d.devtoCount)))
      .attr('rx', 3)
      .attr('fill', '#52525b');

    // Total daily volume smooth line (#ededed)
    const lineGen = d3
      .line<DailyVolumeTrendPoint>()
      .x((d) => (x0(d.label) || 0) + x0.bandwidth() / 2)
      .y((d) => y(d.totalCount))
      .curve(d3.curveMonotoneX);

    g.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', '#ededed')
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', 0.9)
      .attr('d', lineGen);

    const nodes = g
      .selectAll('.trend-node')
      .data(data)
      .enter()
      .append('g')
      .attr(
        'transform',
        (d) =>
          `translate(${(x0(d.label) || 0) + x0.bandwidth() / 2},${y(d.totalCount)})`,
      );

    nodes
      .append('circle')
      .attr('r', 3.5)
      .attr('fill', (d) => (d.isToday ? '#4cc38a' : '#19191b'))
      .attr('stroke', '#ededed')
      .attr('stroke-width', 1.5);

    nodes
      .append('text')
      .attr('y', -9)
      .attr('text-anchor', 'middle')
      .attr('fill', (d) => (d.isToday ? '#ededed' : '#a1a1a6'))
      .attr('font-family', 'IBM Plex Mono, monospace')
      .attr('font-size', '11px')
      .attr('font-weight', '400')
      .text((d) => `${d.totalCount}`);
  }

  loadPipelineState(autoRunIfEmpty = false, silent = false): void {
    if (!silent) {
      this.isLoadingState.set(true);
    }
    this.http.get<PipelineStateResponse>('/api/pipeline/state').subscribe({
      next: (data) => {
        this.scheduler.set(data.scheduler);
        if (data.geminiSecretConfigured !== undefined) {
          this.geminiSecretActive.set(data.geminiSecretConfigured);
        }
        if (data.githubPatConfigured !== undefined) {
          this.githubPatActive.set(data.githubPatConfigured);
        }
        if (
          data.githubRepo &&
          this.githubRepoControl.value === 'iTzinvi-dev/aUtoActiVity'
        ) {
          this.githubRepoControl.setValue(data.githubRepo, {emitEvent: false});
        }
        if (data.firebaseProjectId) {
          this.firebaseProjectId.set(data.firebaseProjectId);
        }
        this.telegramConfigured.set(data.telegramConfigured);
        if (data.telegramSync) {
          this.telegramSync.set(data.telegramSync);
        }
        this.processedStore.set(data.processedStore);
        this.digests.set(data.digests || []);
        if (data.weeklyTrends) {
          this.weeklyTrends.set(data.weeklyTrends);
        }
        this.logs.set(data.logs || []);
        this.pythonFiles.set(data.pythonFiles || []);
        this.updateCountdownClock();

        const currentChatInput =
          this.pipelineForm.controls.telegramChatId.value;

        this.pipelineForm.patchValue(
          {
            outputLanguage:
              data.scheduler.outputLanguage === 'Bengali'
                ? 'Bengali'
                : 'English',
            hnLimit: data.scheduler.hnTopLimit || 5,
            devtoLimit: data.scheduler.devtoTopLimit || 5,
            intervalHours: data.scheduler.intervalHours || 6,
            dailyRunTime: data.scheduler.dailyRunTime || '',
            telegramChatId: currentChatInput || data.telegramSync?.chatId || '',
            autoSendTelegram: data.telegramSync?.autoSend ?? true,
          },
          {emitEvent: false},
        );

        this.isLoadingState.set(false);

        if (autoRunIfEmpty && (!data.digests || data.digests.length === 0)) {
          this.triggerPipelineRun(true);
        }
      },
      error: (err) => {
        this.isLoadingState.set(false);
        if (!silent) {
          this.statusBanner.set({
            type: 'error',
            message:
              err?.error?.error || 'Could not load pipeline state from server',
          });
        }
      },
    });
  }

  setSection(section: 'digest' | 'telegram' | 'codebase' | 'logs'): void {
    this.activeSection.set(section);
  }

  setSourceFilter(filter: 'all' | 'Hacker News' | 'DEV.to'): void {
    this.sourceFilter.set(filter);
  }

  setCategoryFilter(category: string): void {
    this.categoryFilter.set(category);
  }

  toggleCategoryFilter(category: string): void {
    if (this.categoryFilter() === category) {
      this.categoryFilter.set('all');
    } else {
      this.categoryFilter.set(category);
    }
  }

  selectDigestRun(index: number): void {
    this.selectedDigestIndex.set(index);
    this.categoryFilter.set('all');
  }

  selectPythonFile(filename: string): void {
    this.selectedFileName.set(filename);
  }

  setOutputLanguage(lang: 'English' | 'Bengali'): void {
    this.pipelineForm.controls.outputLanguage.setValue(lang);
  }

  selectDiscoveredChat(chatId: string): void {
    this.pipelineForm.controls.telegramChatId.setValue(chatId);
    this.syncTelegramBotAndAutoSend();
  }

  syncTelegramBotAndAutoSend(): void {
    if (this.isSyncingTelegram()) return;
    const formVal = this.pipelineForm.getRawValue();
    const token = formVal.telegramBotToken.trim();

    if (!token && !this.telegramSync().hasBotToken) {
      this.statusBanner.set({
        type: 'error',
        message: 'Enter a Telegram Bot token from @BotFather to sync',
      });
      return;
    }

    this.isSyncingTelegram.set(true);
    this.statusBanner.set({
      type: 'info',
      message:
        'Verifying bot token, discovering all /start subscribers, and broadcasting latest digest',
    });

    this.http
      .post<{
        ok: boolean;
        error?: string;
        telegramSync?: TelegramSyncConfig;
        autoDispatchResult?: {
          delivered: boolean;
          chunks_sent: number;
          message_ids: number[];
          reason?: string;
          recipients_count?: number;
        } | null;
      }>('/api/pipeline/sync-telegram', {
        telegramBotToken: token,
        telegramChatId: formVal.telegramChatId.trim(),
        autoSend: formVal.autoSendTelegram,
      })
      .subscribe({
        next: (res) => {
          this.isSyncingTelegram.set(false);
          if (res.telegramSync) {
            this.telegramSync.set(res.telegramSync);
            this.pipelineForm.patchValue(
              {
                telegramBotToken: '',
                telegramChatId: res.telegramSync.chatId,
              },
              {emitEvent: false},
            );
          }

          const subCount =
            res.autoDispatchResult?.recipients_count ||
            res.telegramSync?.discoveredChats?.length ||
            0;
          if (res.autoDispatchResult?.delivered) {
            this.statusBanner.set({
              type: 'success',
              message: `Synced @${res.telegramSync?.botUsername} and broadcasted digest to ${subCount} subscriber(s)`,
            });
          } else if (res.telegramSync?.verified && subCount === 0) {
            this.statusBanner.set({
              type: 'info',
              message: `Verified @${res.telegramSync.botUsername}. Anyone who sends /start to the bot on Telegram will receive every 6h broadcast`,
            });
          } else if (
            res.autoDispatchResult &&
            !res.autoDispatchResult.delivered
          ) {
            this.statusBanner.set({
              type: 'error',
              message:
                res.autoDispatchResult.reason ||
                'Bot verified, but Telegram rejected message delivery',
            });
          } else {
            this.statusBanner.set({
              type: 'success',
              message: `Synced @${res.telegramSync?.botUsername} with ${subCount} active subscriber(s)`,
            });
          }

          this.loadPipelineState(false, true);
          if (this.currentUser()) {
            this.syncAllToFirestore(false);
          }
        },
        error: (err) => {
          this.isSyncingTelegram.set(false);
          this.statusBanner.set({
            type: 'error',
            message:
              err?.error?.error || 'Could not verify Telegram bot credentials',
          });
        },
      });
  }

  triggerPipelineRun(isStartupRun = false, forceFresh6h = false): void {
    if (this.isRunningPipeline()) return;
    this.isRunningPipeline.set(true);

    const formVal = this.pipelineForm.getRawValue();
    this.statusBanner.set({
      type: 'info',
      message: isStartupRun
        ? 'Running initial startup cycle across Hacker News and DEV.to'
        : `Fetching latest 6h stories in ${formVal.outputLanguage} and dispatching to Telegram`,
    });

    this.http
      .post<{
        runRecord: DigestRunRecord | null;
        newItemsCount: number;
        skippedByDedup: boolean;
      }>('/api/pipeline/run', {
        outputLanguage: formVal.outputLanguage,
        hnLimit: formVal.hnLimit,
        devtoLimit: formVal.devtoLimit,
        ignoreDedup: forceFresh6h || formVal.ignoreDedup,
        telegramBotToken: formVal.telegramBotToken,
        telegramChatId: formVal.telegramChatId,
      })
      .subscribe({
        next: (res) => {
          this.isRunningPipeline.set(false);
          this.selectedDigestIndex.set(0);
          const delivered = res.runRecord?.telegram_delivery?.delivered;
          const tgNote = delivered
            ? ` and sent ${res.runRecord?.telegram_delivery.chunks_sent} chunk(s) to Telegram`
            : '';

          this.statusBanner.set({
            type: 'success',
            message: `Processed ${res.newItemsCount} latest 6h stories${tgNote}`,
          });
          this.loadPipelineState(false, true);
          if (this.currentUser()) {
            this.syncAllToFirestore(false);
          }
        },
        error: (err) => {
          this.isRunningPipeline.set(false);
          this.statusBanner.set({
            type: 'error',
            message:
              err?.error?.error ||
              'Pipeline execution encountered an error. Check logs for details',
          });
          this.loadPipelineState(false, true);
        },
      });
  }

  dispatchCurrentDigestToTelegram(): void {
    const digest = this.activeDigest();
    if (!digest || !digest.formatted_messages.length) return;

    this.isSendingTelegram.set(true);
    const formVal = this.pipelineForm.getRawValue();

    this.http
      .post<{
        delivered: boolean;
        chunks_sent: number;
        message_ids: number[];
        reason?: string;
      }>('/api/pipeline/send-telegram', {
        chunks: digest.formatted_messages,
        generatedAt: digest.generated_at,
        telegramBotToken: formVal.telegramBotToken,
        telegramChatId: formVal.telegramChatId,
      })
      .subscribe({
        next: (res) => {
          this.isSendingTelegram.set(false);
          if (res.delivered) {
            this.statusBanner.set({
              type: 'success',
              message: `Delivered ${res.chunks_sent} HTML digest chunk(s) to Telegram`,
            });
          } else {
            this.statusBanner.set({
              type: 'error',
              message:
                res.reason ||
                'Enter your Telegram Bot token and sync to deliver messages',
            });
          }
          this.loadPipelineState(false, true);
        },
        error: (err) => {
          this.isSendingTelegram.set(false);
          this.statusBanner.set({
            type: 'error',
            message:
              err?.error?.error || 'Could not dispatch digest to Telegram',
          });
        },
      });
  }

  getTelegramStatusIcon(run: DigestRunRecord): string {
    if (run.telegram_delivery?.delivered) {
      return 'check_circle';
    }
    if (this.telegramSync().verified && !this.telegramSync().chatId) {
      return 'schedule_send';
    }
    return 'error_outline';
  }

  getTelegramStatusLabel(run: DigestRunRecord): string {
    if (run.telegram_delivery?.delivered) {
      const chunks = run.telegram_delivery.chunks_sent || 1;
      const target = run.telegram_delivery.chat_id
        ? ` to ${run.telegram_delivery.chat_id}`
        : '';
      return `Sent to Telegram${target} (${chunks} chunk${chunks === 1 ? '' : 's'})`;
    }
    return run.telegram_delivery?.reason || 'Not sent to Telegram';
  }

  saveScheduleConfig(): void {
    const formVal = this.pipelineForm.getRawValue();
    this.http
      .post<{ok: boolean; scheduler: SchedulerState}>(
        '/api/pipeline/schedule',
        {
          intervalHours: formVal.intervalHours,
          dailyRunTime: formVal.dailyRunTime,
          outputLanguage: formVal.outputLanguage,
        },
      )
      .subscribe({
        next: (res) => {
          this.scheduler.set(res.scheduler);
          this.statusBanner.set({
            type: 'success',
            message: `Updated schedule to every ${res.scheduler.intervalHours}h (${res.scheduler.outputLanguage})`,
          });
          this.loadPipelineState(false, true);
          if (this.currentUser()) {
            this.syncAllToFirestore(false);
          }
        },
        error: (err) => {
          this.statusBanner.set({
            type: 'error',
            message:
              err?.error?.error || 'Could not update scheduler configuration',
          });
        },
      });
  }

  async signInForFirestoreVault(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) return;
    try {
      const ready = await ensureFirebaseInitialized();
      if (!ready) {
        this.statusBanner.set({
          type: 'error',
          message: 'Firebase runtime bootstrap is not configured on this server',
        });
        return;
      }
      const cred = await signInWithPopup(auth, googleProvider);
      this.currentUser.set(cred.user);
      await this.restoreFromFirestoreAndSync(cred.user, true);
    } catch (err) {
      this.statusBanner.set({
        type: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Google Sign-In failed for Firestore vault',
      });
    }
  }

  async signOutFromFirestoreVault(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) return;
    const ready = await ensureFirebaseInitialized();
    if (!ready) return;
    await signOut(auth);
    this.currentUser.set(null);
  }

  private sanitizeFirestoreId(raw: string): string {
    const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
    return cleaned || 'doc_1';
  }

  private async ensureUserProfileDoc(user: User): Promise<void> {
    const uid = this.sanitizeFirestoreId(user.uid);
    const userPath = `users/${uid}`;
    const userRef = doc(db, 'users', uid);
    try {
      const snap = await getDoc(userRef);
      const displayName = (
        user.displayName ||
        user.email ||
        'Pulse Operator'
      ).slice(0, 120);
      const role = 'owner';

      if (!snap.exists()) {
        await setDoc(userRef, {
          uid,
          displayName,
          role,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(userRef, {
          displayName,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, userPath);
    }
  }

  async restoreFromFirestoreAndSync(
    user: User,
    showSuccessBanner = false,
  ): Promise<void> {
    if (!isPlatformBrowser(this.platformId) || this.isSyncingFirestore()) return;
    this.isSyncingFirestore.set(true);
    const uid = this.sanitizeFirestoreId(user.uid);

    try {
      await this.ensureUserProfileDoc(user);

      // 1. Read existing TelegramVault, TelegramSubscribers, AutomationConfig & ProcessedItems from Firestore
      let vaultData: Record<string, unknown> | null = null;
      let configData: Record<string, unknown> | null = null;
      const restoredSubscribers: Record<string, unknown>[] = [];
      const restoredProcessedItems: Record<string, string> = {};

      try {
        const vaultSnap = await getDoc(doc(db, 'telegram_vaults', uid));
        if (vaultSnap.exists()) {
          vaultData = vaultSnap.data() as Record<string, unknown>;
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, `telegram_vaults/${uid}`);
      }

      try {
        const subQuery = query(
          collection(db, 'telegram_subscribers'),
          where('ownerId', '==', uid),
        );
        const subSnap = await getDocs(subQuery);
        subSnap.forEach((docSnap) => {
          restoredSubscribers.push(docSnap.data() as Record<string, unknown>);
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.LIST, 'telegram_subscribers');
      }

      try {
        const configSnap = await getDoc(doc(db, 'automation_configs', uid));
        if (configSnap.exists()) {
          configData = configSnap.data() as Record<string, unknown>;
        }
      } catch (err) {
        handleFirestoreError(
          err,
          OperationType.GET,
          `automation_configs/${uid}`,
        );
      }

      try {
        const procQuery = query(
          collection(db, 'processed_items'),
          where('ownerId', '==', uid),
        );
        const procSnap = await getDocs(procQuery);
        procSnap.forEach((docSnap) => {
          const d = docSnap.data();
          if (d['itemUid'] && d['processedAtIso']) {
            restoredProcessedItems[String(d['itemUid'])] = String(
              d['processedAtIso'],
            );
          }
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.LIST, 'processed_items');
      }

      // Restore encrypted vault, subscribers, and schedule into the Express 6h daemon
      if (
        vaultData ||
        restoredSubscribers.length > 0 ||
        configData ||
        Object.keys(restoredProcessedItems).length > 0
      ) {
        this.http
          .post('/api/pipeline/restore-from-firestore', {
            telegramVault: vaultData,
            telegramSubscribers: restoredSubscribers,
            automationConfig: configData,
            processedItems: restoredProcessedItems,
          })
          .subscribe({
            next: () => {
              this.loadPipelineState(false, true);
            },
          });
      }

      this.isSyncingFirestore.set(false);
      await this.syncAllToFirestore(showSuccessBanner);
    } catch {
      this.isSyncingFirestore.set(false);
    }
  }

  async syncAllToFirestore(showBanner = true): Promise<void> {
    const user = this.currentUser();
    if (!user || !isPlatformBrowser(this.platformId)) {
      if (showBanner) {
        await this.signInForFirestoreVault();
      }
      return;
    }

    if (this.isSyncingFirestore()) return;
    this.isSyncingFirestore.set(true);

    const uid = this.sanitizeFirestoreId(user.uid);
    let syncedDocs = 0;

    try {
      await this.ensureUserProfileDoc(user);
      syncedDocs++;

      // 1. Upsert Zero-Plaintext /telegram_vaults/{uid} (stores AES-256-GCM encryptedBotToken + botTokenMasked only)
      const tg = this.telegramSync();
      const formVal = this.pipelineForm.getRawValue();
      const encryptedBotToken = (tg.encryptedBotToken || '').slice(0, 1024);
      const botTokenMasked = (tg.botTokenMasked || '').slice(0, 64);
      const chatId = (formVal.telegramChatId || tg.chatId || '').slice(0, 128);
      const botUsername = (tg.botUsername || '').slice(0, 128);
      const botName = (tg.botName || '').slice(0, 128);
      const chatTitle = (tg.chatTitle || '').slice(0, 200);
      const subscribersCount = Math.min(
        100000,
        (tg.discoveredChats || []).length,
      );
      const lastSyncedIso = (
        tg.lastSyncedAt || new Date().toISOString()
      ).slice(0, 64);

      const vaultRef = doc(db, 'telegram_vaults', uid);
      try {
        const vaultSnap = await getDoc(vaultRef);
        if (!vaultSnap.exists()) {
          await setDoc(vaultRef, {
            ownerId: uid,
            encryptedBotToken,
            botTokenMasked,
            chatId,
            botUsername,
            botName,
            chatTitle,
            subscribersCount,
            geminiSecretConfigured: Boolean(this.geminiSecretActive()),
            autoSendEvery6h: Boolean(formVal.autoSendTelegram),
            verified: Boolean(tg.verified),
            lastSyncedIso,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          await updateDoc(vaultRef, {
            encryptedBotToken,
            botTokenMasked,
            chatId,
            botUsername,
            botName,
            chatTitle,
            subscribersCount,
            geminiSecretConfigured: Boolean(this.geminiSecretActive()),
            autoSendEvery6h: Boolean(formVal.autoSendTelegram),
            verified: Boolean(tg.verified),
            lastSyncedIso,
            updatedAt: serverTimestamp(),
          });
        }
        syncedDocs++;
      } catch (err) {
        handleFirestoreError(
          err,
          OperationType.WRITE,
          `telegram_vaults/${uid}`,
        );
      }

      // 2. Upsert all discovered /start subscribers into /telegram_subscribers/{subscriberId}
      for (const sub of (tg.discoveredChats || []).slice(0, 50)) {
        const subDocId = this.sanitizeFirestoreId(`${uid}_sub_${sub.id}`);
        const subRef = doc(db, 'telegram_subscribers', subDocId);
        const subChatId = String(sub.id).slice(0, 128);
        const subTitle = String(sub.title || `Subscriber ${sub.id}`).slice(
          0,
          200,
        );
        const subType = String(sub.type || 'private').slice(0, 32);
        const subUsername = String(sub.username || '').slice(0, 128);
        const subscribedAtIso = String(
          sub.subscribedAt || new Date().toISOString(),
        ).slice(0, 64);

        try {
          const subSnap = await getDoc(subRef);
          if (!subSnap.exists()) {
            await setDoc(subRef, {
              ownerId: uid,
              chatId: subChatId,
              title: subTitle,
              chatType: subType,
              username: subUsername,
              subscribedAtIso,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } else {
            await updateDoc(subRef, {
              title: subTitle,
              chatType: subType,
              username: subUsername,
              subscribedAtIso,
              updatedAt: serverTimestamp(),
            });
          }
          syncedDocs++;
        } catch (err) {
          handleFirestoreError(
            err,
            OperationType.WRITE,
            `telegram_subscribers/${subDocId}`,
          );
        }
      }

      // 3. Upsert /automation_configs/{uid}
      const sched = this.scheduler();
      const intervalHours = Math.max(
        1,
        Math.min(24, Number(formVal.intervalHours || sched.intervalHours || 6)),
      );
      const dailyRunTime = (formVal.dailyRunTime || sched.dailyRunTime || '')
        .trim()
        .slice(0, 32);
      const outputLanguage =
        formVal.outputLanguage === 'Bengali' ? 'Bengali' : 'English';
      const hnTopLimit = Math.max(
        1,
        Math.min(15, Number(formVal.hnLimit || sched.hnTopLimit || 5)),
      );
      const devtoTopLimit = Math.max(
        1,
        Math.min(15, Number(formVal.devtoLimit || sched.devtoTopLimit || 5)),
      );
      const lastRunIso = (sched.lastRunAt || '').slice(0, 64);
      const nextRunIso = (sched.nextRunAt || '').slice(0, 64);

      const configRef = doc(db, 'automation_configs', uid);
      try {
        const configSnap = await getDoc(configRef);
        if (!configSnap.exists()) {
          await setDoc(configRef, {
            ownerId: uid,
            intervalHours,
            dailyRunTime,
            outputLanguage,
            hnTopLimit,
            devtoTopLimit,
            autoSendTelegram: Boolean(formVal.autoSendTelegram),
            lastRunIso,
            nextRunIso,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          await updateDoc(configRef, {
            intervalHours,
            dailyRunTime,
            outputLanguage,
            hnTopLimit,
            devtoTopLimit,
            autoSendTelegram: Boolean(formVal.autoSendTelegram),
            lastRunIso,
            nextRunIso,
            updatedAt: serverTimestamp(),
          });
        }
        syncedDocs++;
      } catch (err) {
        handleFirestoreError(
          err,
          OperationType.WRITE,
          `automation_configs/${uid}`,
        );
      }

      // 4. Upsert recent DigestRuns (/digest_runs/{runId})
      const recentDigests = this.digests().slice(0, 10);
      for (const run of recentDigests) {
        const runId = this.sanitizeFirestoreId(
          `${uid}_run_${run.generated_at}`,
        );
        const runRef = doc(db, 'digest_runs', runId);
        const rawHtml = (run.formatted_messages?.[0] || run.editorial_headline)
          .replace(/\s*·\s*Model:\s*[^<\n]+/gi, '')
          .replace(/Model:\s*[a-zA-Z0-9._-]+/gi, '')
          .slice(0, 11800);
        const storiesSummaryText = (
          run.items
            .map((it) => `${it.category_tag} ${it.title} — ${it.takeaway}`)
            .join('\n') || run.editorial_headline
        ).slice(0, 19500);

        try {
          const runSnap = await getDoc(runRef);
          if (!runSnap.exists()) {
            await setDoc(runRef, {
              ownerId: uid,
              generatedAtIso: run.generated_at.slice(0, 64),
              outputLanguage:
                run.output_language === 'Bengali' ? 'Bengali' : 'English',
              editorialHeadline: (
                run.editorial_headline || 'Developer Pulse Digest'
              ).slice(0, 1000),
              itemsCount: Math.min(50, run.items.length),
              delivered: Boolean(run.telegram_delivery?.delivered),
              chunksSent: Math.min(
                500,
                Number(run.telegram_delivery?.chunks_sent || 0),
              ),
              targetChatId: (run.telegram_delivery?.chat_id || chatId).slice(
                0,
                128,
              ),
              deliveryReason: (run.telegram_delivery?.reason || '').slice(
                0,
                500,
              ),
              primaryMessageHtml: rawHtml || 'Global Developer Pulse',
              storiesSummaryText:
                storiesSummaryText || 'Global Developer Pulse',
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } else {
            await updateDoc(runRef, {
              delivered: Boolean(run.telegram_delivery?.delivered),
              chunksSent: Math.min(
                500,
                Number(run.telegram_delivery?.chunks_sent || 0),
              ),
              targetChatId: (run.telegram_delivery?.chat_id || chatId).slice(
                0,
                128,
              ),
              deliveryReason: (run.telegram_delivery?.reason || '').slice(
                0,
                500,
              ),
              primaryMessageHtml: rawHtml || 'Global Developer Pulse',
              storiesSummaryText:
                storiesSummaryText || 'Global Developer Pulse',
              updatedAt: serverTimestamp(),
            });
          }
          syncedDocs++;
        } catch (err) {
          handleFirestoreError(
            err,
            OperationType.WRITE,
            `digest_runs/${runId}`,
          );
        }
      }

      // 4. Upsert recent ProcessedItems (/processed_items/{itemId})
      const entries = this.processedEntriesList().slice(0, 25);
      for (const entry of entries) {
        const cleanItemUid = this.sanitizeFirestoreId(entry.uid);
        const docId = this.sanitizeFirestoreId(`${uid}_${cleanItemUid}`);
        const itemRef = doc(db, 'processed_items', docId);
        const source: 'Hacker News' | 'DEV.to' = entry.uid.startsWith('hn_')
          ? 'Hacker News'
          : 'DEV.to';

        try {
          const itemSnap = await getDoc(itemRef);
          if (!itemSnap.exists()) {
            await setDoc(itemRef, {
              ownerId: uid,
              itemUid: cleanItemUid,
              source,
              processedAtIso: entry.timestamp.slice(0, 64),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } else {
            await updateDoc(itemRef, {
              processedAtIso: entry.timestamp.slice(0, 64),
              updatedAt: serverTimestamp(),
            });
          }
          syncedDocs++;
        } catch (err) {
          handleFirestoreError(
            err,
            OperationType.WRITE,
            `processed_items/${docId}`,
          );
        }
      }

      const syncedIso = new Date().toISOString();
      this.firestoreLastSyncedAt.set(syncedIso);
      this.firestoreSyncedDocsCount.set(syncedDocs);
      this.isSyncingFirestore.set(false);

      if (showBanner) {
        this.statusBanner.set({
          type: 'success',
          message: `Synced ${syncedDocs} vault, schedule, digest, and deduplication documents to Firebase Firestore`,
        });
      }
    } catch {
      this.isSyncingFirestore.set(false);
    }
  }

  resetDeduplicationCache(): void {
    this.http.post('/api/pipeline/reset-dedup', {}).subscribe({
      next: () => {
        this.statusBanner.set({
          type: 'success',
          message: 'Cleared processed_ids.json deduplication store',
        });
        this.loadPipelineState(false, true);
      },
      error: (err) => {
        this.statusBanner.set({
          type: 'error',
          message: err?.error?.error || 'Could not reset processed_ids.json',
        });
      },
    });
  }

  pushCodebaseToGitHub(): void {
    if (this.isPushingGitHub()) return;
    this.isPushingGitHub.set(true);
    this.statusBanner.set({
      type: 'info',
      message:
        'Pushing entire codebase, 6h GitHub Actions workflow, and vercel.json to GitHub using GITHUB_PAT secret...',
    });

    this.http
      .post<{
        ok: boolean;
        repoFullName?: string;
        repoUrl?: string;
        branch?: string;
        commitSha?: string;
        filesPushed?: number;
        error?: string;
      }>('/api/pipeline/push-github', {
        repoName:
          this.githubRepoControl.value.trim() || 'iTzinvi-dev/aUtonEws',
      })
      .subscribe({
        next: (res) => {
          this.isPushingGitHub.set(false);
          if (res.repoUrl) {
            this.pushedGitHubUrl.set(res.repoUrl);
          }
          this.statusBanner.set({
            type: 'success',
            message: `Pushed ${res.filesPushed || 28} files to ${res.repoFullName} (${res.branch} @ ${res.commitSha?.slice(0, 7) || 'HEAD'})`,
          });
          this.loadPipelineState(false, true);
        },
        error: (err) => {
          this.isPushingGitHub.set(false);
          this.statusBanner.set({
            type: 'error',
            message:
              err?.error?.error ||
              'Failed pushing to GitHub. Check GITHUB_PAT in Settings > Secrets.',
          });
        },
      });
  }

  copyText(content: string, label: string): void {
    if (!isPlatformBrowser(this.platformId)) return;
    navigator.clipboard.writeText(content).then(() => {
      this.copiedLabel.set(label);
      setTimeout(() => {
        if (this.copiedLabel() === label) {
          this.copiedLabel.set(null);
        }
      }, 2000);
    });
  }

  downloadFile(filename: string, content: string): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const blob = new Blob([content], {type: 'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  formatTimestamp(iso: string | null | undefined): string {
    if (!iso) return 'Pending';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-US', {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
}
