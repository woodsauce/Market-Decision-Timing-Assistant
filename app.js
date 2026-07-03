import {
  CHECKPOINT_MINUTES,
  PROFILES,
  evaluateDecision,
  createRecord,
  settleRecord,
  summarizeRecords,
  shouldCaptureCheckpoint
} from './lib/decision-engine.mjs';

const STORE_KEY = 'edge15.records.v1';
const SETTINGS_KEY = 'edge15.settings.v1';
const MAX_TICKS = 900;

const state = {
  ticks: [],
  records: loadRecords(),
  settings: loadSettings(),
  decision: null,
  previousRemainingSec: null,
  capturedCheckpoints: {},
  checkpointHistory: [],
  market: null,
  orderbook: null,
  ws: null,
  lastWsMessageAt: 0,
  refreshTimer: null,
  countdownTimer: null
};

const $ = (id) => document.getElementById(id);
const fmtMoney = (value) => Number.isFinite(Number(value)) ? `$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—';
const fmtPct = (value) => `${Number(value || 0).toFixed(1)}%`;

init();

function init() {
  hydrateSettings();
  renderProfiles();
  renderLadder();
  renderRecords();
  renderStats();
  wireEvents();
  connectCoinbase();
  startLoops();
  evaluateAndRender();
}

function hydrateSettings() {
  $('targetPrice').value = state.settings.targetPrice || '';
  $('minutesLeft').value = state.settings.minutesLeft || '5.5';
  $('refreshSeconds').value = state.settings.refreshSeconds || '3';
  $('kalshiSearch').value = state.settings.kalshiSearch || 'bitcoin 15';
  $('contractCount').value = state.settings.contractCount || '1.00';
  $('maxPrice').value = state.settings.maxPrice || '0.7600';
  $('marketTicker').value = state.settings.marketTicker || '';
}

function renderProfiles() {
  const select = $('profileSelect');
  select.innerHTML = Object.entries(PROFILES).map(([key, profile]) =>
    `<option value="${key}">${profile.label}</option>`
  ).join('');
  select.value = state.settings.profile || 'balanced';
}

function wireEvents() {
  ['targetPrice', 'minutesLeft', 'profileSelect', 'refreshSeconds', 'kalshiSearch', 'contractCount', 'maxPrice', 'marketTicker'].forEach((id) => {
    $(id).addEventListener('input', () => {
      saveSettingsFromUi();
      if (id === 'refreshSeconds') restartRefreshLoop();
      evaluateAndRender();
    });
  });
  $('recordDecision').addEventListener('click', () => recordCurrentDecision());
  $('paperTrade').addEventListener('click', () => recordCurrentDecision('paper'));
  $('skipTrade').addEventListener('click', () => recordCurrentDecision('skip'));
  $('loadMarkets').addEventListener('click', loadKalshiMarkets);
  $('loadOrderbook').addEventListener('click', loadOrderbook);
  $('previewOrder').addEventListener('click', previewOrder);
  $('liveOrder').addEventListener('click', placeLiveOrder);
  $('armLive').addEventListener('change', updateLiveOrderButton);
  $('liveConfirmText').addEventListener('input', updateLiveOrderButton);
  $('exportTracker').addEventListener('click', exportTracker);
  $('clearTracker').addEventListener('click', clearTracker);
}

function startLoops() {
  restartRefreshLoop();
  state.countdownTimer = setInterval(() => {
    updateTimeLeft();
    evaluateAndRender(false);
  }, 1000);
}

function restartRefreshLoop() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  const seconds = Math.max(1, Number($('refreshSeconds').value || 3));
  state.refreshTimer = setInterval(() => evaluateAndRender(), seconds * 1000);
}

function connectCoinbase() {
  try {
    if (state.ws) state.ws.close();
    const ws = new WebSocket('wss://advanced-trade-ws.coinbase.com');
    state.ws = ws;
    $('coinbaseStatus').textContent = 'Coinbase: connecting';
    $('coinbaseStatus').className = 'pill warn';

    ws.addEventListener('open', () => {
      $('coinbaseStatus').textContent = 'Coinbase: live';
      $('coinbaseStatus').className = 'pill good';
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channel: 'ticker' }));
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channel: 'market_trades' }));
    });

    ws.addEventListener('message', (event) => {
      const data = safeJson(event.data);
      const tick = parseCoinbaseTick(data);
      if (tick) {
        addTick(tick);
        state.lastWsMessageAt = Date.now();
        $('coinbaseStatus').textContent = 'Coinbase: live';
        $('coinbaseStatus').className = 'pill good';
        renderMarketBasics();
        drawSparkline();
        evaluateAndRender(false);
      }
    });

    ws.addEventListener('close', () => {
      $('coinbaseStatus').textContent = 'Coinbase: reconnecting';
      $('coinbaseStatus').className = 'pill warn';
      setTimeout(connectCoinbase, 1800);
    });

    ws.addEventListener('error', () => {
      $('coinbaseStatus').textContent = 'Coinbase: error';
      $('coinbaseStatus').className = 'pill bad';
    });
  } catch (error) {
    $('coinbaseStatus').textContent = 'Coinbase: failed';
    $('coinbaseStatus').className = 'pill bad';
  }
}

function parseCoinbaseTick(data) {
  if (!data || data.type === 'subscriptions') return null;
  const candidates = [];
  if (Array.isArray(data.events)) {
    for (const event of data.events) {
      if (Array.isArray(event.tickers)) candidates.push(...event.tickers);
      if (Array.isArray(event.trades)) candidates.push(...event.trades);
      if (Array.isArray(event.candles)) candidates.push(...event.candles);
    }
  }
  candidates.push(data);
  for (const item of candidates) {
    const rawPrice = item.price || item.last_price || item.best_bid || item.best_ask || item.close;
    const price = Number(rawPrice);
    if (Number.isFinite(price) && price > 0) {
      const rawTs = item.time || item.timestamp || data.timestamp || data.time;
      const ts = rawTs ? Date.parse(rawTs) || Date.now() : Date.now();
      return { price, ts, volume: Number(item.volume || item.size || 0), source: 'coinbase' };
    }
  }
  return null;
}

function addTick(tick) {
  state.ticks.push(tick);
  if (state.ticks.length > MAX_TICKS) state.ticks = state.ticks.slice(-MAX_TICKS);
}

function getRemainingSec() {
  const manualMinutes = Number($('minutesLeft').value);
  if (state.market) {
    const closeTime = parseMarketCloseTime(state.market);
    if (closeTime) {
      const derived = Math.max(0, (closeTime - Date.now()) / 1000);
      if (derived <= 15 * 60 + 45) return derived;
    }
  }
  return Number.isFinite(manualMinutes) ? manualMinutes * 60 : 0;
}

function parseMarketCloseTime(market) {
  const fields = ['close_time', 'closeTime', 'expiration_time', 'expected_expiration_time', 'latest_expiration_time'];
  for (const field of fields) {
    if (!market?.[field]) continue;
    const parsed = Date.parse(market[field]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function updateTimeLeft() {
  const remaining = getRemainingSec();
  $('timeLeftDisplay').textContent = formatRemaining(remaining);
}

function evaluateAndRender(capture = true) {
  const remainingSec = getRemainingSec();
  const targetPrice = Number($('targetPrice').value);
  const profile = $('profileSelect').value;
  const decision = evaluateDecision({
    ticks: state.ticks,
    targetPrice,
    timeRemainingSec: remainingSec,
    profile,
    market: state.orderbook || state.market || {},
    recentDecisions: state.checkpointHistory
  });
  state.decision = decision;

  if (capture) {
    const cp = shouldCaptureCheckpoint(state.previousRemainingSec, remainingSec, state.capturedCheckpoints);
    if (cp) {
      state.capturedCheckpoints[String(cp)] = { ...decision, capturedAt: Date.now() };
      state.checkpointHistory.push({ ...decision, checkpoint: cp });
    }
    state.previousRemainingSec = remainingSec;
  }

  renderDecision(decision);
  renderLadder();
  renderMarketBasics();
  renderReasons(decision);
  renderIndicators(decision.indicators || {});
  drawSparkline();
}

function renderDecision(decision) {
  const action = decision.action || 'WAIT';
  $('mainAction').textContent = action;
  $('mainAction').className = `main-action ${action.toLowerCase()}`;
  $('readiness').textContent = decision.readiness || '';
  $('confidence').textContent = fmtPct(decision.confidence);
  $('stability').textContent = fmtPct(decision.stability);
  $('flipRisk').textContent = fmtPct(decision.flipRisk);
  $('checkpoint').textContent = `${decision.checkpoint || '—'}m`;
  $('fairPrice').textContent = decision.marketValue?.price ? `${decision.marketValue.price}¢` : '—';
}

function renderMarketBasics() {
  const latest = state.ticks.at(-1);
  $('btcPrice').textContent = latest ? fmtMoney(latest.price) : '—';
  $('targetDisplay').textContent = Number($('targetPrice').value) ? fmtMoney(Number($('targetPrice').value)) : '—';
  $('timeLeftDisplay').textContent = formatRemaining(getRemainingSec());
  const yes = state.orderbook?.yesPrice ?? state.market?.yes_bid ?? state.market?.yes_ask ?? state.market?.last_price;
  const no = state.orderbook?.noPrice ?? state.market?.no_bid ?? state.market?.no_ask;
  $('yesPrice').textContent = yes ? displayCents(yes) : '—';
  $('noPrice').textContent = no ? displayCents(no) : '—';
}

function renderReasons(decision) {
  $('reasons').innerHTML = (decision.reasons || []).map((reason) => `<li>${escapeHtml(reason)}</li>`).join('');
}

function renderIndicators(indicators) {
  $('indicators').innerHTML = Object.entries(indicators).map(([key, value]) =>
    `<div><span class="small-muted">${escapeHtml(key)}</span><strong>${escapeHtml(String(value))}</strong></div>`
  ).join('');
}

function renderLadder() {
  const currentCp = state.decision?.checkpoint;
  $('ladder').innerHTML = CHECKPOINT_MINUTES.map((minutes) => {
    const captured = state.capturedCheckpoints[String(minutes)];
    const active = currentCp === minutes ? ' active' : '';
    return `<div class="checkpoint-card${active}">
      <div class="checkpoint-time">${minutes}:00 left</div>
      <div class="checkpoint-pick">${captured ? captured.action : '—'}</div>
      <div class="checkpoint-details">${captured ? `${captured.confidence}% conf · ${captured.flipRisk}% flip` : 'Waiting'}</div>
    </div>`;
  }).join('');
}

function drawSparkline() {
  const canvas = $('sparkline');
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#070a10';
  ctx.fillRect(0, 0, width, height);
  const ticks = state.ticks.slice(-180);
  if (ticks.length < 2) {
    ctx.fillStyle = '#8e9db1';
    ctx.font = '22px system-ui';
    ctx.fillText('Waiting for live Coinbase ticks…', 24, 96);
    return;
  }
  const prices = ticks.map((tick) => tick.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const pad = Math.max((max - min) * 0.1, 10);
  const lo = min - pad;
  const hi = max + pad;
  const xFor = (i) => i / (ticks.length - 1) * width;
  const yFor = (price) => height - ((price - lo) / (hi - lo)) * height;

  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i += 1) {
    const y = i * height / 4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const target = Number($('targetPrice').value);
  if (Number.isFinite(target) && target > 0) {
    const y = yFor(target);
    ctx.strokeStyle = 'rgba(255, 209, 102, 0.8)';
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = '#71a7ff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ticks.forEach((tick, i) => {
    const x = xFor(i);
    const y = yFor(tick.price);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

async function loadKalshiMarkets() {
  const search = $('kalshiSearch').value || 'bitcoin 15';
  saveSettingsFromUi();
  $('kalshiStatus').textContent = 'Kalshi: loading';
  $('kalshiStatus').className = 'pill warn';
  $('marketsList').innerHTML = '<div class="small-muted">Loading open markets…</div>';
  try {
    const response = await fetch(`/api/kalshi/markets?status=open&limit=200&search=${encodeURIComponent(search)}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Kalshi request failed');
    $('kalshiStatus').textContent = `Kalshi: ${data.count} found`;
    $('kalshiStatus').className = data.count ? 'pill good' : 'pill warn';
    renderMarketList(data.markets || []);
  } catch (error) {
    $('kalshiStatus').textContent = 'Kalshi: error';
    $('kalshiStatus').className = 'pill bad';
    $('marketsList').innerHTML = `<div class="small-muted">${escapeHtml(error.message)}</div>`;
  }
}

