import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BARS = new Map([['1m',60000],['3m',180000],['5m',300000],['15m',900000],['30m',1800000],['1H',3600000],['2H',7200000],['4H',14400000],['6H',21600000],['12H',43200000],['1D',86400000]]);
const FEE = 0.0005;
const SLIPPAGE = 0.0002;
const clone = value => JSON.parse(JSON.stringify(value));
const finite = value => Number.isFinite(Number(value));
const positive = value => finite(value) && Number(value) > 0;
const utcDay = now => new Date(now).toISOString().slice(0, 10);
const marketKey = (instrument,timeframe) => `${instrument}:${timeframe}`;
const barName = timeframe => /^\d+[hd]$/i.test(timeframe) ? timeframe.toUpperCase() : timeframe;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function validateMarket(instrument,timeframe) {
  if (!/^[A-Z0-9]{2,16}-USDT-SWAP$/.test(instrument || '')) throw new HttpError(400,'仅支持 OKX USDT 本位永续合约');
  if (!BARS.has(barName(timeframe))) throw new HttpError(400,'不支持的 K 线周期');
  return {instrument,timeframe:barName(timeframe)};
}

export function normalizeCandles(rows) {
  if (!Array.isArray(rows) || rows.length < 2) throw new HttpError(502,'OKX 没有返回足够的 K 线');
  const candles = rows.map(row => ({time:Number(row[0]),open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),volume:Number(row[5]),confirmed:String(row[8]) === '1'})).sort((a,b) => a.time-b.time);
  for (let i=0;i<candles.length;i++) {
    const c=candles[i];
    if (![c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) || c.time<=0 || Math.min(c.open,c.high,c.low,c.close)<=0 || c.volume<0 || c.high<Math.max(c.open,c.close,c.low) || c.low>Math.min(c.open,c.close,c.high) || (i && candles[i-1].time>=c.time)) throw new HttpError(502,'OKX K 线格式异常，已停止评估');
  }
  return candles;
}

export function createMarketClient({fetchImpl=globalThis.fetch,now=Date.now,baseURL='https://www.okx.com'}={}) {
  const allowed = ['https://www.okx.com','https://openapi.okx.com','https://us.okx.com','https://eea.okx.com'];
  if (!allowed.includes(baseURL)) throw new Error('OKX_PUBLIC_URL 必须是受支持的 OKX 官方 HTTPS 地址');
  const cache = new Map();
  async function get(path) {
    let response;
    try { response=await fetchImpl(`${baseURL}${path}`,{signal:AbortSignal.timeout(8000),headers:{Accept:'application/json'}}); }
    catch { throw new HttpError(502,'无法连接 OKX 公共行情；请检查网络或账户所在地区的官方 API 地址'); }
    if (!response.ok) throw new HttpError(502,`OKX 行情请求失败（HTTP ${response.status}）`);
    const data=await response.json();
    if (data.code!=='0' || !Array.isArray(data.data)) throw new HttpError(502,`OKX 行情不可用（${String(data.code || '未知错误').slice(0,20)}）`);
    return data.data;
  }
  return {
    async candles(instrument,timeframe) {
      const m=validateMarket(instrument,timeframe), key=marketKey(m.instrument,m.timeframe), cached=cache.get(key);
      if(cached && now()-cached.fetchedAt<3500) return clone(cached);
      const rows=await get(`/api/v5/market/candles?instId=${encodeURIComponent(m.instrument)}&bar=${encodeURIComponent(m.timeframe)}&limit=300`);
      const result={candles:normalizeCandles(rows),source:'okx',fetchedAt:now()};
      cache.set(key,result);return clone(result);
    },
    async ticker(instrument) {
      validateMarket(instrument,'1m');
      const rows=await get(`/api/v5/market/ticker?instId=${encodeURIComponent(instrument)}`), ticker=rows[0];
      if(!ticker || !positive(ticker.last) || !positive(ticker.ts)) throw new HttpError(502,'OKX 最新价格无效');
      return {price:Number(ticker.last),time:Number(ticker.ts)};
    }
  };
}

