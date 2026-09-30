/**
 * 记账 —— 零依赖 HTTP 服务。
 * Node 24+ 自带 sqlite，所以整个项目 npm install 不装任何东西，
 * Windows 上不需要编译工具链，也就不会有「装不上」这回事。
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  db, listCategories, categoryNames, addCategory, updateCategory, deleteCategory,
  findUploadBySha, insertUpload, updateUpload,
  getTransaction, updateTransaction, deleteTransaction,
  queryTransactions, rangeSummary, dateBounds,
  pendingCandidates, pendingCandidateCount, mergeCandidate, ignoreCandidate,
  unmergeTransaction,
  getMerchantRule, saveMerchantRule, deleteMerchantRule, listMerchantRules,
  bumpRuleHit, recategorizeMerchant, categoryHistoryExamples,
  unconvertedCount, usedCurrencies, recomputeMain, setUploadCurrency,
} from './lib/db.js';
import { reconcile, insertWithSeq, findCandidates, merchantKey, promotePending } from './lib/dedupe.js';
import { normalizeRow, normalizeAmountCents, normalizeDate, normalizeTime,
         normalizeCurrency, convertToMain } from './lib/normalize.js';
import { analyzeImage, classifyRows } from './lib/vision.js';
import { FALLBACK_CATEGORY } from './lib/categories.js';
import { loadConfig, saveConfig, publicConfig, PRESETS } from './lib/config.js';
import {
  normalizeStartDay, periodStartOf, periodEndInclusive, shiftPeriod,
  periodLabel, periodsBetween,
} from './lib/period.js';

const [major] = process.versions.node.split('.').map(Number);
if (major < 24) {
  console.error(`\n需要 Node.js 24 或更高版本（当前 ${process.versions.node}）。`);
  console.error('去 https://nodejs.org 下载 LTS 版本装一下就行。\n');
  process.exit(1);
}

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const UPLOADS = path.join(ROOT, 'data', 'uploads');
const MAX_BODY = 32 * 1024 * 1024;   // 32MB，够手机原图了

/**
 * 服务端代码是启动时载入内存的，拷了新文件不重启还跑着旧的 ——
 * 更新时最容易踩的坑，而且现象很迷惑（新页面出来了，接口却是 404）。
 * 每次开页面时比一下磁盘上的源码指纹，变了就提醒重启。
 */
function sourceFingerprint() {
  try {
    const files = ['server.js', ...readdirSync(path.join(ROOT, 'lib')).map(f => `lib/${f}`)]
      .filter(f => f.endsWith('.js')).sort();
    const h = createHash('sha1');
    for (const f of files) h.update(readFileSync(path.join(ROOT, f)));
    return h.digest('hex').slice(0, 12);
  } catch { return 'unknown'; }
}
const BOOT_FINGERPRINT = sourceFingerprint();

const pad = n => String(n).padStart(2, '0');
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/* 账期。默认 15 号起算：8/15–9/14 是一期，9/15 起算下一期。 */
const cycleDay = () => normalizeStartDay(loadConfig().cycle_start_day ?? 15);
const currentPeriod = () => periodStartOf(todayLocal(), cycleDay());

/** 账期起始日 → 闭区间 {from, to}。顺手把不是期首的日期归一化到它所属那一期。 */
function periodRange(startISO) {
  const d = cycleDay();
  const start = periodStartOf(startISO || todayLocal(), d);
  return { from: start, to: periodEndInclusive(start, d), start, day: d };
}

/**
 * 商户记忆优先于模型判断 —— 你手动定过的分类，模型说什么都不算数。
 * 这是分类稳定性的主要来源：常去的店只会按你定的那一类走。
 */
function applyMerchantRules(rows) {
  let applied = 0;
  for (const r of rows) {
    const rule = getMerchantRule(r.merchant_key);
    if (!rule) continue;
    if (rule.category !== r.category) { r.category = rule.category; applied++; }
    r.by_rule = true;
    bumpRuleHit(rule.merchant_key);   // 前缀匹配时规则的 key 和这笔的 key 不同，记在规则上
  }
  return applied;
}

