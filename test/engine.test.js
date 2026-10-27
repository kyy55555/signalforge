import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STRATEGY, validateStrategy, computeIndicators, evaluateStrategy, positionSize, backtest, generateDemoCandles } from '../dist/engine.js';

const copy = x => structuredClone(x);
const strategy = (conditions, extra = {}) => ({ ...copy(DEFAULT_STRATEGY), conditions, ...extra });
function bars(closes, step = 60000) {
  return closes.map((close, i) => ({ time: Date.UTC(2026, 9, 1) + i * step, open: close, high: close + 0.2, low: close - 0.2, close, volume: 100, confirmed: true }));
}
const approximately = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('default strategy valid; unsafe values and unsupported condition types rejected', () => {
  assert.deepEqual(validateStrategy(DEFAULT_STRATEGY), []);
  assert.ok(validateStrategy(null).length);
  const bad = copy(DEFAULT_STRATEGY);
  bad.conditions[0].period = 0;
  bad.conditions[1].step = 0.3;
  bad.conditions[2].operator = 'exec';
  bad.risk.equity = NaN;
  bad.risk.stopPct = 100;
  bad.instrument = 'BTC-USDT';
  assert.ok(validateStrategy(bad).length >= 6);
  assert.ok(validateStrategy(strategy([{ id: 'x', type: 'javascript' }])).length);
  assert.ok(validateStrategy(strategy([])).length);
});

test('SMA and EMA warmup is unavailable and calculations match known values', () => {
  const s = strategy([{ id: 'sma', type: 'ma_position', period: 3, ma: 'SMA' }, { id: 'ema', type: 'ma_position', period: 3, ma: 'EMA' }]);
  const x = computeIndicators(bars([1, 2, 3, 4, 8]), s);
  assert.deepEqual(x.byCondition.sma.ma, [null, null, 2, 3, 5]);
  assert.deepEqual(x.byCondition.ema.ma, [null, null, 2, 3, 5.5]);
  assert.deepEqual(x.ma, x.byCondition.sma.ma);
  const extended = computeIndicators(bars([1, 2, 3, 4, 8, 200]), s);
  assert.deepEqual(extended.byCondition.ema.ma.slice(0, 5), x.byCondition.ema.ma);
});

test('RSI distinguishes rising, falling, and flat markets with Wilder warmup', () => {
  const s = strategy([{ id: 'r', type: 'rsi', period: 3, operator: 'gt', value: 50 }]);
  assert.deepEqual(computeIndicators(bars([1, 2, 3, 4, 5]), s).rsi, [null, null, null, 100, 100]);
  assert.equal(computeIndicators(bars([5, 4, 3, 2, 1]), s).rsi.at(-1), 0);
  assert.equal(computeIndicators(bars([5, 5, 5, 5, 5]), s).rsi.at(-1), 50);
});

test('SAR reverses above price after a large downward reversal', () => {
  const s = strategy([{ id: 's', type: 'sar', step: 0.02, max: 0.2 }]);
  const x = computeIndicators(bars([10, 11, 12, 13, 7]), s).sar;
  assert.equal(x[0], null);
  assert.ok(x[3] < 13);
  assert.ok(x[4] > 7);
  assert.equal(evaluateStrategy(bars([10, 11, 12, 13, 7]), { ...s, direction: 'short' }).signal, 'short');
});

test('intrabar crossing compares snapshots and does not retrigger unchanged state', () => {
  const s = strategy([{ id: 'm', type: 'ma_cross', period: 2, ma: 'SMA' }]);
  const previous = bars([10, 10, 9]); previous[2].confirmed = false;
  const current = bars([10, 10, 11]); current[2].confirmed = false;
  assert.equal(evaluateStrategy(current, s, previous).signal, 'long');
  assert.equal(evaluateStrategy(current, s, current).signal, null);
  assert.equal(evaluateStrategy(current, { ...s, direction: 'short' }, previous).signal, null);
  assert.equal(evaluateStrategy(previous, { ...s, direction: 'short' }, current).signal, 'short');
  assert.equal(evaluateStrategy(current, { ...s, trigger: 'close' }, previous).signal, null);
});

test('all/any logic and RSI explicit comparisons apply consistently', () => {
  const conditions = [{ id: 'm', type: 'ma_position', period: 2, ma: 'SMA' }, { id: 'r', type: 'rsi', period: 2, operator: 'lt', value: 30 }];
  const data = bars([10, 11, 12, 13]);
  assert.equal(evaluateStrategy(data, strategy(conditions)).signal, null);
  assert.equal(evaluateStrategy(data, strategy(conditions, { logic: 'any' })).signal, 'long');
  const both = strategy([{ id: 'r', type: 'rsi', period: 2, operator: 'gt', value: 50 }], { direction: 'both' });
  const result = evaluateStrategy(data, both);
  assert.equal(result.conflict, true);
  assert.equal(result.signal, null, 'ambiguous bidirectional conditions must not open a position');
});

