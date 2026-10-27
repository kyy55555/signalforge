import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PaperRuntime,normalizeCandles,safeRequest,createMarketClient,createPersistentRuntime,validateMarket } from '../server.mjs';

const NOW=Date.UTC(2026,9,27,12,5);
const clone=x=>JSON.parse(JSON.stringify(x));
const strategy=()=>({id:'test',name:'Test',instrument:'BTC-USDT-SWAP',timeframe:'15m',direction:'long',trigger:'intrabar',logic:'all',conditions:[{id:'ma',type:'ma_cross',ma:'EMA',period:20}],risk:{equity:10000,riskPct:1,stopPct:1,takePct:2,leverage:3,maxMarginPct:20,dailyLossPct:3,cooldownBars:1},enabled:false});
const candles=()=>[{time:NOW-1200000,open:100,high:101,low:99,close:100,volume:20,confirmed:true},{time:NOW-300000,open:100,high:101,low:99,close:100,volume:5,confirmed:false}];
const stub={validateStrategy:s=>s?.id?[]:['invalid'],evaluateStrategy:()=>({signal:'long',errors:[]}),positionSize:price=>({quantity:1,notional:price,margin:price/3,riskAmount:1,stopDistance:1})};
const make=(options={})=>new PaperRuntime({engine:stub,market:{},now:()=>NOW,...options});
function feed(runtime,price=100,time=NOW,cs=candles()) {runtime.processMarket('BTC-USDT-SWAP','15m',cs,{price,time});}

test('OKX candles normalize chronological order and reject invalid OHLC',()=>{
  const result=normalizeCandles([[2,'10','11','9','10','1','0','0','0'],[1,'10','11','9','10','1','0','0','1']]);
  assert.deepEqual(result.map(c=>[c.time,c.confirmed]),[[1,true],[2,false]]);
  assert.throws(()=>normalizeCandles([[1,10,9,8,10,1,0,0,'1'],[2,10,11,9,10,1,0,0,'1']]),/格式异常/);
});

test('requires two live snapshots, dedupes same candle after stop, keeps immutable protection',async()=>{
  const runtime=make(),s=strategy();await runtime.start(s);
  feed(runtime);assert.equal(runtime.state.positions.length,0);
  feed(runtime);assert.equal(runtime.state.positions.length,1);
  const stop=runtime.state.positions[0].stopPrice;
  s.risk.stopPct=10;assert.equal(runtime.state.positions[0].stopPrice,stop);
  feed(runtime,98);assert.equal(runtime.state.positions.length,0);assert.equal(runtime.state.trades.length,1);
  feed(runtime,100);assert.equal(runtime.state.positions.length,0);
  assert.ok(runtime.state.trades[0].netPnl<0);assert.ok(runtime.state.trades[0].fees>0);
});

test('pausing blocks entries but preserves and executes stop protection',async()=>{
  const runtime=make();await runtime.start(strategy());feed(runtime);feed(runtime);
  await runtime.pause();assert.equal(runtime.state.positions.length,1);
  feed(runtime,98);assert.equal(runtime.state.positions.length,0);assert.equal(runtime.state.trades[0].reason,'stop');
  feed(runtime,100);assert.equal(runtime.state.positions.length,0);
});

test('fresh ticker crossing never uses earlier candle low/high for exits',async()=>{
  const runtime=make();await runtime.start(strategy());const cs=candles();cs[1].high=150;cs[1].low=50;
  feed(runtime,100,NOW,cs);feed(runtime,100,NOW,cs);feed(runtime,100,NOW,cs);
  assert.equal(runtime.state.positions.length,1);assert.equal(runtime.state.trades.length,0);
});

test('stale and regressing ticker data cannot create positions',async()=>{
  const runtime=make();await runtime.start(strategy());feed(runtime);
  assert.throws(()=>feed(runtime,100,NOW-31000),/行情过期/);assert.equal(runtime.state.positions.length,0);
  feed(runtime);assert.throws(()=>feed(runtime,100,NOW-1000),/快照倒退/);assert.equal(runtime.state.positions.length,0);
});