/* ------------------------------------------------------------ 小工具 */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.heic': 'image/heic',
};
const extFromMime = m => ({
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
  'image/gif': '.gif', 'image/heic': '.heic', 'image/heif': '.heic',
}[m] || '.jpg');

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const json = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('图片太大了（上限 32MB），换张小一点的，或者用手机的「中等尺寸」导出'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJSON(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new Error('请求体不是合法 JSON'); }
}

function serveStatic(res, filePath, { download } = {}) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return send(res, 404, '404');
  const ext = path.extname(filePath).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  if (download) headers['Content-Disposition'] = `attachment; filename="${download}"`;
  // 原图按内容命名，永不变，可以放心长缓存
  if (filePath.startsWith(UPLOADS)) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  send(res, 200, readFileSync(filePath), headers);
}

/* ------------------------------------------------------ 上传 + 识别 */

async function handleUpload(req, res) {
  const body = await readJSON(req);
  const { data, mime = 'image/jpeg', filename = '' } = body;
  // 上传时可以直接指定这张图的币种，不让模型猜 —— 你知道这是哪张卡的账单
  const forced = body.currency && body.currency !== 'auto'
    ? normalizeCurrency(body.currency, null) : null;
  if (!data) return json(res, 400, { error: '没收到图片数据' });

  const buf = Buffer.from(String(data), 'base64');
  if (!buf.length) return json(res, 400, { error: '图片数据是空的' });

  // ---- 去重第①层：原文件指纹。同一张图再传，这里就拦下了。 ----
  const sha = createHash('sha256').update(buf).digest('hex');
  const dup = findUploadBySha(sha);
  if (dup && dup.status === 'ok') {
    const when = dup.created_at.slice(0, 10);
    const n = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE upload_id = ?').get(dup.id).n;
    return json(res, 200, {
      duplicate_image: true,
      message: `这张图 ${when} 已经传过了，当时记了 ${n} 笔，没有重复入账。`,
      upload: { id: dup.id, image: dup.stored_name, created_at: dup.created_at },
    });
  }

  const catRows = listCategories();          // 带 hint，喂给模型
  const cats = catRows.map(c => c.name);     // 只要名字，用于白名单校验
  const result = await analyzeImage({
    base64: buf.toString('base64'), mime, categories: catRows, today: todayLocal(),
  });

  const source = result.kind === 'receipt' ? 'receipt' : 'statement';
  const cfgNow = loadConfig();
  const rows = result.transactions
    .map(r => normalizeRow(r, {
      categories: cats, today: todayLocal(), source,
      mainCurrency: cfgNow.currency || 'USD', rates: cfgNow.rates || {},
    }))
    .filter(Boolean);

  // 指定了币种就整张图统一覆盖，模型认成什么都不算数
  if (forced) {
    const mainCcy = cfgNow.currency || 'USD';
    for (const r of rows) {
      r.currency = forced;
      r.main_cents = convertToMain(r.amount_cents, forced, mainCcy, cfgNow.rates || {});
    }
  }

  if (!rows.length) {
    // 一笔都没读出来就不落库，这样你换个模型还能重传同一张图
    return json(res, 200, {
      inserted: [], skipped: [], candidates: 0, kind: result.kind,
      message: '这张图里没读出任何交易。可能是图太糊、不是小票/账单，或者模型没认出来 —— 可以换张清晰点的，或去设置里换个模型。',
    });
  }

  const storedName = sha.slice(0, 16) + extFromMime(mime);
  const storedPath = path.join(UPLOADS, storedName);
  writeFileSync(storedPath, buf);

  // 截断的标成 partial —— 第①层看到 partial 会放行，让你重传同一张图补齐剩下的行
  const uploadStatus = result.truncated ? 'partial' : 'ok';
  let uploadId;
  try {
    const meta = {
      kind: result.kind, model: result.model,
      raw_json: result.raw?.slice(0, 20000) || null, status: uploadStatus, error: null,
    };
    uploadId = dup
      ? updateUpload(dup.id, meta)
      : insertUpload({ ...meta, sha256: sha, filename: String(filename).slice(0, 200),
                       stored_name: storedName, mime, bytes: buf.length });
  } catch (e) {
    if (!dup) { try { unlinkSync(storedPath); } catch {} }
    throw e;
  }

  // ---- 第二段：专职分类调用 ----
  // 视觉那次只给了个粗判，这里用一次纯文本调用重做，能带上分类提示、
  // 小票明细和你过去的分类习惯 —— 这些塞进 OCR 那次只会跟识别抢注意力。
  const classify = { changed: 0, skipped: true, failed: null };
  const cfg = loadConfig();
  if (cfg.classify?.enabled !== false) {
    // 已经有商户规则的行不用问模型 —— 规则最后会盖掉，白花一次额度
    const needs = rows.filter(r => !getMerchantRule(r.merchant_key));
    if (needs.length) {
      classify.skipped = false;
      try {
        const history = cfg.classify?.use_history === false
          ? []
          : categoryHistoryExamples(needs.map(r => r.merchant_key));
        classify.changed = (await classifyRows({
          rows: needs, categories: catRows, history, today: todayLocal(),
        })).changed;
      } catch (e) {
        // 分类挂了不该让整次上传白费 —— 降级用第一段的粗判，如实告诉用户
        classify.failed = e.message;
      }
    }
  }

  // ---- 商户记忆：你亲手定过的，盖掉上面一切 ----
  const ruled = applyMerchantRules(rows);

  // ---- Pending 提升：先把已入账的行和挂着的 pending 对上，避免记成两笔 ----
  const { promoted, rest } = promotePending(rows, source);

  // ---- 去重第②层：计数对账 ----
  const { toInsert, skipped } = reconcile(rest, source);

  const inserted = [];
  for (const r of toInsert) {
    const id = insertWithSeq({ ...r, upload_id: uploadId });
    inserted.push({ ...getTransaction(id), confidence: r.confidence });
  }
  const promotedRows = promoted.map(p => getTransaction(p.id));

  // ---- 去重第③层：找小票 ↔ 账单的疑似同一笔，只标记不动数据 ----
  let candidates = 0;
  for (const t of inserted) candidates += findCandidates(t.id);

  return json(res, 200, {
    kind: result.kind,
    source,
    upload: { id: uploadId, image: storedName },
    inserted,
    promoted: promotedRows,
    skipped,
    candidates,
    ruled,
    classify,
    truncated: Boolean(result.truncated),
    pending_total: pendingCandidateCount(),
    message: buildUploadMessage({ n: inserted.length, skipped: skipped.length,
                                  promoted: promoted.length,
                                  candidates, source, ruled, classify,
                                  truncated: result.truncated }),
  });
}

