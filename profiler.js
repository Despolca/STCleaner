/**
 * @fileoverview Startup API load time profiler for SillyTavern.
 * Uses browser native W3C Resource Timing API in an idle callback after APP_READY
 * so cold-start overhead is strictly < 1ms and zero fetch monkey-patching is required.
 */

export const BOOT_STORAGE_KEY = 'st_cleaner_boot_stats_v1';

/**
 * Safari / older WebView safe idle callback wrapper.
 * @param {(deadline: { timeRemaining: () => number }) => void} callback
 */
export function scheduleIdle(callback) {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(callback, { timeout: 2500 });
  } else {
    setTimeout(() => callback({ timeRemaining: () => 8 }), 32);
  }
}

/** @type {Array<{ id: string, label: string, targetCategory: string, targetSub?: string, color: string }>} */
export const BOOT_BUCKETS = [
  {
    id: 'characters',
    label: 'Thẻ nhân vật & Nhóm chat',
    targetCategory: 'characters',
    color: '#007aff',
  },
  {
    id: 'settings',
    label: 'Preset & Cấu hình cốt lõi',
    targetCategory: 'presets',
    color: '#5856d6',
  },
  {
    id: 'extensions',
    label: 'Script tiện ích bên thứ ba',
    targetCategory: 'extensions',
    targetSub: 'third_party_ext',
    color: '#32ade6',
  },
  {
    id: 'backgrounds',
    label: 'Hình nền & Tài nguyên media',
    targetCategory: 'personas',
    targetSub: 'backgrounds',
    color: '#34c759',
  },
  {
    id: 'chats_worlds',
    label: 'Phiên chat mặc định & Worldbook',
    targetCategory: 'chats',
    color: '#af52de',
  },
  {
    id: 'avatars_media',
    label: 'Avatar & Ảnh thu nhỏ',
    targetCategory: 'personas',
    targetSub: 'user_personas',
    color: '#ff9f0a',
  },
];

/**
 * Maps a resource URL to one of the 6 actionable startup buckets.
 * @param {string} rawUrl
 * @returns {string | null}
 */
export function classifyBootResource(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const url = rawUrl.toLowerCase();

  if (
    url.includes('api/characters/all') ||
    url.includes('api/characters/get') ||
    url.includes('api/groups/all')
  ) {
    return 'characters';
  }

  if (url.includes('api/settings/get')) {
    return 'settings';
  }

  if (
    url.includes('api/extensions/discover') ||
    url.includes('/scripts/extensions/third-party/')
  ) {
    return 'extensions';
  }

  if (
    url.includes('api/backgrounds/all') ||
    url.includes('api/backgrounds/folders')
  ) {
    return 'backgrounds';
  }

  if (
    url.includes('api/chats/get') ||
    url.includes('api/chats/group/get') ||
    url.includes('api/worldinfo/get') ||
    url.includes('api/worldinfo/list')
  ) {
    return 'chats_worlds';
  }

  if (
    url.includes('api/avatars/get') ||
    url.includes('/thumbnail') ||
    url.includes('/user%20avatars/') ||
    url.includes('/characters/') ||
    url.includes('/backgrounds/')
  ) {
    return 'avatars_media';
  }

  return null;
}

/**
 * Merges overlapping [start, end] intervals so parallel requests report true wall-clock blocking span.
 * @param {Array<[number, number]>} intervals
 * @returns {number}
 */
export function mergeIntervalsDuration(intervals) {
  if (!Array.isArray(intervals) || intervals.length === 0) return 0;
  const valid = intervals
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e >= s)
    .sort((a, b) => a[0] - b[0]);

  if (valid.length === 0) return 0;

  let total = 0;
  let [curStart, curEnd] = valid[0];

  for (let i = 1; i < valid.length; i++) {
    const [nextStart, nextEnd] = valid[i];
    if (nextStart <= curEnd) {
      if (nextEnd > curEnd) curEnd = nextEnd;
    } else {
      total += curEnd - curStart;
      curStart = nextStart;
      curEnd = nextEnd;
    }
  }
  total += curEnd - curStart;
  return Math.round(total);
}

