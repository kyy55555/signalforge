# SignalForge

### Configurable Trading Strategy Research Platform

An early-stage personal project for researching user-defined strategies on OKX USDT perpetual markets. SignalForge separates indicator computation, signal evaluation, simulated execution, and historical evaluation so that each component can be inspected and tested independently.

**Status:** In development. The strategy engine and local paper-execution backend are implemented. A visual web editor and OKX exchange-side order execution are planned. This repository does not place OKX demo or live orders.

[Architecture](docs/ARCHITECTURE.md) · [CV project description](docs/RESUME.md) · [OKX API documentation](https://www.okx.com/docs-v5/en/)

## Implemented features

- **Configurable strategies:** JSON-based rules with ALL/ANY composition, long/short/both direction selection, and validated indicator parameters.
- **Six condition types:** moving-average crossover, price relative to a moving average, Parabolic SAR direction, RSI thresholds, relative volume, and MACD histogram direction. Moving averages support SMA and EMA.
- **Intrabar signal evaluation:** compare consecutive observed market snapshots to detect a crossover while a candle is forming; suppress ambiguous simultaneous long/short signals.
- **OKX public market adapter:** normalize and validate public OHLCV and ticker responses, with explicit errors instead of fabricated market-data fallback.
- **Local paper execution:** poll market data, calculate position size, simulate protective exits, prevent repeated entries in one candle, enforce cooldowns, and pause entries after a daily equity-loss threshold.
- **Historical evaluation:** confirmed-bar signals, next-bar entry, fixed fee/slippage assumptions, adverse gap stops, and conservative stop-first handling when both protective levels are touched.
- **Persistence and recovery:** atomically saved local state; new entries pause after restart while saved simulated positions remain available for monitoring.
- **Automated validation:** 27 Node.js tests and a GitHub Actions workflow configured for Node.js 22 and 24. Local checks currently pass; a configured workflow is not itself proof of a successful hosted run.

## Technology

| Area | Current implementation |
| --- | --- |
| Language | JavaScript with native ES modules |
| Runtime and HTTP API | Node.js 22+, built-in HTTP server and Fetch API |
| Market data | OKX public REST API, USDT perpetual candles and tickers |
| Strategy representation | Validated JSON configuration |
| Persistence | Local JSON ledger, serialized writes and atomic rename |
| Testing | `node:test`, `node:assert/strict`, deterministic synthetic fixtures |
| Continuous integration | GitHub Actions workflow |
| Runtime dependencies | No third-party packages |

## Run locally

Requires Node.js 22 or newer. No dependency installation is necessary.

```sh
git clone https://github.com/kyy55555/signalforge.git
cd signalforge
npm test
npm run demo
npm start
```

The service listens at `http://127.0.0.1:4173`. At this stage, use the JSON API; the visual web interface has not been implemented. For example, open `http://127.0.0.1:4173/api/status` to inspect the paper account. Strategies start disabled. The initial local simulated balance is 10,000 USDT.

`npm run demo` evaluates a reproducible **synthetic** candle fixture. Its output demonstrates the engine and is not actual market performance.

Optional configuration is documented in `.env.example`. To load a local environment file explicitly:

```sh
node --env-file=.env server.mjs
```

`OKX_PUBLIC_URL` defaults to `https://www.okx.com`. Public API availability and the applicable official host may differ by region. This project does not request exchange API keys.

## Strategy example

```js
import { DEFAULT_STRATEGY, evaluateStrategy } from './dist/engine.js';

const strategy = structuredClone(DEFAULT_STRATEGY);
strategy.instrument = 'BTC-USDT-SWAP';
strategy.timeframe = '15m';
strategy.trigger = 'intrabar';
strategy.direction = 'long';
strategy.logic = 'all';
strategy.conditions = [
  { id: 'trend', type: 'ma_cross', ma: 'EMA', period: 20 },
  { id: 'confirmation', type: 'sar', step: 0.02, max: 0.2 },
  { id: 'momentum', type: 'rsi', period: 14, operator: 'gt', value: 50 },
];
// Supply validated, chronologically ordered OHLCV snapshots:
// const result = evaluateStrategy(currentCandles, strategy, previousCandles);
```

This rule requires an observed upward EMA crossover, bullish SAR, and RSI above 50 in the current evaluation. A crossover is an event between snapshots; the other conditions are states. The code does not retain a crossover event indefinitely while waiting for the remaining conditions.

## Local HTTP API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/status` | Paper-account state, strategies, positions, trades, and logs |
| `GET /api/candles?instrument=BTC-USDT-SWAP&timeframe=15m` | Up to 300 public OKX candles |
| `GET /api/strategies` | Read saved strategies |
| `PUT /api/strategies` | Save `{ "strategies": [...] }` while execution is paused |
| `POST /api/start` | Arm a local paper strategy using `{ "strategy": {...} }` |
| `POST /api/pause` | Pause new entries using `{}`; existing simulated exits remain monitored |
| `POST /api/reset` | Reset with `{ "equity": 10000 }` only when paused and flat |

The server binds to loopback and validates Host, Origin, JSON content type, and payload size. It has no multi-user authentication and is not intended to be exposed directly to the Internet. Runtime state is stored in `.data/paper-state.json` and excluded from Git.

## Execution and evaluation assumptions

- The runtime polls every five seconds; network requests add latency. It can miss movements between samples and is not tick-by-tick execution. Two valid snapshots are required before entries.
- Each strategy can enter at most once per candle. Only one simulated position is permitted per instrument. Position size uses the lesser of account equity and configured capital, subject to risk and margin caps.
- Stops and targets are fixed when a simulated position opens. Subsequent configuration changes do not modify them. They are local price checks, **not broker-held orders**; process shutdown or data loss prevents execution.
- Paper fills use the latest observed price, not high/low values from before the position opened. Fees are assumed to be 0.05% per side and slippage 0.02% per side; these are modeling choices, not a user's actual fee tier.
- Paper daily drawdown includes unrealized P&L and uses a UTC day boundary. The most restrictive applicable daily limit pauses new entries without forcing existing positions closed. Paused strategies require manual re-arming.
- Historical simulation uses confirmed bars and next-bar entry. Its daily entry limit uses realized equity, and drawdown is sampled at bar closes. It cannot reconstruct the intrabar path or validate intrabar execution performance.
- Quantities are measured in base-asset units, not OKX contract counts. Funding, liquidation, maintenance margin, contract rounding, partial fills, and order-book depth are not modeled.
- Tests establish the specific covered behavior. No profitability, latency benchmark, production reliability, or live-trading readiness is claimed.

## Roadmap

- [ ] Responsive visual rule editor and market charting
- [ ] Reference-data validation and broader historical datasets
- [ ] WebSocket ingestion and recorded intrabar replay
- [ ] Secure OKX demo-trading integration and contract-size conversion
- [ ] Broker-side protective orders, reconciliation, and recovery
- [ ] Deployment, monitoring, and controlled acceptance testing

## Project structure

```text
signalforge/
├── dist/engine.js             # Shared research engine; retained browser-ready module
├── server.mjs                # Public market adapter and local paper API/runtime
├── examples/research-demo.mjs # Reproducible synthetic demonstration
├── test/                     # Engine and execution-safety tests
├── docs/                     # Architecture and CV wording
└── .github/workflows/test.yml # Repeatable checks on Node.js 22 and 24
```

## 中文简介

SignalForge 是一个开发中的可配置量化策略研究项目，面向 OKX USDT 本位永续合约。当前已实现策略指标引擎、盘中快照信号判断、本地模拟执行、风控和 OHLC 回测；网页可视化编辑器、OKX 模拟盘和实盘下单尚未接入。用户可以组合“突破均线＋SAR 同向＋其他指标”的条件。模拟结果用于研究程序行为，不能证明策略盈利。