export class PaperRuntime {
  constructor({engine,market,state,now=Date.now,persist=async()=>{}}) {
    this.engine=engine;this.market=market;this.now=now;this.persist=persist;this.previous=new Map();this.lastTickerTime=new Map();this.busy=false;this.timer=null;
    this.state=state || {version:1,mode:'paper',initialEquity:10000,balance:10000,day:utcDay(now()),dayStartEquity:10000,circuitBroken:false,strategies:[],positions:[],trades:[],logs:[],lastEntry:{},lastExit:{},marketSource:'unavailable',lastMarketAt:null};
    this.state.strategies.forEach(s=>s.enabled=false);
    if(this.state.positions.length) this.log('warn','服务已重启：新开仓暂停；已有模拟仓位恢复价格监控');
  }
  log(level,message,detail) {
    this.state.logs.unshift({id:randomUUID(),time:this.now(),level,message,...(detail?{detail}: {})});
    this.state.logs=this.state.logs.slice(0,200);
  }
  equity() { return this.state.balance + this.state.positions.reduce((sum,p)=>sum+(p.lastPrice-p.entryPrice)*p.quantity*(p.direction==='long'?1:-1),0); }
  status() {
    const s=clone(this.state);
    return {...s,executionAvailable:true,mode:'paper',equity:this.equity(),availableMargin:Math.max(0,this.equity()-s.positions.reduce((sum,p)=>sum+p.margin,0)),running:s.strategies.some(x=>x.enabled),pollIntervalMs:5000,serverTime:this.now(),notice:'本机模拟执行；不是 OKX 模拟盘或实盘。关闭服务器后停止监控。'};
  }
  validate(strategy) {
    const errors=this.engine.validateStrategy(strategy);
    if(errors.length) throw new HttpError(400,errors.join('；'));
    validateMarket(strategy.instrument,strategy.timeframe);
    if(strategy.trigger!=='intrabar') throw new HttpError(400,'当前执行服务仅支持盘中触发');
    if(typeof strategy.id!=='string' || !/^[\w-]{1,64}$/.test(strategy.id)) throw new HttpError(400,'策略 ID 格式不正确');
  }
  async saveStrategies(strategies) {
    if(!Array.isArray(strategies) || strategies.length>20) throw new HttpError(400,'策略必须是数组，最多 20 个');
    for(const s of strategies) this.validate(s);
    if(new Set(strategies.map(s=>s.id)).size!==strategies.length) throw new HttpError(400,'策略 ID 不能重复');
    if(this.state.strategies.some(s=>s.enabled)) throw new HttpError(409,'请先暂停执行，再修改策略');
    this.state.strategies=clone(strategies).map(s=>({...s,enabled:false}));
    this.log('info','已保存策略配置');await this.persist(this.state);return this.status();
  }
  async start(strategy) {
    this.validate(strategy);
    if(this.state.circuitBroken && this.state.day===utcDay(this.now())) throw new HttpError(409,'当日亏损限制已触发，暂停新开仓至下一个 UTC 交易日');
    if(this.state.strategies.some(s=>s.id!==strategy.id && s.enabled && s.instrument===strategy.instrument)) throw new HttpError(409,'同一合约只允许一个运行中的策略');
    const existing=this.state.strategies.find(s=>s.id===strategy.id);
    if(existing?.enabled) throw new HttpError(409,'该策略已运行，请先暂停再修改');
    const copy={...clone(strategy),enabled:true};
    this.state.strategies=this.state.strategies.filter(s=>s.id!==copy.id).concat(copy);
    this.previous.delete(marketKey(copy.instrument,copy.timeframe));
    this.log('info',`已启用本地模拟：${copy.name}；等待两次有效行情快照`);
    await this.persist(this.state);return this.status();
  }
  async pause(reason='已暂停全部策略的新开仓；已有模拟仓位继续执行止盈止损') {
    this.state.strategies.forEach(s=>s.enabled=false);this.log('info',reason);await this.persist(this.state);return this.status();
  }
  async reset(equity=10000) {
    if(this.state.strategies.some(s=>s.enabled) || this.state.positions.length) throw new HttpError(409,'请暂停全部策略并等待已有仓位平仓后重置');
    if(!positive(equity) || equity<100 || equity>1e8) throw new HttpError(400,'模拟初始资金应为 100–100,000,000 USDT');
    Object.assign(this.state,{initialEquity:Number(equity),balance:Number(equity),day:utcDay(this.now()),dayStartEquity:Number(equity),circuitBroken:false,trades:[],lastEntry:{},lastExit:{},logs:[]});
    this.previous.clear();this.log('info','已重置本地模拟账户');await this.persist(this.state);return this.status();
  }
  checkDayAndLoss() {
    const day=utcDay(this.now()),equity=this.equity();
    if(day!==this.state.day) {this.state.day=day;this.state.dayStartEquity=equity;this.state.circuitBroken=false;this.log('info','新的 UTC 交易日，亏损基准已更新；暂停的策略需要手动启用');}
    const limits=[...this.state.strategies.filter(s=>s.enabled).map(s=>Number(s.risk.dailyLossPct)),...this.state.positions.map(p=>Number(p.dailyLossPct))].filter(positive);
    if(!limits.length || this.state.circuitBroken) return;
    const limit=Math.min(...limits);
    if(equity<=this.state.dayStartEquity*(1-limit/100)) {
      this.state.circuitBroken=true;this.state.strategies.forEach(s=>s.enabled=false);
      this.log('warn',`当日权益亏损达到 ${limit}%：已暂停新开仓，已有仓位继续受止损保护`);
    }
  }
  closePosition(position,price,reason,candleTime) {
    const sign=position.direction==='long'?1:-1,exitPrice=price*(1-sign*SLIPPAGE),exitFee=position.quantity*exitPrice*FEE;
    const grossPnl=(exitPrice-position.entryPrice)*position.quantity*sign;
    this.state.balance+=grossPnl-exitFee;
    this.state.trades.unshift({...position,id:randomUUID(),exitPrice,exitTime:this.now(),reason,grossPnl,fees:position.entryFee+exitFee,netPnl:grossPnl-position.entryFee-exitFee});
    this.state.trades=this.state.trades.slice(0,1000);
    this.state.positions=this.state.positions.filter(p=>p.id!==position.id);
    this.state.lastExit[position.strategyId]=candleTime;
    this.log('info',`${position.instrument} 模拟${reason==='stop'?'止损':'止盈'}平仓`,{netPnl:grossPnl-position.entryFee-exitFee});
  }
  processMarket(instrument,timeframe,candles,ticker) {
    const now=this.now(),barMs=BARS.get(barName(timeframe)),last=candles.at(-1),key=marketKey(instrument,timeframe);
    if(!last || !positive(ticker.price) || !positive(ticker.time) || now-ticker.time>30000 || ticker.time-now>5000 || now-last.time>barMs+45000 || last.time-now>5000) {
      this.previous.delete(key);throw new HttpError(502,`${instrument} 行情过期，跳过策略与模拟成交`);
    }
    const prior=this.previous.get(key),priorLast=prior?.at(-1);
    if(ticker.time<(this.lastTickerTime.get(instrument)||0) || (priorLast && (last.time<priorLast.time || (last.time===priorLast.time && last.volume<priorLast.volume)))) {
      throw new HttpError(502,`${instrument} 行情快照倒退，跳过本次评估`);
    }
    this.lastTickerTime.set(instrument,ticker.time);
    this.state.marketSource='okx';this.state.lastMarketAt=ticker.time;
    for(const p of [...this.state.positions].filter(p=>p.instrument===instrument)) {
      p.lastPrice=ticker.price;p.lastPriceTime=ticker.time;
      const isLong=p.direction==='long';
      if(isLong?ticker.price<=p.stopPrice:ticker.price>=p.stopPrice) this.closePosition(p,ticker.price,'stop',last.time);
      else if(isLong?ticker.price>=p.takePrice:ticker.price<=p.takePrice) this.closePosition(p,ticker.price,'take',last.time);
    }
    this.checkDayAndLoss();
    this.previous.set(key,clone(candles));
    if(!prior || this.state.circuitBroken) return;
    for(const strategy of this.state.strategies.filter(s=>s.enabled && s.instrument===instrument && s.timeframe===timeframe)) {
      if(this.state.positions.some(p=>p.instrument===instrument) || this.state.lastEntry[strategy.id]===last.time) continue;
      const lastExit=this.state.lastExit[strategy.id];
      if(lastExit!=null && last.time<=lastExit+strategy.risk.cooldownBars*barMs) continue;
      const result=this.engine.evaluateStrategy(candles,strategy,prior);
      if(result.errors?.length || !['long','short'].includes(result.signal)) continue;
      const sign=result.signal==='long'?1:-1,entryPrice=ticker.price*(1+sign*SLIPPAGE),equity=this.equity();
      let size;
      try {size=this.engine.positionSize(entryPrice,{...strategy.risk,equity:Math.min(equity,strategy.risk.equity)});} catch {this.log('warn','仓位计算无效，未开仓');continue;}
      const available=equity-this.state.positions.reduce((sum,p)=>sum+p.margin,0),entryFee=size.notional*FEE;
      if(![size.quantity,size.margin,size.notional].every(positive) || size.margin+entryFee>available || equity<=0) continue;
      const position={id:randomUUID(),strategyId:strategy.id,strategyName:strategy.name,instrument,timeframe,direction:result.signal,entryPrice,entryTime:now,entryCandle:last.time,quantity:size.quantity,notional:size.notional,margin:size.margin,entryFee,stopPrice:entryPrice*(1-sign*strategy.risk.stopPct/100),takePrice:entryPrice*(1+sign*strategy.risk.takePct/100),dailyLossPct:strategy.risk.dailyLossPct,lastPrice:ticker.price,lastPriceTime:ticker.time};
      this.state.balance-=entryFee;this.state.positions.push(position);this.state.lastEntry[strategy.id]=last.time;
      this.log('info',`${instrument} 模拟开${result.signal==='long'?'多':'空'}；止损与止盈已记录`,{quantity:size.quantity,entryPrice,stopPrice:position.stopPrice,takePrice:position.takePrice});
      this.checkDayAndLoss();
    }
  }
  async tick() {
    if(this.busy) return;this.busy=true;
    try {
      this.checkDayAndLoss();
      const pairs=new Map();
      for(const s of this.state.strategies.filter(s=>s.enabled)) pairs.set(marketKey(s.instrument,s.timeframe),s);
      for(const p of this.state.positions) if(![...pairs.values()].some(s=>s.instrument===p.instrument)) pairs.set(marketKey(p.instrument,p.timeframe),p);
      for(const {instrument,timeframe} of pairs.values()) {
        try {
          const [data,ticker]=await Promise.all([this.market.candles(instrument,timeframe),this.market.ticker(instrument)]);
          this.processMarket(instrument,timeframe,data.candles,ticker);
        } catch(error) {
          this.previous.delete(marketKey(instrument,timeframe));this.state.marketSource='unavailable';
          const message=String(error.message).slice(0,220);
          if(this.state.logs[0]?.message!==message || this.now()-this.state.logs[0].time>60000) this.log('warn',message);
        }
      }
      if(pairs.size) await this.persist(this.state);
    } catch(error) {this.state.strategies.forEach(s=>s.enabled=false);this.log('error','状态保存失败：已暂停所有新开仓');}
    finally {this.busy=false;}
  }
  run() {if(!this.timer) {this.timer=setInterval(()=>void this.tick(),5000);this.timer.unref();void this.tick();}}
  stop() {clearInterval(this.timer);this.timer=null;}
}