function buildUploadMessage({ n, skipped, promoted, candidates, source, ruled, classify, truncated }) {
  const what = source === 'receipt' ? '小票' : '账单截图';
  const parts = [`读到 ${what}，新记 ${n} 笔`];
  if (promoted) parts.push(`${promoted} 笔之前的待入账转成了正式入账（没有重复记）`);
  if (skipped) parts.push(`跳过 ${skipped} 笔重复的`);
  if (ruled) parts.push(`${ruled} 笔按你定过的商户分类归了类`);
  if (candidates) parts.push(`发现 ${candidates} 笔疑似和已有记录是同一笔，等你确认`);
  let msg = parts.join('，') + '。';
  if (truncated) {
    msg += ' ⚠ 模型输出被截断了，这张图可能还有没读到的行 —— 已把读到的先记下，'
         + '再传一次同一张图会接着补（不会重复）。老这样就去设置里把 max_tokens 调大。';
  }
  if (classify?.failed) msg += ` ⚠ 分类那步没跑成（${classify.failed}），先用了识别时的粗判，可以手动改。`;
  return msg;
}

/* ------------------------------------------------------------- 路由 */

const ROUTES = {
  'GET /api/bootstrap': () => {
    const day = cycleDay();
    const today = todayLocal();
    const b = dateBounds();
    // 有未来日期的账目时把上界撑到那天，否则那一期在下拉里看不见
    const upper = b.max && b.max > today ? b.max : today;
    const periods = periodsBetween(b.min || today, upper, day).map(start => ({
      start,
      end: periodEndInclusive(start, day),
      label: periodLabel(start, day, today),
    }));
    return {
      today,
      cycle_start_day: day,
      period: currentPeriod(),
      periods,
      categories: listCategories(),
      pending: pendingCandidateCount(),
      currency: loadConfig().currency || 'USD',
      rates: loadConfig().rates || {},
      unconverted: unconvertedCount(),
      currencies: usedCurrencies(),
      api_key_set: Boolean(loadConfig().vision.api_key),
      // 磁盘上的代码和内存里跑的不一致 = 拷了新文件但没重启
      stale: sourceFingerprint() !== BOOT_FINGERPRINT,
    };
  },

  'GET /api/summary': (u) => {
    const day = cycleDay();
    const { from, to, start } = periodRange(u.searchParams.get('period'));
    const prevStart = shiftPeriod(start, -1, day);
    return {
      ...rangeSummary({
        from, to,
        prevFrom: prevStart, prevTo: periodEndInclusive(prevStart, day),
      }),
      period: start,
      label: periodLabel(start, day, todayLocal()),
      prev_period: prevStart,
      cycle_start_day: day,
    };
  },

  'GET /api/rules': () => ({ rules: listMerchantRules() }),

  'GET /api/transactions': (u) => {
    const p = u.searchParams;
    const num = k => (p.get(k) ? Number(p.get(k)) : null);
    // 自定义起止日期优先；否则按账期
    const span = (p.get('from') || p.get('to'))
      ? { from: p.get('from') || null, to: p.get('to') || null }
      : (p.get('period') ? periodRange(p.get('period')) : { from: null, to: null });
    return queryTransactions({
      from: span.from,
      to: span.to,
      q: p.get('q') || null,
      category: p.get('category') || null,
      kind: p.get('kind') || null,
      min: num('min'), max: num('max'),
      limit: Math.min(num('limit') || 200, 1000),
      offset: num('offset') || 0,
    });
  },

  'GET /api/candidates': () => ({ candidates: pendingCandidates() }),

  'GET /api/config': () => ({ config: publicConfig(), presets: PRESETS }),
};