/**
 * Shortens a full resource URL into a clean readable endpoint or asset path.
 * @param {string} rawUrl
 * @returns {string}
 */
export function shortenResourceName(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return 'Tài nguyên không xác định';
  try {
    const u = s.startsWith('http://') || s.startsWith('https://')
      ? new URL(s)
      : new URL(s, 'http://localhost');
    const pathPart = decodeURIComponent(u.pathname || '').replace(/^\/+/, '');
    return pathPart.length > 56 ? `...${pathPart.slice(-54)}` : (pathPart || s);
  } catch {
    return s.length > 56 ? `...${s.slice(-54)}` : s;
  }
}

/**
 * Collects startup metrics, navigation phases, and top slowest requests from Performance API entries.
 * @param {object} [perfObj] Optional performance mock for unit tests
 */
export function collectStartupSnapshot(perfObj = typeof performance !== 'undefined' ? performance : null) {
  const nowTs = Date.now();
  if (!perfObj || typeof perfObj.getEntriesByType !== 'function') {
    return {
      timestamp: nowTs,
      timeOrigin: nowTs,
      totalMs: 0,
      totalBytes: 0,
      phases: { ttfbMs: 0, domReadyMs: 0, resourceSpanMs: 0, requestCount: 0 },
      slowestResources: [],
      buckets: BOOT_BUCKETS.map((b) => ({ ...b, durationMs: 0, count: 0, bytes: 0 })),
    };
  }

  let resources = [];
  let navEntries = [];
  try {
    resources = Array.isArray(perfObj.getEntriesByType('resource')) ? perfObj.getEntriesByType('resource') : [];
    navEntries = Array.isArray(perfObj.getEntriesByType('navigation')) ? perfObj.getEntriesByType('navigation') : [];
  } catch {
    resources = [];
    navEntries = [];
  }

  /** @type {Record<string, { intervals: Array<[number, number]>, count: number, bytes: number }>} */
  const acc = {};
  for (const b of BOOT_BUCKETS) {
    acc[b.id] = { intervals: [], count: 0, bytes: 0 };
  }

  let maxEnd = 0;
  let totalBytes = 0;
  const allIntervals = [];
  const resourceCandidates = [];

  for (const entry of resources) {
    if (!entry || typeof entry !== 'object') continue;
    const start = Math.max(0, Number(entry.startTime) || 0);
    const rawEnd = Number(entry.responseEnd) || start + (Number(entry.duration) || 0);
    const end = Math.max(start, rawEnd);
    const dur = Math.round(end - start);
    if (end > maxEnd) maxEnd = end;

    const bytes = Math.max(
      Number(entry.decodedBodySize) || 0,
      Number(entry.transferSize) || 0,
      Number(entry.encodedBodySize) || 0
    );
    totalBytes += bytes;
    allIntervals.push([start, end]);

    const bucketId = classifyBootResource(entry.name);
    if (bucketId && acc[bucketId]) {
      acc[bucketId].intervals.push([start, end]);
      acc[bucketId].count += 1;
      acc[bucketId].bytes += bytes;
    }

    if (dur >= 5 || bytes >= 32 * 1024) {
      resourceCandidates.push({
        shortName: shortenResourceName(entry.name),
        bucketId: bucketId || 'other',
        durationMs: dur,
        bytes,
      });
    }
  }

  resourceCandidates.sort((a, b) => b.durationMs - a.durationMs || b.bytes - a.bytes);
  const slowestResources = resourceCandidates.slice(0, 6);

  const nav = navEntries[0] || null;
  const navEnd = nav ? Number(nav.loadEventEnd || nav.domComplete || 0) : 0;
  const ttfbMs = nav ? Math.max(0, Math.round((Number(nav.responseStart) || 0) - (Number(nav.requestStart) || 0))) : 0;
  const domReadyMs = nav ? Math.max(0, Math.round(Number(nav.domContentLoadedEventEnd || nav.domInteractive || 0))) : 0;
  const resourceSpanMs = mergeIntervalsDuration(allIntervals);
  const totalMs = Math.max(Math.round(maxEnd), Math.round(navEnd), 0);

  const buckets = BOOT_BUCKETS.map((b) => {
    const item = acc[b.id];
    return {
      ...b,
      durationMs: mergeIntervalsDuration(item.intervals),
      count: item.count,
      bytes: item.bytes,
    };
  }).sort((a, b) => b.durationMs - a.durationMs);

  return {
    timestamp: nowTs,
    timeOrigin: Math.round(Number(perfObj.timeOrigin) || nowTs),
    totalMs,
    totalBytes,
    phases: {
      ttfbMs,
      domReadyMs,
      resourceSpanMs,
      requestCount: resources.length,
    },
    slowestResources,
    buckets,
  };
}