function renderMarketList(markets) {
  if (!markets.length) {
    $('marketsList').innerHTML = '<div class="small-muted">No matching open markets. Try search terms like “BTC 15”, “crypto 15”, or paste a ticker directly.</div>';
    return;
  }
  $('marketsList').innerHTML = markets.slice(0, 25).map((market, index) => {
    const ticker = market.ticker || market.market_ticker || '';
    const title = market.title || market.subtitle || ticker;
    const meta = [ticker, market.close_time, market.status].filter(Boolean).join(' · ');
    return `<div class="market-row">
      <div><strong>${escapeHtml(title)}</strong><span class="small-muted">${escapeHtml(meta)}</span></div>
      <button data-market-index="${index}">Select</button>
    </div>`;
  }).join('');
  [...$('marketsList').querySelectorAll('button[data-market-index]')].forEach((button) => {
    button.addEventListener('click', () => {
      const market = markets[Number(button.dataset.marketIndex)];
      selectMarket(market);
    });
  });
}

function selectMarket(market) {
  state.market = market;
  const ticker = market.ticker || market.market_ticker || '';
  $('marketTicker').value = ticker;
  const target = inferTargetPrice(market);
  if (target) $('targetPrice').value = String(target);
  saveSettingsFromUi();
  renderMarketBasics();
  evaluateAndRender();
  loadOrderbook();
}