test('daily equity drawdown circuit pauses all new entries and leaves existing stops',async()=>{
  const runtime=make();await runtime.start(strategy());feed(runtime);feed(runtime);
  runtime.state.balance=9600;runtime.checkDayAndLoss();
  assert.equal(runtime.state.circuitBroken,true);assert.equal(runtime.state.strategies[0].enabled,false);assert.equal(runtime.state.positions.length,1);
  await assert.rejects(()=>runtime.start(strategy()),/亏损限制/);
});

test('restart pauses entries and retains positions and deduplication state',async()=>{
  const runtime=make();await runtime.start(strategy());feed(runtime);feed(runtime);
  const restarted=make({state:clone(runtime.state)});
  assert.equal(restarted.state.strategies[0].enabled,false);assert.equal(restarted.state.positions.length,1);
  assert.deepEqual(restarted.state.lastEntry,runtime.state.lastEntry);
  feed(restarted,98);assert.equal(restarted.state.positions.length,0);
});

test('cannot reset active strategies or open positions, or edit active configuration',async()=>{
  const runtime=make();await runtime.start(strategy());
  await assert.rejects(()=>runtime.reset(),/暂停全部策略/);
  await assert.rejects(()=>runtime.saveStrategies([strategy()]),/先暂停/);
  feed(runtime);feed(runtime);await runtime.pause();await assert.rejects(()=>runtime.reset(),/已有仓位/);
  feed(runtime,98);await runtime.reset(12000);assert.equal(runtime.status().equity,12000);
});

test('only one enabled strategy per instrument',async()=>{
  const runtime=make();await runtime.start(strategy());
  await assert.rejects(()=>runtime.start({...strategy(),id:'another'}),/只允许一个/);
});

test('host and Origin guards reject DNS rebinding and cross-site writes',()=>{
  assert.doesNotThrow(()=>safeRequest({headers:{host:'127.0.0.1:4173',origin:'http://127.0.0.1:4173'}},4173));
  assert.throws(()=>safeRequest({headers:{host:'evil.example:4173'}},4173),/本机/);
  assert.throws(()=>safeRequest({headers:{host:'127.0.0.1:4173',origin:'https://evil.example'}},4173),/跨站/);
  assert.throws(()=>safeRequest({headers:{host:'127.0.0.1:4173','sec-fetch-site':'cross-site'}},4173),/跨站/);
});

test('only official public API targets and USDT perpetual markets are accepted',()=>{
  assert.throws(()=>createMarketClient({baseURL:'https://evil.example'}),/官方/);
  assert.throws(()=>validateMarket('BTC-USDT','15m'),/永续/);
  assert.throws(()=>validateMarket('BTC-USDT-SWAP','oops'),/周期/);
});

test('upstream failure surfaces explicitly without simulated fallback',async()=>{
  const market=createMarketClient({fetchImpl:async()=>({ok:false,status:503})});
  await assert.rejects(()=>market.candles('BTC-USDT-SWAP','15m'),/HTTP 503/);
});

test('persistent account survives reload with all entries paused',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'okx-paper-test-'));
  try {
    const runtime=await createPersistentRuntime({engine:stub,market:{},now:()=>NOW,dataDirectory:dir});await runtime.start(strategy());
    const stored=JSON.parse(await readFile(join(dir,'paper-state.json'),'utf8'));assert.equal(stored.strategies[0].enabled,true);
    const restored=await createPersistentRuntime({engine:stub,market:{},now:()=>NOW,dataDirectory:dir});assert.equal(restored.state.strategies[0].enabled,false);
    const resaved=JSON.parse(await readFile(join(dir,'paper-state.json'),'utf8'));assert.equal(resaved.strategies[0].enabled,false);
  }finally {await rm(dir,{recursive:true,force:true});}
});