/**
 * Reads persisted current & previous boot snapshots.
 * @param {Storage} [storage]
 * @returns {{ currentBoot: any | null, previousBoot: any | null }}
 */
export function readBootHistory(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
  if (!storage) return { currentBoot: null, previousBoot: null };
  try {
    const raw = storage.getItem(BOOT_STORAGE_KEY);
    if (!raw) return { currentBoot: null, previousBoot: null };
    const parsed = JSON.parse(raw);
    return {
      currentBoot: parsed?.currentBoot || null,
      previousBoot: parsed?.previousBoot || null,
    };
  } catch {
    return { currentBoot: null, previousBoot: null };
  }
}

/**
 * Reads rolling 6-entry startup trend history from storage.
 * @param {Storage} [storage]
 * @returns {Array<{ timestamp: number, timeOrigin: number, totalMs: number, totalBytes: number }>}
 */
export function readBootTrend(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
  if (!storage) return [];
  try {
    const raw = storage.getItem(BOOT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.history) && parsed.history.length > 0) {
      return parsed.history.slice(-6);
    }
    const fallback = [];
    if (parsed?.previousBoot?.totalMs) {
      fallback.push({
        timestamp: parsed.previousBoot.timestamp || 0,
        timeOrigin: parsed.previousBoot.timeOrigin || 0,
        totalMs: parsed.previousBoot.totalMs,
        totalBytes: parsed.previousBoot.totalBytes || 0,
      });
    }
    if (parsed?.currentBoot?.totalMs) {
      fallback.push({
        timestamp: parsed.currentBoot.timestamp || 0,
        timeOrigin: parsed.currentBoot.timeOrigin || 0,
        totalMs: parsed.currentBoot.totalMs,
        totalBytes: parsed.currentBoot.totalBytes || 0,
      });
    }
    return fallback;
  } catch {
    return [];
  }
}

/**
 * Records current boot snapshot once per page navigation (timeOrigin), keeping a 6-entry rolling trend.
 * @param {object} [perfObj]
 * @param {Storage} [storage]
 */