function inferTargetPrice(market) {
  const text = [market.title, market.subtitle, market.rules_primary, market.rules_secondary].filter(Boolean).join(' ');
  const matches = [...text.matchAll(/\$?([0-9]{2,3}(?:,[0-9]{3})+(?:\.\d+)?|[0-9]{5,6}(?:\.\d+)?)/g)]
    .map((match) => Number(match[1].replace(/,/g, '')))
    .filter((value) => value > 1000 && value < 1000000);
  return matches[0] || null;
}

async function loadOrderbook() {
  const ticker = $('marketTicker').value.trim();
  if (!ticker) return;
  saveSettingsFromUi();
  try {
    const response = await fetch(`/api/kalshi/orderbook?ticker=${encodeURIComponent(ticker)}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Orderbook request failed');
    const normalized = normalizeOrderbook(data.orderbook || data);
    state.orderbook = { ...normalized, ticker };
    $('kalshiStatus').textContent = 'Kalshi: orderbook';
    $('kalshiStatus').className = 'pill good';
    renderMarketBasics();
    evaluateAndRender();
  } catch (error) {
    $('kalshiStatus').textContent = 'Kalshi: orderbook error';
    $('kalshiStatus').className = 'pill bad';
    $('orderPreview').textContent = error.message;
  }
}

function normalizeOrderbook(orderbook) {
  const yes = Array.isArray(orderbook.yes) ? orderbook.yes : [];
  const no = Array.isArray(orderbook.no) ? orderbook.no : [];
  const bestYes = yes.length ? Math.max(...yes.map((row) => Number(Array.isArray(row) ? row[0] : row.price)).filter(Number.isFinite)) : null;
  const bestNo = no.length ? Math.max(...no.map((row) => Number(Array.isArray(row) ? row[0] : row.price)).filter(Number.isFinite)) : null;
  return {
    yesPrice: bestYes ? (bestYes > 1 ? bestYes : bestYes * 100) : null,
    noPrice: bestNo ? (bestNo > 1 ? bestNo : bestNo * 100) : null,
    raw: orderbook
  };
}

function previewOrder() {
  if (!state.decision) evaluateAndRender();
  const order = buildOrderPayload();
  $('orderPreview').textContent = JSON.stringify(order, null, 2);
}

function buildOrderPayload() {
  const ticker = $('marketTicker').value.trim();
  const action = state.decision?.action;
  const count = $('contractCount').value || '1.00';
  const maxPrice = $('maxPrice').value || '0.7600';
  let side = 'bid';
  let intended = action;
  let note = 'Kalshi orders are quoted from the YES side. Buying DOWN/NO may require selling YES or using the equivalent NO flow in Kalshi UI.';
  if (action === 'UNDER') {
    side = 'ask';
    intended = 'UNDER / economic NO';
  }
  return {
    mode: 'preview_only',
    intended,
    ticker,
    side,
    count,
    price: normalizeDollarPrice(maxPrice),
    time_in_force: 'immediate_or_cancel',
    assistant: {
      action,
      confidence: state.decision?.confidence,
      flipRisk: state.decision?.flipRisk,
      stability: state.decision?.stability
    },
    note
  };
}

function updateLiveOrderButton() {
  const armed = $('armLive').checked && $('liveConfirmText').value.trim() === 'LIVE';
  $('liveOrder').disabled = !armed;
  $('tradeMode').textContent = armed ? 'Live armed' : 'Paper';
}

async function placeLiveOrder() {
  const payload = buildOrderPayload();
  if (!$('armLive').checked || $('liveConfirmText').value.trim() !== 'LIVE') {
    $('orderPreview').textContent = 'Live order blocked locally. Check Arm and type LIVE first.';
    return;
  }
  if (!confirm('This can place a real Kalshi order if server keys are enabled. Continue?')) return;
  try {
    const response = await fetch('/api/kalshi/order', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-edge15-live-confirm': 'I_UNDERSTAND_REAL_MONEY_RISK'
      },
      body: JSON.stringify({
        ticker: payload.ticker,
        side: payload.side,
        count: payload.count,
        price: payload.price,
        time_in_force: payload.time_in_force
      })
    });
    const data = await response.json();
    $('orderPreview').textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    $('orderPreview').textContent = error.message;
  }
}

function recordCurrentDecision(mode = 'decision') {
  if (!state.decision) evaluateAndRender();
  const decision = mode === 'skip' ? { ...state.decision, action: 'SKIP' } : state.decision;
  const record = createRecord({ decision, market: state.market || { ticker: $('marketTicker').value }, userEntry: mode === 'paper' ? `paper:${decision.action}` : decision.action });
  record.checkpoints = { ...state.capturedCheckpoints };
  state.records.unshift(record);
  saveRecords();
  renderRecords();
  renderStats();
}

function renderRecords() {
  const container = $('records');
  if (!state.records.length) {
    container.innerHTML = '<div class="small-muted">No records yet. Record decisions to start tracking.</div>';
    return;
  }
  container.innerHTML = '';
  const template = $('recordTemplate');
  state.records.slice(0, 30).forEach((record) => {
    const node = template.content.cloneNode(true);
    node.querySelector('.record-title').textContent = `${record.recommendation} · ${record.confidence}% · ${record.result}`;
    node.querySelector('.record-meta').textContent = `${new Date(record.ts).toLocaleString()} · ${record.profile} · ${record.checkpoint}m · ${record.ticker || 'manual'}`;
    node.querySelectorAll('button[data-result]').forEach((button) => {
      button.addEventListener('click', () => settleAndRender(record.id, button.dataset.result));
    });
    container.appendChild(node);
  });
}

function settleAndRender(id, result) {
  const finalPrice = state.ticks.at(-1)?.price ?? null;
  state.records = state.records.map((record) => record.id === id ? settleRecord(record, result, finalPrice) : record);
  saveRecords();
  renderRecords();
  renderStats();
}

function renderStats() {
  const summary = summarizeRecords(state.records);
  $('wins').textContent = summary.wins;
  $('losses').textContent = summary.losses;
  $('skipped').textContent = summary.skipped;
  $('winRate').textContent = `${summary.winRate}%`;
  const profileRows = Object.entries(summary.byProfile).map(([profile, stats]) =>
    `<div class="mini-row"><strong>${escapeHtml(profile)}</strong><span>W ${stats.wins}</span><span>L ${stats.losses}</span><span>S ${stats.skipped}</span><span>${stats.winRate}%</span></div>`
  ).join('');
  $('profileStats').innerHTML = profileRows || '<div class="small-muted">Profile stats appear after records are added.</div>';
}

function exportTracker() {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records: state.records }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `edge15-tracker-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearTracker() {
  const confirmed = confirm('Clear all tracker records on this browser?');
  if (!confirmed) return;
  state.records = [];
  saveRecords();
  renderRecords();
  renderStats();
}

function loadRecords() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); }
  catch { return []; }
}

function saveRecords() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state.records));
}

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
  catch { return {}; }
}

function saveSettingsFromUi() {
  state.settings = {
    targetPrice: $('targetPrice').value,
    minutesLeft: $('minutesLeft').value,
    profile: $('profileSelect').value,
    refreshSeconds: $('refreshSeconds').value,
    kalshiSearch: $('kalshiSearch').value,
    contractCount: $('contractCount').value,
    maxPrice: $('maxPrice').value,
    marketTicker: $('marketTicker').value
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function safeJson(value) {
  try { return JSON.parse(value); }
  catch { return null; }
}

function displayCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${(n > 1 ? n : n * 100).toFixed(1)}¢`;
}

function normalizeDollarPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0.0000';
  return (n > 1 ? n / 100 : n).toFixed(4);
}

function formatRemaining(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}
