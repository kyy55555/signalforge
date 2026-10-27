/** Browser/Node strategy engine. Quantities are base-asset units, never OKX contract counts. */
export const DEFAULT_STRATEGY = {
  id: 'ma-sar', name: '均线突破 · SAR 趋势确认', instrument: 'BTC-USDT-SWAP',
  timeframe: '15m', direction: 'long', trigger: 'intrabar', logic: 'all', enabled: false,
  conditions: [
    { id: 'ma-1', type: 'ma_cross', period: 20, ma: 'EMA' },
    { id: 'sar-1', type: 'sar', step: 0.02, max: 0.2 },
    { id: 'rsi-1', type: 'rsi', period: 14, operator: 'gt', value: 50 },
  ],
  risk: { equity: 10000, riskPct: 1, stopPct: 1.5, takePct: 3, leverage: 3, maxMarginPct: 20, dailyLossPct: 3, cooldownBars: 1 },
};
export const TIMEFRAMES = { '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000, '1H': 3600000, '2H': 7200000, '4H': 14400000, '6H': 21600000, '12H': 43200000, '1D': 86400000 };
const finite = v => typeof v === 'number' && Number.isFinite(v);
const positive = v => finite(v) && v > 0;
const periodOK = p => Number.isInteger(p) && p >= 2 && p <= 200;
const nulls = n => Array(n).fill(null);
const last = a => a[a.length - 1];
const clone = o => JSON.parse(JSON.stringify(o));

function riskErrors(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['缺少风控设置'];
  const errors = [];
  if (!positive(r.equity)) errors.push('模拟本金必须大于 0');
  for (const [key, label] of [['riskPct', '单笔风险'], ['stopPct', '止损比例'], ['takePct', '止盈比例'], ['maxMarginPct', '保证金上限'], ['dailyLossPct', '每日亏损上限']]) {
    if (!positive(r[key]) || r[key] > 100) errors.push(`${label}必须大于 0 且不超过 100%`);
  }
  if (r.stopPct >= 100) errors.push('止损比例必须小于 100%');
  if (r.takePct >= 100) errors.push('止盈比例必须小于 100%');
  if (!Number.isInteger(r.leverage) || r.leverage < 1 || r.leverage > 100) errors.push('杠杆必须为 1–100 的整数');
  if (!Number.isInteger(r.cooldownBars) || r.cooldownBars < 0 || r.cooldownBars > 1000) errors.push('冷却期必须为 0–1000 根 K 线');
  return errors;
}

export function validateStrategy(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return ['策略格式无效'];
  const errors = [];
  if (typeof s.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(s.id)) errors.push('策略 ID 格式无效');
  if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 100) errors.push('策略名称须为 1–100 个字符');
  if (typeof s.instrument !== 'string' || !/^[A-Z0-9]{2,20}-USDT-SWAP$/.test(s.instrument)) errors.push('请选择 USDT 本位永续合约');
  if (!Object.hasOwn(TIMEFRAMES, s.timeframe)) errors.push('K 线周期无效');
  if (!['long', 'short', 'both'].includes(s.direction)) errors.push('交易方向无效');
  if (!['intrabar', 'close'].includes(s.trigger)) errors.push('信号触发方式无效');
  if (!['all', 'any'].includes(s.logic)) errors.push('条件组合方式无效');
  if (typeof s.enabled !== 'boolean') errors.push('策略启用状态必须为布尔值');
  if (!Array.isArray(s.conditions) || !s.conditions.length || s.conditions.length > 12) errors.push('请配置 1–12 个条件');
  const ids = new Set();
  for (const c of Array.isArray(s.conditions) ? s.conditions : []) {
    if (!c || typeof c !== 'object') { errors.push('条件格式无效'); continue; }
    if (typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.id) || ids.has(c.id)) errors.push('条件 ID 无效或重复');
    ids.add(c.id);
    if (!['ma_cross', 'ma_position', 'sar', 'rsi', 'volume', 'macd'].includes(c.type)) { errors.push('包含不支持的指标条件'); continue; }
    if (['ma_cross', 'ma_position', 'rsi', 'volume'].includes(c.type) && !periodOK(c.period)) errors.push('指标周期须为 2–200 的整数');
    if (['ma_cross', 'ma_position'].includes(c.type) && !['SMA', 'EMA'].includes(c.ma)) errors.push('均线类型只能为 SMA 或 EMA');
    if (c.type === 'sar' && (!positive(c.step) || !positive(c.max) || c.step > c.max || c.max > 1)) errors.push('SAR 参数须满足 0 < 步长 ≤ 上限 ≤ 1');
    if (c.type === 'rsi') {
      if (!['gt', 'lt'].includes(c.operator)) errors.push('RSI 比较方式无效');
      if (!finite(c.value) || c.value < 0 || c.value > 100) errors.push('RSI 阈值须在 0–100 之间');
    }
    if (c.type === 'volume' && (!positive(c.multiplier) || c.multiplier > 100)) errors.push('成交量倍数须大于 0 且不超过 100');
    if (c.type === 'macd') {
      const fast = c.fast ?? 12, slow = c.slow ?? 26, signalPeriod = c.signalPeriod ?? 9;
      if (!periodOK(fast) || !periodOK(slow) || !periodOK(signalPeriod) || fast >= slow) errors.push('MACD 周期须在 2–200 之间，且快线小于慢线');
    }
  }
  return [...new Set([...errors, ...riskErrors(s.risk)])];
}