export function safeRequest(req,port) {
  const hosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
  if(!hosts.has(req.headers.host)) throw new HttpError(403,'只允许本机访问');
  if(req.headers.origin && ![`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(req.headers.origin)) throw new HttpError(403,'拒绝跨站请求');
  if(req.headers['sec-fetch-site']==='cross-site') throw new HttpError(403,'拒绝跨站请求');
}

async function jsonBody(req) {
  if(!String(req.headers['content-type']||'').startsWith('application/json')) throw new HttpError(415,'请求必须使用 application/json');
  let text='',bytes=0;
  for await(const chunk of req) {bytes+=chunk.length;if(bytes>65536) throw new HttpError(413,'请求内容过大');text+=chunk.toString('utf8');}
  try {return JSON.parse(text||'{}');} catch {throw new HttpError(400,'JSON 格式错误');}
}

export function createHttpServer({runtime,market,port=4173,dist=join(ROOT,'dist')}) {
  return http.createServer(async(req,res)=>{
    const respond=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
    try {
      safeRequest(req,port);
      const url=new URL(req.url,'http://127.0.0.1');
      if(url.pathname.startsWith('/api/')) {
        if(req.method==='GET' && url.pathname==='/api/status') return respond(200,runtime.status());
        if(req.method==='GET' && url.pathname==='/api/strategies') return respond(200,{strategies:runtime.status().strategies});
        if(req.method==='GET' && url.pathname==='/api/candles') return respond(200,await market.candles(url.searchParams.get('instrument')||'BTC-USDT-SWAP',url.searchParams.get('timeframe')||'15m'));
        if(req.method==='PUT' && url.pathname==='/api/strategies') {const body=await jsonBody(req);return respond(200,await runtime.saveStrategies(Array.isArray(body)?body:body.strategies));}
        if(req.method==='POST' && url.pathname==='/api/start') {const body=await jsonBody(req);return respond(200,await runtime.start(body.strategy));}
        if(req.method==='POST' && url.pathname==='/api/pause') {await jsonBody(req);return respond(200,await runtime.pause());}
        if(req.method==='POST' && url.pathname==='/api/reset') {const body=await jsonBody(req);return respond(200,await runtime.reset(body.equity));}
        return respond(404,{error:'接口不存在'});
      }
      if(req.method!=='GET' && req.method!=='HEAD') throw new HttpError(405,'请求方法不支持');
      const relative=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname),file=resolve(dist,`.${relative}`);
      if(!file.startsWith(resolve(dist)+'/')) throw new HttpError(403,'路径不可访问');
      let buffer;try {buffer=await readFile(file);}catch {throw new HttpError(404,'页面不存在');}
      const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json','.png':'image/png','.ico':'image/x-icon'};
      res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://www.okx.com https://openapi.okx.com https://us.okx.com https://eea.okx.com; frame-ancestors 'self'"});
      res.end(req.method==='HEAD'?undefined:buffer);
    }catch(error){respond(error.status||500,{error:error.status?error.message:'服务器处理失败；未发送任何交易所订单'});}
  });
}

export async function createPersistentRuntime({engine,market,dataDirectory=join(ROOT,'.data'),now=Date.now}) {
  await mkdir(dataDirectory,{recursive:true});const file=join(dataDirectory,'paper-state.json');let state;
  try {state=JSON.parse(await readFile(file,'utf8'));if(state.version!==1 || !Array.isArray(state.strategies) || !Array.isArray(state.positions) || !Array.isArray(state.trades) || !positive(state.initialEquity) || !finite(state.balance)) throw new Error('invalid');}
  catch(error){if(error.code!=='ENOENT') throw new Error('模拟账户状态文件损坏；请保留文件后检查，避免覆盖已有持仓记录');}
  let writing=Promise.resolve();
  const persist=next=>{const text=JSON.stringify(next,null,2);writing=writing.catch(()=>{}).then(async()=>{const temp=`${file}.tmp`;await writeFile(temp,text,{mode:0o600});await rename(temp,file);});return writing;};
  const runtime=new PaperRuntime({engine,market,state,now,persist});await persist(runtime.state);return runtime;
}

async function main() {
  const port=Number(process.env.PORT||4173);
  if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('PORT 应为 1024–65535');
  const engine=await import('./dist/engine.js');
  const market=createMarketClient({baseURL:process.env.OKX_PUBLIC_URL||'https://www.okx.com'});
  const runtime=await createPersistentRuntime({engine,market});
  const server=createHttpServer({runtime,market,port});
  server.listen(port,'127.0.0.1',()=>{console.log(`Local: http://127.0.0.1:${port}`);console.log('本机模拟交易服务；不连接 OKX 私有交易接口。');runtime.run();});
  const shutdown=()=>{runtime.stop();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();};
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(error=>{console.error(error.message);process.exitCode=1;});