async function api(req, res, url) {
  const key = `${req.method} ${url.pathname}`;

  if (ROUTES[key]) return json(res, 200, ROUTES[key](url));

  if (key === 'POST /api/upload') return handleUpload(req, res);

  /* 手动记一笔 */
  if (key === 'POST /api/transactions') {
    const b = await readJSON(req);
    const cats = categoryNames();
    const row = normalizeRow(
      { merchant: b.merchant, date: b.date, time: b.time, amount: b.amount,
        kind: b.kind, category: b.category, currency: b.currency, merchant_raw: '' },
      { categories: cats, today: todayLocal(), source: 'manual',
        mainCurrency: loadConfig().currency || 'USD', rates: loadConfig().rates || {} }
    );
    if (!row) return json(res, 400, { error: '金额或日期没填对' });
    row.note = b.note ? String(b.note).slice(0, 500) : null;

    const { toInsert, skipped } = reconcile([row], 'manual');
    if (!toInsert.length) {
      return json(res, 200, { inserted: null, skipped, message: '这笔和已有记录一模一样，没有重复添加。' });
    }
    const id = insertWithSeq({ ...toInsert[0], upload_id: null });
    const candidates = findCandidates(id);
    return json(res, 200, {
      inserted: getTransaction(id), skipped: [], candidates,
      pending_total: pendingCandidateCount(),
      message: candidates ? `记好了，另外发现 ${candidates} 笔疑似重复，等你确认。` : '记好了。',
    });
  }

  /* 编辑 / 删除某一笔 */
  let m;
  if ((m = url.pathname.match(/^\/api\/transactions\/(\d+)$/))) {
    const id = Number(m[1]);
    const cur = getTransaction(id);
    if (!cur) return json(res, 404, { error: '这笔记录不存在' });

    if (req.method === 'DELETE') { deleteTransaction(id); return json(res, 200, { ok: true }); }

    if (req.method === 'PATCH') {
      const b = await readJSON(req);
      const cats = categoryNames();
      const merchant = b.merchant != null ? String(b.merchant).trim().slice(0, 120) : cur.merchant;
      const cents = b.amount != null ? normalizeAmountCents(b.amount) : cur.amount_cents;
      const date = b.date != null ? normalizeDate(b.date, todayLocal()) : cur.txn_date;
      if (!cents || !date) return json(res, 400, { error: '金额或日期没填对' });
      const cfgE = loadConfig();
      const ccy = b.currency ? normalizeCurrency(b.currency, cur.currency) : cur.currency;
      const mainCents = convertToMain(cents, ccy, cfgE.currency || 'USD', cfgE.rates || {});

      const updated = updateTransaction(id, {
        txn_date: date,
        txn_time: b.time !== undefined ? normalizeTime(b.time) : cur.txn_time,
        merchant: merchant || cur.merchant,
        merchant_key: merchantKey(merchant) || cur.merchant_key,
        amount_cents: cents,
        currency: ccy,
        main_cents: mainCents,
        category: cats.includes(b.category) ? b.category : cur.category,
        txn_kind: ['expense', 'refund', 'payment'].includes(b.kind) ? b.kind : cur.txn_kind,
        note: b.note !== undefined ? (b.note ? String(b.note).slice(0, 500) : null) : cur.note,
      });

      // 勾了「记住」：存成商户规则，并把这个商户的历史账目一起改过来
      let rule_saved = false, recategorized = 0;
      if (b.remember && updated) {
        saveMerchantRule(updated.merchant_key, updated.merchant, updated.category);
        rule_saved = true;
        recategorized = recategorizeMerchant(updated.merchant_key, updated.category, id);
      }
      return json(res, 200, { transaction: updated, rule_saved, recategorized });
    }
  }

  /* 撤销一次合并 */
  if ((m = url.pathname.match(/^\/api\/transactions\/(\d+)\/unmerge$/)) && req.method === 'POST') {
    const n = unmergeTransaction(Number(m[1]));
    return json(res, 200, { ok: true, released: n });
  }

  /* 疑似配对：合并 / 忽略 */
  if ((m = url.pathname.match(/^\/api\/candidates\/(\d+)\/(merge|ignore)$/)) && req.method === 'POST') {
    const id = Number(m[1]);
    if (m[2] === 'merge') {
      const kept = mergeCandidate(id);
      if (!kept) return json(res, 404, { error: '这条配对已经处理过了' });
      return json(res, 200, { ok: true, transaction: kept, pending_total: pendingCandidateCount() });
    }
    ignoreCandidate(id);
    return json(res, 200, { ok: true, pending_total: pendingCandidateCount() });
  }

  /* 事后把某张图的所有账目改成指定币种 */
  if ((m = url.pathname.match(/^\/api\/uploads\/(\d+)\/currency$/)) && req.method === 'POST') {
    const b = await readJSON(req);
    const c = loadConfig();
    const ccy = normalizeCurrency(b.currency, null);
    if (!ccy) return json(res, 400, { error: '币种没填对' });
    const r = setUploadCurrency(Number(m[1]), ccy, c.currency || 'USD', c.rates || {});
    if (!r.total) return json(res, 404, { error: '这张图没有对应的账目' });
    if (r.conflicts) {
      return json(res, 200, {
        ...r, currency: ccy,
        message: `没有改动 —— 改成 ${ccy} 之后有 ${r.conflicts} 笔会和库里已有的记录完全重复。`
          + '多半是这张账单之前已经用正确币种传过一次了，先去列表里核对一下。',
      });
    }
    const noRate = ccy !== (c.currency || 'USD') && !(Number(c.rates?.[ccy]) > 0);
    return json(res, 200, {
      ...r, currency: ccy,
      message: `这张图的 ${r.changed} 笔已改成 ${ccy}`
        + (noRate ? `。还没配 ${ccy} 的汇率，这些笔暂时不计入总额 —— 去上面补一个汇率再点重算。` : '。'),
    });
  }

  /* 改了汇率之后重算所有折算值（原币金额不动） */
  if (url.pathname === '/api/rates/recompute' && req.method === 'POST') {
    const c = loadConfig();
    const r = recomputeMain(c.currency || 'USD', c.rates || {});
    return json(res, 200, {
      ...r,
      message: r.unconverted
        ? `重算了 ${r.changed} 笔，其中 ${r.unconverted} 笔的币种还没配汇率。`
        : `重算了 ${r.changed} 笔，全部折算完毕。`,
    });
  }

  /* 删除一条商户记忆 */
  if (url.pathname === '/api/rules' && req.method === 'DELETE') {
    const key = url.searchParams.get('key') || '';
    return json(res, 200, { deleted: deleteMerchantRule(key), rules: listMerchantRules() });
  }

  /* 分类增删改 */
  if (url.pathname === '/api/categories' && req.method === 'POST') {
    const b = await readJSON(req);
    const name = String(b.name || '').trim().slice(0, 20);
    if (!name) return json(res, 400, { error: '分类名不能为空' });
    if (categoryNames().includes(name)) return json(res, 400, { error: '已经有这个分类了' });
    addCategory(name, b.color, b.hint ? String(b.hint).slice(0, 400) : null);
    return json(res, 200, { categories: listCategories() });
  }
  if ((m = url.pathname.match(/^\/api\/categories\/(\d+)$/))) {
    const id = Number(m[1]);
    if (req.method === 'PATCH') {
      const b = await readJSON(req);
      const name = String(b.name || '').trim().slice(0, 20);
      if (!name) return json(res, 400, { error: '分类名不能为空' });
      updateCategory(id, name, b.color, b.hint !== undefined ? String(b.hint).slice(0, 400) : undefined);
      return json(res, 200, { categories: listCategories() });
    }
    if (req.method === 'DELETE') {
      const moved = deleteCategory(id);
      if (!moved) return json(res, 400, { error: '至少得留一个分类' });
      return json(res, 200, { categories: listCategories(), moved_to: moved });
    }
  }

  /* 配置 */
  if (url.pathname === '/api/config' && req.method === 'PUT') {
    const b = await readJSON(req);
    const patch = { vision: {} };
    for (const k of ['provider', 'base_url', 'model', 'json_mode', 'reasoning_effort']) {
      if (b.vision?.[k] !== undefined) patch.vision[k] = b.vision[k];
    }
    if (b.vision?.max_tokens !== undefined) {
      const n = Math.trunc(Number(b.vision.max_tokens));
      patch.vision.max_tokens = Number.isFinite(n) ? Math.min(32000, Math.max(1000, n)) : 8000;
    }
    // 空字符串表示「不改 key」，打码值也不要覆盖真 key
    if (b.vision?.api_key && !b.vision.api_key.includes('••')) {
      patch.vision.api_key = String(b.vision.api_key).trim();
    }
    if (b.currency) patch.currency = normalizeCurrency(b.currency, 'USD');
    if (b.rates && typeof b.rates === 'object') {
      patch.rates = {};
      for (const [code, v] of Object.entries(b.rates)) {
        if (!/^[A-Za-z]{3}$/.test(code)) continue;
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) patch.rates[code.toUpperCase()] = n;
      }
    }
    if (b.cycle_start_day !== undefined) patch.cycle_start_day = normalizeStartDay(b.cycle_start_day);
    if (b.classify) {
      patch.classify = {};
      for (const k of ['provider', 'base_url', 'model']) {
        if (b.classify[k] !== undefined) patch.classify[k] = String(b.classify[k]).trim();
      }
      if (b.classify.enabled !== undefined) patch.classify.enabled = Boolean(b.classify.enabled);
      if (b.classify.use_history !== undefined) patch.classify.use_history = Boolean(b.classify.use_history);
      // 空字符串表示不改；打码值也不能覆盖真 key
      if (b.classify.api_key && !b.classify.api_key.includes('••')) {
        patch.classify.api_key = String(b.classify.api_key).trim();
      }
    }
    saveConfig(patch);
    return json(res, 200, { config: publicConfig() });
  }

  /* 连通性自检：两段分别打一次，分类那家的 key 填错不该等到上传时才发现 */
  if (url.pathname === '/api/config/test' && req.method === 'POST') {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const out = {};
    try {
      const r = await analyzeImage({
        base64: png.toString('base64'), mime: 'image/png',
        categories: listCategories(), today: todayLocal(),
      });
      out.vision = { ok: true, message: `识别接口通了，模型 ${r.model} 有正常响应。` };
    } catch (e) {
      out.vision = { ok: false, message: e.message };
    }

    const cfg = loadConfig();
    if (cfg.classify?.enabled === false) {
      out.classify = { ok: true, skipped: true, message: '分类调用已关掉，没测。' };
    } else {
      // 拿一笔假交易走一遍真实的分类链路
      const probe = [{
        merchant: 'Starbucks', txn_date: todayLocal(), amount_cents: 850,
        txn_kind: 'expense', category: FALLBACK_CATEGORY, note: null, items: [],
      }];
      try {
        const r = await classifyRows({
          rows: probe, categories: listCategories(), history: [], today: todayLocal(),
        });
        out.classify = {
          ok: true,
          message: `分类接口通了，模型 ${r.model} 把 Starbucks 判成了「${probe[0].category}」。`,
        };
      } catch (e) {
        out.classify = { ok: false, message: e.message };
      }
    }
    return json(res, 200, { ...out, ok: out.vision.ok && out.classify.ok });
  }

  return json(res, 404, { error: '没有这个接口' });
}

