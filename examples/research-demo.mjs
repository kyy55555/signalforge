import { DEFAULT_STRATEGY, generateDemoCandles, evaluateStrategy, backtest, positionSize } from '../dist/engine.js';

// Reproducible synthetic fixtures demonstrate behavior, not historical performance.
const candles = generateDemoCandles(300);
const strategy = structuredClone(DEFAULT_STRATEGY);
const result = backtest(candles, strategy);
console.log(JSON.stringify({
  dataSource: 'synthetic demonstration only',
  strategy,
  latestSignal: evaluateStrategy(candles, strategy).signal,
  sizingExample: positionSize(candles.at(-1).close, strategy.risk),
  backtest: {
    tradeCount: result.trades.length,
    netPnl: result.netPnl,
    returnPct: result.returnPct,
    maxDrawdown: result.maxDrawdown,
    assumptions: result.assumptions,
  },
}, null, 2));