function checkCandles(candles) {
  if (!Array.isArray(candles) || candles.length > 20000) throw new TypeError('K 线数据格式或数量无效');
  let previousTime = -Infinity;
  for (const c of candles) {
    if (!c || !finite(c.time) || c.time <= previousTime || ![c.open, c.high, c.low, c.close].every(positive) || !finite(c.volume) || c.volume < 0 || c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) || c.low > c.high || typeof c.confirmed !== 'boolean') throw new TypeError('K 线价格、时间顺序或确认状态无效');
    previousTime = c.time;
  }
}

function sma(values, period) {
  const out = nulls(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
function ema(values, period) {
  const out = nulls(values.length), alpha = 2 / (period + 1);
  let seed = [], current = null;
  for (let i = 0; i < values.length; i++) {
    if (!finite(values[i])) { seed = []; current = null; continue; }
    if (current === null) {
      seed.push(values[i]);
      if (seed.length === period) current = seed.reduce((a, b) => a + b, 0) / period;
    } else current += alpha * (values[i] - current);
    out[i] = current;
  }
  return out;
}
function rsi(values, period) {
  const out = nulls(values.length);
  let gains = 0, losses = 0;
  for (let i = 1; i < values.length; i++) {
    const change = values[i] - values[i - 1], gain = Math.max(change, 0), loss = Math.max(-change, 0);
    if (i <= period) { gains += gain / period; losses += loss / period; }
    else { gains = (gains * (period - 1) + gain) / period; losses = (losses * (period - 1) + loss) / period; }
    if (i >= period) out[i] = gains === 0 && losses === 0 ? 50 : losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
  }
  return out;
}
function psar(candles, step, maximum) {
  const out = nulls(candles.length);
  if (candles.length < 2) return out;
  let up = candles[1].close >= candles[0].close;
  let extreme = up ? Math.max(candles[0].high, candles[1].high) : Math.min(candles[0].low, candles[1].low);
  let value = up ? Math.min(candles[0].low, candles[1].low) : Math.max(candles[0].high, candles[1].high), acceleration = step;
  out[1] = value;
  for (let i = 2; i < candles.length; i++) {
    let projected = value + acceleration * (extreme - value);
    projected = up ? Math.min(projected, candles[i - 1].low, candles[i - 2].low) : Math.max(projected, candles[i - 1].high, candles[i - 2].high);
    if (up ? candles[i].low < projected : candles[i].high > projected) {
      up = !up; value = extreme; acceleration = step;
      extreme = up ? candles[i].high : candles[i].low;
    } else {
      value = projected;
      if (up ? candles[i].high > extreme : candles[i].low < extreme) {
        extreme = up ? candles[i].high : candles[i].low;
        acceleration = Math.min(maximum, acceleration + step);
      }
    }
    out[i] = value;
  }
  return out;
}

export function computeIndicators(candles, strategy = DEFAULT_STRATEGY) {
  checkCandles(candles);
  const errors = validateStrategy(strategy);
  if (errors.length) throw new TypeError(errors.join('；'));
  const n = candles.length, closes = candles.map(c => c.close), volumes = candles.map(c => c.volume);
  const out = { ma: nulls(n), sar: nulls(n), rsi: nulls(n), macd: nulls(n), signal: nulls(n), histogram: nulls(n), volumeMA: nulls(n), byCondition: Object.create(null) };
  const assigned = new Set();
  for (const c of strategy.conditions) {
    let data;
    if (['ma_cross', 'ma_position'].includes(c.type)) data = { ma: (c.ma === 'SMA' ? sma : ema)(closes, c.period) };
    if (c.type === 'sar') data = { sar: psar(candles, c.step, c.max) };
    if (c.type === 'rsi') data = { rsi: rsi(closes, c.period) };
    if (c.type === 'volume') { const average = sma(volumes, c.period); data = { volumeMA: average.map((_, i) => i ? average[i - 1] : null) }; }
    if (c.type === 'macd') {
      const fast = ema(closes, c.fast ?? 12), slow = ema(closes, c.slow ?? 26);
      const macd = closes.map((_, i) => finite(fast[i]) && finite(slow[i]) ? fast[i] - slow[i] : null);
      const signal = ema(macd, c.signalPeriod ?? 9);
      data = { macd, signal, histogram: macd.map((v, i) => finite(v) && finite(signal[i]) ? v - signal[i] : null) };
    }
    out.byCondition[c.id] = data;
    for (const [key, values] of Object.entries(data)) if (!assigned.has(key)) { out[key] = values; assigned.add(key); }
  }
  return out;
}

function conditionLabel(c, direction) {
  const up = direction === 'long';
  if (c.type === 'ma_cross') return `价格${up ? '上穿' : '下穿'} ${c.ma} ${c.period}`;
  if (c.type === 'ma_position') return `价格位于 ${c.ma} ${c.period} ${up ? '上方' : '下方'}`;
  if (c.type === 'sar') return `SAR ${up ? '看多' : '看空'}`;
  if (c.type === 'rsi') return `RSI ${c.period} ${c.operator === 'gt' ? '>' : '<'} ${c.value}`;
  if (c.type === 'volume') return `成交量 > 前 ${c.period} 根均量 × ${c.multiplier}`;
  return `MACD 柱${up ? '大于' : '小于'} 0`;
}

export function evaluateStrategy(candles, strategy = DEFAULT_STRATEGY, previousCandles) {
  const base = { long: { pass: false, conditions: [] }, short: { pass: false, conditions: [] }, signal: null, price: null, time: null, errors: [], indicators: null };
  const errors = validateStrategy(strategy);
  if (errors.length) return { ...base, errors };
  try {
    checkCandles(candles);
    if (previousCandles !== undefined) checkCandles(previousCandles);
    const current = strategy.trigger === 'close' ? candles.filter(c => c.confirmed) : candles;
    if (current.length < 2) return { ...base, errors: ['至少需要 2 根 K 线'] };
    const previous = previousCandles === undefined ? current.slice(0, -1) : (strategy.trigger === 'close' ? previousCandles.filter(c => c.confirmed) : previousCandles);
    if (previous.length && last(previous).time > last(current).time) return { ...base, errors: ['前一行情快照不能晚于当前行情'] };
    const indicators = computeIndicators(current, strategy), prior = computeIndicators(previous, strategy);
    const price = last(current).close, oldPrice = previous.length ? last(previous).close : null;
    const sides = {};
    for (const direction of ['long', 'short']) {
      const up = direction === 'long';
      const conditions = strategy.conditions.map(c => {
        const data = indicators.byCondition[c.id], old = prior.byCondition[c.id];
        let pass = false, value = null, reference = null;
        if (['ma_cross', 'ma_position'].includes(c.type)) {
          value = last(data.ma); reference = price;
          if (finite(value)) pass = up ? price > value : price < value;
          if (c.type === 'ma_cross') {
            const priorMA = last(old.ma);
            pass = pass && finite(oldPrice) && finite(priorMA) && (up ? oldPrice <= priorMA : oldPrice >= priorMA);
          }
        } else if (c.type === 'sar') { value = last(data.sar); reference = price; pass = finite(value) && (up ? price > value : price < value); }
        else if (c.type === 'rsi') { value = last(data.rsi); reference = c.value; pass = finite(value) && (c.operator === 'gt' ? value > c.value : value < c.value); }
        else if (c.type === 'volume') { value = last(current).volume; reference = last(data.volumeMA); pass = finite(reference) && value > reference * c.multiplier; }
        else { value = last(data.histogram); reference = 0; pass = finite(value) && (up ? value > 0 : value < 0); }
        return { id: c.id, type: c.type, label: conditionLabel(c, direction), pass: Boolean(pass), value: finite(value) ? value : null, reference: finite(reference) ? reference : null };
      });
      const allowed = strategy.direction === 'both' || strategy.direction === direction;
      sides[direction] = { pass: allowed && (strategy.logic === 'all' ? conditions.every(c => c.pass) : conditions.some(c => c.pass)), conditions };
    }
    const signal = sides.long.pass === sides.short.pass ? null : sides.long.pass ? 'long' : 'short';
    return { ...base, ...sides, signal, price, time: last(current).time, indicators, conflict: sides.long.pass && sides.short.pass };
  } catch (error) { return { ...base, errors: [error.message] }; }
}

export function positionSize(price, risk) {
  const errors = riskErrors(risk);
  if (!positive(price) || errors.length) throw new RangeError(errors.length ? errors.join('；') : '价格必须大于 0');
  const stopDistance = price * risk.stopPct / 100;
  const maxRisk = risk.equity * risk.riskPct / 100;
  const maxNotional = risk.equity * risk.maxMarginPct / 100 * risk.leverage;
  const quantity = Math.min(maxRisk / stopDistance, maxNotional / price);
  const notional = quantity * price;
  if (![quantity, notional, stopDistance].every(positive)) throw new RangeError('仓位计算超出有效数值范围');
  return { quantity, notional, margin: notional / risk.leverage, riskAmount: quantity * stopDistance, stopDistance };
}

export function backtest(candles, strategy = DEFAULT_STRATEGY) {
  const errors = validateStrategy(strategy);
  if (errors.length) throw new TypeError(errors.join('；'));
  checkCandles(candles);
  const bars = candles.filter(c => c.confirmed), closedStrategy = { ...clone(strategy), trigger: 'close' };
  const feeRate = 0.0005, slippageRate = 0.0002;
  const trades = [], equityCurve = [];
  let equity = strategy.risk.equity, peak = equity, maxDrawdown = 0, position = null, pending = null, lastExit = -Infinity;
  let day = null, dayStart = equity;
  const dailyLimited = () => equity <= dayStart * (1 - strategy.risk.dailyLossPct / 100);
  const close = (bar, index, referencePrice, reason) => {
    const side = position.direction === 'long' ? 1 : -1;
    const exitPrice = referencePrice * (1 - side * slippageRate);
    const grossPnl = (exitPrice - position.entryPrice) * position.quantity * side;
    const exitFee = exitPrice * position.quantity * feeRate;
    equity += grossPnl - exitFee;
    const fees = position.entryFee + exitFee;
    trades.push({ ...position, exitPrice, exitTime: bar.time, exitIndex: index, grossPnl, fees, pnl: grossPnl - fees, reason, equity });
    position = null; lastExit = index;
  };
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i], date = new Date(bar.time).toISOString().slice(0, 10);
    if (date !== day) { day = date; dayStart = equity; }
    if (pending && !position && equity > 0 && !dailyLimited() && i > lastExit + strategy.risk.cooldownBars) {
      const direction = pending, side = direction === 'long' ? 1 : -1;
      const entryPrice = bar.open * (1 + side * slippageRate);
      const size = positionSize(entryPrice, { ...strategy.risk, equity });
      const entryFee = entryPrice * size.quantity * feeRate;
      equity -= entryFee;
      position = { direction, entryPrice, entryTime: bar.time, entryIndex: i, quantity: size.quantity, margin: size.margin, entryFee, stopPrice: entryPrice * (1 - side * strategy.risk.stopPct / 100), takePrice: entryPrice * (1 + side * strategy.risk.takePct / 100) };
    }
    pending = null;
    if (position) {
      const up = position.direction === 'long';
      const stopHit = up ? bar.low <= position.stopPrice : bar.high >= position.stopPrice;
      const takeHit = up ? bar.high >= position.takePrice : bar.low <= position.takePrice;
      if (stopHit) close(bar, i, up ? Math.min(bar.open, position.stopPrice) : Math.max(bar.open, position.stopPrice), 'stop');
      else if (takeHit) close(bar, i, position.takePrice, 'take');
      else if (i === bars.length - 1) close(bar, i, bar.close, 'end');
    }
    const floating = position ? (bar.close - position.entryPrice) * position.quantity * (position.direction === 'long' ? 1 : -1) : 0;
    const markedEquity = equity + floating;
    peak = Math.max(peak, markedEquity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - markedEquity) / peak * 100 : 0);
    equityCurve.push({ time: bar.time, equity: markedEquity });
    if (!position && !dailyLimited() && equity > 0 && i < bars.length - 1 && i >= 1 && i >= lastExit + strategy.risk.cooldownBars) pending = evaluateStrategy(bars.slice(0, i + 1), closedStrategy).signal;
  }
  const netPnl = equity - strategy.risk.equity;
  return { trades, netPnl, returnPct: netPnl / strategy.risk.equity * 100, winRate: trades.length ? trades.filter(t => t.pnl > 0).length / trades.length * 100 : 0, maxDrawdown, equityCurve, finalEquity: equity, candleCount: bars.length,
    assumptions: [
      '仅使用已收盘 K 线产生信号，下一根开盘成交；历史 OHLC 无法复现盘中触发，此结果仅为收盘近似验证。',
      '单边手续费 0.05%，单边滑点 0.02%；不计资金费、维持保证金、强平及 OKX 合约张数舍入。',
      '同一根 K 线同时触及止盈止损时，按先止损处理；跳空止损按更差的开盘价处理。',
      '持仓期间不加仓，按 UTC 日期计算已实现亏损限制；回测结束按最后收盘价平仓。',
      ...(candles.some(c => c.synthetic) ? ['使用程序生成的演示行情，不是真实历史收益。'] : []),
    ],
  };
}

/** Deterministic fabricated series for interface testing; never label as exchange history. */
export function generateDemoCandles(count = 250, timeframe = '15m', instrument = 'BTC-USDT-SWAP') {
  if (!Number.isInteger(count) || count < 2 || count > 20000 || !Object.hasOwn(TIMEFRAMES, timeframe)) throw new RangeError('演示行情参数无效');
  let seed = 7331;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
  const base = instrument.startsWith('ETH-') ? 3250 : instrument.startsWith('SOL-') ? 165 : 67800;
  const start = Date.UTC(2026, 9, 1), interval = TIMEFRAMES[timeframe], candles = [];
  let price = base;
  for (let i = 0; i < count; i++) {
    const open = price;
    const movement = (Math.sin(i / 13) * 0.0018 + (random() - 0.48) * 0.0065);
    const close = open * (1 + movement), spread = base * (0.0006 + random() * 0.0025);
    const high = Math.max(open, close) + spread * random(), low = Math.min(open, close) - spread * random();
    candles.push({ time: start + i * interval, open, high, low, close, volume: 50 + random() * 200 + Math.abs(movement) * 15000, confirmed: true, synthetic: true });
    price = close;
  }
  return candles;
}