/* --------------------------------------------------------- CSV 导出 */

function exportCSV(res, url) {
  const p = url.searchParams;
  const span = (p.get('from') || p.get('to'))
    ? { from: p.get('from') || null, to: p.get('to') || null }
    : (p.get('period') ? periodRange(p.get('period')) : { from: null, to: null });
  const { rows } = queryTransactions({
    from: span.from, to: span.to,
    q: p.get('q') || null,
    category: p.get('category') || null,
    limit: 100000,
  });
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const mainCcy = loadConfig().currency || 'USD';
  const head = ['日期', '时间', '商户', `金额(${mainCcy})`, '原币金额', '原币种',
                '分类', '类型', '来源', '待入账', '备注'];
  const kindCN = { expense: '支出', refund: '退款', payment: '还款/转账' };
  const srcCN = { receipt: '小票', statement: '账单', manual: '手动' };
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([
      r.txn_date, r.txn_time || '', r.merchant,
      r.main_cents == null ? '' : (r.main_cents / 100).toFixed(2),
      (r.amount_cents / 100).toFixed(2), r.currency,
      r.category, kindCN[r.txn_kind] || r.txn_kind,
      srcCN[r.source] || r.source, r.pending ? '是' : '',
      r.note || '',
    ].map(esc).join(','));
  }
  // BOM，不然 Excel 打开中文是乱码
  send(res, 200, '﻿' + lines.join('\r\n'), {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="jizhang-${url.searchParams.get('period') || 'all'}.csv"`,
  });
}

/* --------------------------------------------------------- 服务入口 */

const PAGES = { '/': 'index.html', '/upload': 'upload.html', '/settings': 'settings.html' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/export.csv') return exportCSV(res, url);

    if (PAGES[url.pathname]) return serveStatic(res, path.join(PUBLIC, PAGES[url.pathname]));

    // 原图
    if (url.pathname.startsWith('/img/')) {
      const name = path.basename(decodeURIComponent(url.pathname.slice(5)));
      return serveStatic(res, path.join(UPLOADS, name));
    }

    // 静态资源（basename 防目录穿越）
    const asset = path.join(PUBLIC, path.basename(decodeURIComponent(url.pathname)));
    if (existsSync(asset) && statSync(asset).isFile()) return serveStatic(res, asset);

    send(res, 404, '404 Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
  } catch (e) {
    console.error(`[${req.method} ${url.pathname}]`, e);
    if (!res.headersSent) json(res, 500, { error: e.message || '服务器出错了' });
  }
});

const { port } = loadConfig();

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${port} 被占用了 —— 多半是已经开着一个了，先看看浏览器。`);
    console.error(`  要换端口就改 config.json 里的 "port"。\n`);
  } else {
    console.error('\n  启动失败：', e.message, '\n');
  }
  process.exit(1);
});

// Tailscale 给设备分的是 CGNAT 段 100.64.0.0/10，据此把它和普通局域网地址分开
const isTailscale = ip => {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
};

server.listen(port, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => i.address);
  const ts = ips.filter(isTailscale);
  const lan = ips.filter(ip => !isTailscale(ip));

  console.log('\n  记账已启动\n');
  console.log(`  本机            http://localhost:${port}`);
  for (const ip of lan) console.log(`  同一个 WiFi     http://${ip}:${port}`);
  for (const ip of ts) console.log(`  出门在外        http://${ip}:${port}   ← Tailscale，手机开着 VPN 就能连`);
  if (!ts.length) {
    console.log(`  出门在外        还没装 Tailscale。装完再启动一次，这里会多出一个地址。`);
  }
  console.log(`\n  数据库          ${path.join(ROOT, 'data', 'data.db')}`);
  if (!loadConfig().vision.api_key) {
    console.log('\n  ⚠ 还没填视觉模型的 API key，打开网页进「设置」填一下才能自动识别。');
  }
  console.log('\n  关掉这个窗口就停止服务。\n');
});
