// lib/modelStats.js · 按模型聚合调用量/Token/响应速度 · 生而不有为而不恃
// 只记 次数/错误数/TTFB样本/Token累计,不记请求内容(隐私)
// 双口径:按天分桶(今日,含24小时桶供趋势图)+ 累计;落盘 state/model_stats.json

const fs = require("fs");
const path = require("path");

const STATE_DIR = path.join(__dirname, "..", "state");
const FILE = path.join(STATE_DIR, "model_stats.json");

const KEEP_DAYS = 30; // 按天分桶保留天数,超出自动清理
const MAX_SAMPLES = 200; // 每模型每口径保留的最近 TTFB 样本数(均值/P95 用)

let _data = null;
// { days: { "YYYY-MM-DD": { models:{<m>:{count,err,ttfb:[],tok:{in,out,cr,cc}}}, hours:[24]{c,tin,tout} } },
//   all:  { models: {<m>:{count,err,ttfb:[],tok:{in,out,cr,cc}}} } }

function _load() {
  if (_data) return _data;
  try {
    const v = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (v && typeof v === "object") {
      _data = { days: v.days || {}, all: v.all || { models: {} } };
    }
  } catch {}
  if (!_data) _data = { days: {}, all: { models: {} } };
  return _data;
}

function _save() {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(_data), "utf8");
  } catch (e) {
    console.error("[modelStats] save fail: " + e.message);
  }
}

function _today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 兼容旧结构条目(无 tok / 无 hours)的懒补齐
function _fixModel(m) {
  if (!m.tok) m.tok = { in: 0, out: 0, cr: 0, cc: 0 };
  return m;
}
function _fixDay(b) {
  if (!b.hours || b.hours.length !== 24) {
    const old = Array.isArray(b.hours) ? b.hours : [];
    b.hours = Array.from({ length: 24 }, (_, i) => old[i] || { c: 0, tin: 0, tout: 0 });
  }
  for (const k of Object.keys(b.models)) _fixModel(b.models[k]);
  return b;
}

function _bucket(models, model) {
  if (!models[model]) {
    models[model] = { count: 0, err: 0, ttfb: [], tok: { in: 0, out: 0, cr: 0, cc: 0 } };
  }
  return _fixModel(models[model]);
}

function _pushSample(m, ttfbMs) {
  m.ttfb.push(Math.round(ttfbMs));
  if (m.ttfb.length > MAX_SAMPLES) m.ttfb.shift();
}

function _prune(data) {
  const keys = Object.keys(data.days).sort();
  while (keys.length > KEEP_DAYS) delete data.days[keys.shift()];
}

// 记录一次请求完成
//   model  : 客户端模型名(与映射表视角一致)
//   ttfbMs : 客户端请求到达 → 上游首字节 的毫秒数(故障转移含全部重试耗时)
//   ok     : 上游状态码 < 400 视为成功;失败计 err 不计 TTFB 样本
//   tok    : {tokIn,tokOut,tokCacheRead,tokCacheCreate} 可为 null(未解析到)
function record(model, ttfbMs, ok, tok) {
  if (!model) return;
  tok = tok || {};
  const tin = tok.tokIn || 0;
  const tout = tok.tokOut || 0;
  const cr = tok.tokCacheRead || 0;
  const cc = tok.tokCacheCreate || 0;
  const data = _load();
  const dayKey = _today();
  if (!data.days[dayKey]) {
    data.days[dayKey] = { models: {}, hours: Array.from({ length: 24 }, () => ({ c: 0, tin: 0, tout: 0 })) };
    _prune(data);
  }
  const day = _fixDay(data.days[dayKey]);
  const d = _bucket(day.models, model);
  const a = _bucket(data.all.models, model);
  for (const m of [d, a]) {
    m.count++;
    if (!ok) m.err++;
    else _pushSample(m, ttfbMs);
    m.tok.in += tin;
    m.tok.out += tout;
    m.tok.cr += cr;
    m.tok.cc += cc;
  }
  // 小时桶(趋势图):所有请求都计数,token 只在能解析时累加
  const h = new Date().getHours();
  day.hours[h].c++;
  day.hours[h].tin += tin;
  day.hours[h].tout += tout;
  _save();
}

// 聚合单口径:模型列表(按调用量降序)+ 总调用数 + token 合计 + 整体 TTFB 均值/P95
function _agg(models) {
  let total = 0;
  const allSamples = [];
  const list = Object.entries(models).map(([name, m]) => {
    total += m.count;
    allSamples.push(...m.ttfb);
    const s = [...m.ttfb].sort((x, y) => x - y);
    // P95:向上取整取第 95 百分位样本;单样本时即该样本
    const p95 = s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : null;
    const avg = s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null;
    return {
      model: name,
      count: m.count,
      err: m.err,
      avgTtfb: avg,
      p95Ttfb: p95,
      tokIn: m.tok.in,
      tokOut: m.tok.out,
      tokCache: m.tok.cr + m.tok.cc,
    };
  });
  list.sort((a, b) => b.count - a.count);
  const sumTok = (k) => list.reduce((acc, m) => acc + m[k], 0);
  const pickP95 = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
  };
  return {
    total,
    tokIn: sumTok("tokIn"),
    tokOut: sumTok("tokOut"),
    tokCache: sumTok("tokCache"),
    avgTtfb: allSamples.length ? Math.round(allSamples.reduce((a, b) => a + b, 0) / allSamples.length) : null,
    p95Ttfb: pickP95(allSamples),
    models: list,
  };
}

// query(range) · range: "today" | "all"(默认);返回该口径聚合
function query(range) {
  const data = _load();
  if (range === "today") {
    const b = data.days[_today()];
    return { range, ..._agg((b && _fixDay(b).models) || {}) };
  }
  return { range: "all", ..._agg(data.all.models || {}) };
}

// 近 24 小时逐小时序列(跨今日/昨日两个天桶拼接),供概览趋势图
// 返回 [{label:"HH:00", count, tokIn, tokOut}] 按时间升序,最后一项为当前小时
function trend24h() {
  const data = _load();
  const now = new Date();
  const out = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const b = data.days[key];
    const h = b && b.hours ? b.hours[d.getHours()] : null;
    out.push({
      label: `${p(d.getHours())}:00`,
      count: h ? h.c : 0,
      tokIn: h ? h.tin : 0,
      tokOut: h ? h.tout : 0,
    });
  }
  return out;
}

// 区间聚合:把 [from,to](含两端,YYYY-MM-DD)范围内的天桶合并统计
// 供概览页自定义日期时间段;天桶仅保留 KEEP_DAYS 天,更早的区间查不到
function rangeQuery(from, to) {
  const data = _load();
  const merged = {};
  for (const key of Object.keys(data.days)) {
    if (key < from || key > to) continue;
    const b = _fixDay(data.days[key]);
    for (const [name, m] of Object.entries(b.models)) {
      const t =
        merged[name] ||
        (merged[name] = { count: 0, err: 0, ttfb: [], tok: { in: 0, out: 0, cr: 0, cc: 0 } });
      t.count += m.count;
      t.err += m.err;
      t.ttfb.push(...m.ttfb);
      t.tok.in += m.tok.in;
      t.tok.out += m.tok.out;
      t.tok.cr += m.tok.cr;
      t.tok.cc += m.tok.cc;
    }
  }
  return { from, to, ..._agg(merged) };
}

// 清空全部统计
function reset() {
  _data = { days: {}, all: { models: {} } };
  _save();
}

module.exports = { record, query, rangeQuery, trend24h, reset };