test('volume compares current volume to preceding bars only', () => {
  const data = bars([10, 10, 10]); data[2].volume = 201;
  const s = strategy([{ id: 'v', type: 'volume', period: 2, multiplier: 2 }]);
  assert.deepEqual(computeIndicators(data, s).volumeMA, [null, null, 100]);
  assert.equal(evaluateStrategy(data, s).signal, 'long');
});

test('MACD has finite signal after sufficient history without forward information', () => {
  const s = strategy([{ id: 'm', type: 'macd' }]);
  const data = bars(Array.from({ length: 40 }, (_, i) => 100 + i * i));
  const result = computeIndicators(data, s);
  assert.equal(result.macd[24], null);
  assert.equal(result.signal[32], null);
  assert.ok(Number.isFinite(result.signal[33]));
  assert.ok(result.histogram[39] > 0);
  assert.equal(evaluateStrategy(data, s).signal, 'long');
});

test('invalid candle data, timestamps and future snapshots cannot produce signals', () => {
  const data = bars([10, 11, 12]); data[1].low = 15;
  const result = evaluateStrategy(data);
  assert.equal(result.signal, null);
  assert.ok(result.errors.length);
  assert.throws(() => computeIndicators(data));
  assert.equal(evaluateStrategy(bars([10, 11]), DEFAULT_STRATEGY, bars([10, 11, 12])).signal, null);
  assert.ok(evaluateStrategy(bars([10, 11]), DEFAULT_STRATEGY, bars([10, 11, 12])).errors.length);
});

test('position size obeys stop risk and leverage/margin budget', () => {
  const risk = { ...DEFAULT_STRATEGY.risk, equity: 10000, riskPct: 1, stopPct: 2, maxMarginPct: 20, leverage: 3 };
  const first = positionSize(100, risk);
  approximately(first.quantity, 50);
  approximately(first.riskAmount, 100);
  approximately(first.margin, 5000 / 3);
  const capped = positionSize(100, { ...risk, stopPct: 0.1 });
  approximately(capped.quantity, 60);
  approximately(capped.notional, 6000);
  approximately(capped.margin, 2000);
  assert.throws(() => positionSize(0, risk));
  assert.throws(() => positionSize(100, { ...risk, leverage: Infinity }));
});

test('backtest waits until next candle, handles gap stops conservatively, and includes all fees', () => {
  const data = bars([10, 12, 15, 12]);
  data[2] = { ...data[2], open: 15, high: 16, low: 14, close: 15 };
  data[3] = { ...data[3], open: 10, high: 20, low: 9, close: 12 };
  const s = strategy([{ id: 'm', type: 'ma_position', period: 2, ma: 'SMA' }]);
  s.risk.stopPct = 10; s.risk.takePct = 10;
  const result = backtest(data, s);
  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.entryTime, data[2].time);
  assert.equal(trade.reason, 'stop');
  assert.ok(trade.entryPrice > 15);
  assert.ok(trade.exitPrice < 10, 'gap stop uses worse open, not the stop trigger');
  assert.ok(trade.fees > 0);
  approximately(trade.pnl, trade.grossPnl - trade.fees);
  approximately(result.netPnl, trade.pnl, 1e-7);
  assert.ok(result.maxDrawdown > 0);
  assert.ok(result.assumptions[0].includes('无法复现盘中触发'));
});

test('backtest excludes open candles and has no warmup trades', () => {
  const data = bars([10, 11, 12, 13, 14]); data[4].confirmed = false;
  const s = strategy([{ id: 'm', type: 'ma_position', period: 20, ma: 'SMA' }]);
  const result = backtest(data, s);
  assert.equal(result.candleCount, 4);
  assert.equal(result.trades.length, 0);
  assert.equal(result.netPnl, 0);
});

test('daily loss circuit breaker prevents new entries after a stopped trade', () => {
  const data = bars([100, 101, 102, 103, 104, 105, 106]);
  for (let i = 2; i < data.length; i++) data[i].low = 80;
  const s = strategy([{ id: 'm', type: 'ma_position', period: 2, ma: 'SMA' }]);
  s.risk = { ...s.risk, riskPct: 10, stopPct: 2, dailyLossPct: 1, maxMarginPct: 100, leverage: 1, cooldownBars: 0 };
  const result = backtest(data, s);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].reason, 'stop');
  assert.ok(result.returnPct < -1);
});

test('demo candles are reproducible, explicitly synthetic, and distinct by market', () => {
  const a = generateDemoCandles(100), b = generateDemoCandles(100);
  assert.deepEqual(a, b);
  assert.ok(a.every(c => c.synthetic));
  assert.ok(generateDemoCandles(10, '15m', 'ETH-USDT-SWAP')[0].close < a[0].close);
  assert.ok(backtest(a).assumptions.some(v => v.includes('演示行情')));
  assert.throws(() => generateDemoCandles(0));
});