export function recordBootSnapshotOnce(
  perfObj = typeof performance !== 'undefined' ? performance : null,
  storage = typeof localStorage !== 'undefined' ? localStorage : null
) {
  if (!storage || !perfObj) return null;
  const snapshot = collectStartupSnapshot(perfObj);
  const existing = readBootHistory(storage);
  const existingTrend = readBootTrend(storage);
  const summaryEntry = {
    timestamp: snapshot.timestamp,
    timeOrigin: snapshot.timeOrigin,
    totalMs: snapshot.totalMs,
    totalBytes: snapshot.totalBytes,
  };

  if (existing.currentBoot && existing.currentBoot.timeOrigin === snapshot.timeOrigin) {
    const oldApiSum = (existing.currentBoot.buckets || []).reduce((s, b) => s + (b.durationMs || 0), 0);
    const newApiSum = (snapshot.buckets || []).reduce((s, b) => s + (b.durationMs || 0), 0);
    if (newApiSum < oldApiSum) {
      return existing;
    }
    const nextHistory = existingTrend.filter((h) => h.timeOrigin !== snapshot.timeOrigin);
    nextHistory.push(summaryEntry);
    const updated = {
      currentBoot: snapshot,
      previousBoot: existing.previousBoot,
      history: nextHistory.slice(-6),
    };
    try {
      storage.setItem(BOOT_STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // Ignore quota errors
    }
    return updated;
  }

  const nextHistory = existingTrend.filter((h) => h.timeOrigin !== snapshot.timeOrigin);
  nextHistory.push(summaryEntry);
  const nextState = {
    currentBoot: snapshot,
    previousBoot: existing.currentBoot || existing.previousBoot || null,
    history: nextHistory.slice(-6),
  };

  try {
    storage.setItem(BOOT_STORAGE_KEY, JSON.stringify(nextState));
  } catch {
    // Ignore quota errors
  }
  return nextState;
}

/**
 * Formats milliseconds into concise human-readable string (e.g., "1.42 s" or "85 ms").
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const n = Number(ms) || 0;
  if (n >= 1000) return `${(n / 1000).toFixed(2)} s`;
  return `${Math.round(n)} ms`;
}

/**
 * Formats byte count into KB / MB / GB.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Mounts the collapsible settings drawer inside #extensions_settings2 / #extensions_settings.
 */
export function mountSettingsDrawer({ drawerId, getCfg, onToggle, onOpen, bootMs }) {
  const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
  if (!host) return false;
  let wrap = document.getElementById(drawerId);
  if (!wrap) {
    const c = getCfg();
    const chk = (k, label) =>
      `<label class="st-cleaner-setting-row"><span>${label}</span><input type="checkbox" data-k="${k}" ${c[k] ? 'checked' : ''}></label>`;
    wrap = document.createElement('div');
    wrap.id = drawerId;
    wrap.className = 'inline-drawer st-cleaner-settings-drawer';
    wrap.innerHTML = `
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>Dọn dẹp dữ liệu & Chẩn đoán khởi động (ST-Cleaner)</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content st-cleaner-drawer-body">
        ${chk('enabled', 'Bật/tắt tổng tiện ích')}
        ${chk('showWandButton', 'Hiển thị lối tắt trong menu Đũa phép góc dưới bên trái')}
        ${chk('enableBootProfiler', 'Ghi nhận ngầm so sánh thời gian khởi động')}
        <div class="st-cleaner-boot-hint" data-hint>${bootMs ? `Thời gian khởi động gần nhất: ${formatDuration(bootMs)}` : 'Thu thập ngầm thời gian khởi động sau khi sẵn sàng'}</div>
        <div class="menu_button menu_button_icon interactable" data-open><i class="fa-solid fa-broom"></i><span>Mở Trung tâm Dọn dẹp Dữ liệu</span></div>
      </div>`;
    wrap.addEventListener('change', (ev) => {
      const k = ev.target?.dataset?.k;
      if (k) onToggle(k, Boolean(ev.target.checked));
    });
    wrap.querySelector('[data-open]')?.addEventListener('click', onOpen);
    host.appendChild(wrap);
  } else if (bootMs) {
    const hint = wrap.querySelector('[data-hint]');
    if (hint) hint.textContent = `Thời gian khởi động gần nhất: ${formatDuration(bootMs)}`;
  }
  return true;
}

/**
 * Computes a fast (<1ms), non-blocking health score, runtime telemetry, and actionable cleanup prescriptions
 * from live SillyTavern context, startup resource timing, and any scanned category records.
 *
 * @param {object} [params]
 * @param {any} [params.ctx]
 * @param {any} [params.settingsSnapshot]
 * @param {any} [params.bootSnapshot]
 * @param {Map<string, any> | Record<string, any>} [params.cachedCategories]
 * @param {any} [params.perfObj]
 */
export function analyzeTavernHealth(params = {}) {
  const ctx = params.ctx || {};
  const boot = params.bootSnapshot || null;
  const perfObj = params.perfObj !== undefined ? params.perfObj : (typeof performance !== 'undefined' ? performance : null);
  const getCat = (cid) => {
    if (!params.cachedCategories) return null;
    if (typeof params.cachedCategories.get === 'function') return params.cachedCategories.get(cid) || null;
    return params.cachedCategories[cid] || null;
  };

  const characters = Array.isArray(ctx?.characters) ? ctx.characters.filter(Boolean) : [];
  const extSettings = ctx?.extensionSettings || ctx?.extension_settings || {};
  const charCount = characters.length;
  const shallowCount = characters.filter((c) => c?.shallow === true).length;
  const lazyLoadEnabled = shallowCount > 0;

  const globalRegexArr = Array.isArray(extSettings?.regex) ? extSettings.regex.filter(Boolean) : [];
  const enabledGlobalRegex = globalRegexArr.filter((r) => !r.disabled).length;
  const disabledGlobalRegex = globalRegexArr.filter((r) => r.disabled).length;

  let activeCharRegex = 0;
  const activeIdx = ctx?.characterId !== undefined && ctx?.characterId !== null && ctx?.characterId !== '' ? Number(ctx.characterId) : -1;
  const activeChar = activeIdx >= 0 ? characters[activeIdx] : null;
  if (Array.isArray(activeChar?.data?.extensions?.regex_scripts)) {
    activeCharRegex = activeChar.data.extensions.regex_scripts.filter((r) => r && !r.disabled).length;
  }

  const jsHeapUsedBytes = Number(perfObj?.memory?.usedJSHeapSize) || 0;
  const totalBootMs = Number(boot?.totalMs) || 0;
  const totalBootBytes = Number(boot?.totalBytes) || 0;

  let score = 100;
  /** @type {Array<{ level: 'warn' | 'info' | 'good', title: string, detail: string, targetCategory?: string, targetSub?: string, targetFacet?: string, actionLabel?: string }>} */
  const findings = [];

  // 1. Boot duration diagnosis
  if (totalBootMs > 4500) {
    score -= 18;
    const topSlow = Array.isArray(boot?.buckets) && boot.buckets[0]?.durationMs > 0 ? boot.buckets[0] : null;
    findings.push({
      level: 'warn',
      title: `Thời gian khởi động hơi chậm (${formatDuration(totalBootMs)})`,
      detail: topSlow
        ? `Màn hình đầu chủ yếu bị nghẽn ở "${topSlow.label}" (${formatDuration(topSlow.durationMs)}), nên tinh gọn tài sản dư thừa.`
        : 'Các API dữ liệu và tài nguyên tĩnh màn hình đầu phản hồi hơi chậm, nên kiểm tra các thẻ nhân vật dung lượng lớn hoặc tiện ích dư thừa.',
      targetCategory: topSlow?.targetCategory || 'characters',
      targetSub: topSlow?.targetSub || 'all',
      actionLabel: 'Đi kiểm tra',
    });
  } else if (totalBootMs > 2200) {
    score -= 8;
  }

  // 2. Character volume & Lazy-Load diagnosis
  if (charCount >= 80 && !lazyLoadEnabled) {
    score -= 14;
    findings.push({
      level: 'warn',
      title: `Đã tải toàn bộ ${charCount} thẻ nhân vật (chưa bật Lazy Load)`,
      detail: 'Khi có nhiều thẻ nhân vật, việc phân tích toàn bộ sẽ làm chậm /api/characters/all và tăng mức chiếm RAM. Bạn có thể bật lazyLoadCharacters trong config.yaml hoặc dọn các thẻ bỏ không.',
      targetCategory: 'characters',
      targetSub: 'char_cards',
      targetFacet: 'char:idle',
      actionLabel: 'Lọc nhân vật nhàn rỗi',
    });
  } else if (charCount >= 200) {
    score -= 8;
    findings.push({
      level: 'info',
      title: `Thư viện nhân vật khá lớn (${charCount} thẻ)`,
      detail: 'Có thể lọc theo thẻ tag hoặc sắp xếp theo "Bản cũ nhất trước" để định kỳ dọn các bản sao không còn dùng.',
      targetCategory: 'characters',
      targetSub: 'char_cards',
      targetFacet: 'char:idle',
      actionLabel: 'Dọn thẻ nhân vật',
    });
  }

  // 3. Real-time regex overhead diagnosis
  const totalActiveRegex = enabledGlobalRegex + activeCharRegex;
  if (totalActiveRegex >= 25) {
    score -= 10;
    findings.push({
      level: 'warn',
      title: `Đang chạy đồng thời ${totalActiveRegex} Regex script`,
      detail: 'Mỗi lần hiển thị tin nhắn và xuất luồng (streaming), toàn bộ Regex đang bật sẽ chạy tuần tự. Tắt hoặc dọn bớt các script không dùng sẽ cải thiện rõ rệt độ mượt khung hình.',
      targetCategory: 'regex',
      targetSub: 'all',
      targetFacet: 'rx:enabled',
      actionLabel: 'Kiểm tra Regex đang bật',
    });
  }

  // 4. Scanned / Deep Check Redundancy Findings
  const wiRec = getCat('worldinfo');
  if (wiRec) {
    const unboundCount = wiRec.groups?.find((g) => g.id === 'wi_unbound')?.items?.length || 0;
    if (unboundCount > 0) {
      score -= Math.min(10, Math.ceil(unboundCount / 3) * 2);
      findings.push({
        level: unboundCount >= 5 ? 'warn' : 'info',
        title: `Phát hiện ${unboundCount} Worldbook nhàn rỗi chưa gắn kết`,
        detail: 'Không được tham chiếu bởi thiết lập toàn cục, thẻ nhân vật hay Persona, có thể chọn xóa an toàn.',
        targetCategory: 'worldinfo',
        targetSub: 'wi_unbound',
        actionLabel: 'Xem ngay',
      });
    }
  }

  const rxRec = getCat('regex');
  const disabledRxTotal = rxRec
    ? (rxRec.facets?.find((f) => f.id === 'rx:disabled')?.count || 0)
    : disabledGlobalRegex;
  if (disabledRxTotal > 0) {
    score -= Math.min(8, Math.ceil(disabledRxTotal / 4) * 2);
    findings.push({
      level: 'info',
      title: `Phát hiện ${disabledRxTotal} Regex/Script trợ lý đã tắt`,
      detail: 'Các Regex và script bị tắt lâu ngày vẫn làm phình dung lượng đọc/ghi của settings.json.',
      targetCategory: 'regex',
      targetSub: 'all',
      targetFacet: 'rx:disabled',
      actionLabel: 'Lọc mục đã tắt',
    });
  }

  const extRec = getCat('extensions');
  if (extRec) {
    const orphanCount = extRec.groups?.find((g) => g.id === 'data_maid')?.items?.length || 0;
    const backupCount = extRec.groups?.find((g) => g.id === 'chat_backups')?.items?.length || 0;
    const vectorCount = extRec.groups?.find((g) => g.id === 'vectors')?.items?.length || 0;
    const cacheTotal = orphanCount + backupCount + vectorCount;
    if (cacheTotal > 0) {
      score -= Math.min(12, orphanCount > 0 ? 6 + Math.min(6, Math.floor(cacheTotal / 5)) : 4);
      findings.push({
        level: orphanCount > 0 ? 'warn' : 'info',
        title: `Phát hiện ${cacheTotal} mục cache/sao lưu/tệp mồ côi`,
        detail: `Gồm ${orphanCount} tệp mồ côi, ${backupCount} bản sao lưu chat và ${vectorCount} nhóm vector cache. Dọn dẹp giúp giải phóng dung lượng ổ đĩa.`,
        targetCategory: 'extensions',
        targetSub: 'all',
        targetFacet: 'ext:cache_orphan',
        actionLabel: 'Dọn tệp dư thừa',
      });
    }
  }

  const chatRec = getCat('chats');
  if (chatRec) {
    const shortChatCount = chatRec.facets?.find((f) => f.id === 'chat:short_test')?.count || 0;
    const branchCount = chatRec.facets?.find((f) => f.id === 'chat:branch')?.count || 0;
    if (shortChatCount > 0) {
      score -= Math.min(6, Math.ceil(shortChatCount / 5) * 2);
      findings.push({
        level: 'info',
        title: `Phát hiện ${shortChatCount} phiên chat thử nghiệm cực ngắn (≤2 tin nhắn)`,
        detail: `Ngoài ra còn có ${branchCount} phiên nhánh lịch sử không phải luồng chính, có thể lọc nhanh để dọn bản rác.`,
        targetCategory: 'chats',
        targetSub: 'char_chats',
        targetFacet: 'chat:short_test',
        actionLabel: 'Lọc chat rác ngắn',
      });
    }
  }

  const mediaRec = getCat('media');
  if (mediaRec) {
    const emptyTagCount = mediaRec.facets?.find((f) => f.id === 'tag_state:empty')?.count || 0;
    if (emptyTagCount > 0) {
      score -= 2;
      findings.push({
        level: 'info',
        title: `Có ${emptyTagCount} thẻ tag trống chưa gắn nhân vật`,
        detail: 'Các thẻ tag bỏ trống không gắn với nhân vật nào, dọn đi giúp thanh tag gọn gàng hơn.',
        targetCategory: 'media',
        targetSub: 'tags',
        targetFacet: 'tag_state:empty',
        actionLabel: 'Dọn tag trống',
      });
    }
  }

  const charRec = getCat('characters');
  if (charRec) {
    const idleChars = charRec.facets?.find((f) => f.id === 'char:idle')?.count || 0;
    if (idleChars >= 3 && !findings.some((f) => f.targetCategory === 'characters')) {
      findings.push({
        level: 'info',
        title: `Có ${idleChars} thẻ nhân vật nhàn rỗi chưa yêu thích và không thuộc nhóm chat`,
        detail: 'Hỗ trợ lọc theo thẻ tag, sắp xếp theo thời gian tương tác gần nhất hoặc dung lượng chat.',
        targetCategory: 'characters',
        targetSub: 'char_cards',
        targetFacet: 'char:idle',
        actionLabel: 'Xem nhân vật nhàn rỗi',
      });
    }
  }

  if (findings.length === 0) {
    findings.push({
      level: 'good',
      title: 'SillyTavern hiện chạy rất mượt, chưa phát hiện điểm nghẽn hiệu năng rõ rệt',
      detail: 'Có thể nhấn "Kiểm tra chuyên sâu" ở góc trên bên phải để quét tệp mồ côi, phiên chat thử nghiệm ngắn và Worldbook nhàn rỗi.',
    });
  }

  const clampedScore = Math.max(35, Math.min(100, Math.round(score)));
  const grade = clampedScore >= 90 ? 'A' : (clampedScore >= 76 ? 'B' : (clampedScore >= 60 ? 'C' : 'D'));
  const statusLabel = grade === 'A' ? 'Rất mượt' : (grade === 'B' ? 'Khỏe mạnh' : (grade === 'C' ? 'Tài sản khá nặng' : 'Nên tinh gọn'));

  const deepScannedCount = ['characters', 'chats', 'regex', 'worldinfo', 'media', 'extensions']
    .filter((cid) => Boolean(getCat(cid))).length;

  return {
    score: clampedScore,
    grade,
    statusLabel,
    isDeepScanned: deepScannedCount >= 5,
    telemetry: {
      charCount,
      shallowCount,
      lazyLoadEnabled,
      activeRegexCount: totalActiveRegex,
      disabledRegexCount: disabledRxTotal,
      jsHeapUsedBytes,
      totalBootMs,
      totalBootBytes,
    },
    findings,
  };
}
