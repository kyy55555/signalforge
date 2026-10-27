# Graduate application project entry

Use this entry while the project is in development. Dates and individual responsibilities must match the applicant's actual work and contribution. Do not describe the future visual editor, exchange-side orders, cloud operation, or strategy performance as completed results.

## English CV version

**SignalForge: Configurable Trading Strategy Research Platform**  
Personal Project (In Development) | JavaScript, Node.js, OKX REST API, GitHub Actions | October 2026–Present  
[GitHub](https://github.com/kyy55555/signalforge)

- Developing a configurable strategy research platform for OKX USDT perpetual markets; implemented a shared JavaScript engine supporting six condition types, including moving averages, Parabolic SAR, RSI, volume, and MACD, with AND/OR rule composition.
- Built a Node.js paper-execution service that evaluates intrabar market snapshots and applies risk-based position sizing, simulated stop-loss/take-profit handling, duplicate-entry prevention, and daily equity-loss limits.
- Implemented OHLC backtesting with next-bar execution, transaction costs, slippage, and conservative stop-fill assumptions; documented the limitations of candle-based evaluation for intrabar strategies.
- Added automated tests for indicator calculations, signal logic, risk controls, persistence, and restart behavior, and configured a GitHub Actions workflow for repeatable checks.

## 中文对照

**SignalForge：可配置量化交易策略研究平台**  
个人项目（开发中）｜JavaScript、Node.js、OKX REST API、GitHub Actions｜2026 年 10 月至今

- 面向 OKX USDT 本位永续合约开发策略研究平台，实现可在浏览器与服务端复用的 JavaScript 策略引擎，支持均线、SAR、RSI、成交量和 MACD 等六类条件及 AND/OR 组合。
- 构建 Node.js 本地模拟执行服务，基于盘中行情快照判断信号，实现按风险预算计算仓位、模拟止盈止损、重复开仓防护及每日权益亏损限制。
- 实现基于 OHLC 的历史回测，纳入下一根 K 线成交、手续费、滑点和保守止损成交假设，并说明其与盘中交易的差异。
- 为指标计算、信号判断、风险控制、状态持久化和重启恢复编写自动化测试，并配置 GitHub Actions 检查流程。

## Shorter three-bullet version

- Developing a configurable strategy research platform for OKX perpetual markets using JavaScript and Node.js, with six technical-indicator condition types and AND/OR rule composition.
- Implemented intrabar signal evaluation and local paper execution with position sizing, simulated protective exits, duplicate-entry prevention, and daily loss limits.
- Built cost-aware OHLC backtesting and automated tests for indicator correctness, execution safeguards, and state persistence; configured GitHub Actions for repeatable validation.
