import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CATEGORIES, FALLBACK_CATEGORY } from './categories.js';

const DATA_DIR = path.join(process.cwd(), 'data');
mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'data.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 上传的原图。sha256 唯一索引 = 去重第①层：同一张图再传直接撞上。
CREATE TABLE IF NOT EXISTS uploads (
  id          INTEGER PRIMARY KEY,
  sha256      TEXT    NOT NULL UNIQUE,
  filename    TEXT,
  stored_name TEXT    NOT NULL,
  mime        TEXT,
  bytes       INTEGER,
  kind        TEXT,              -- receipt | statement | unknown
  model       TEXT,
  raw_json    TEXT,              -- 模型原始返回，出问题时可回溯
  status      TEXT    NOT NULL DEFAULT 'ok',
  error       TEXT,
  created_at  TEXT    NOT NULL
);

-- 一笔消费。
CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY,
  txn_date     TEXT    NOT NULL,           -- YYYY-MM-DD
  txn_time     TEXT,                       -- HH:MM，账单截图通常没有
  merchant     TEXT    NOT NULL,           -- 原文，界面上显示这个
  merchant_key TEXT    NOT NULL,           -- 归一化后的，只用来去重
  amount_cents INTEGER NOT NULL,           -- 原币种金额，用分存。这是事实，永远不变
  currency     TEXT    NOT NULL DEFAULT 'USD',   -- 原币种
  main_cents   INTEGER,                    -- 折算成主币种后的金额。派生值，汇率变了可以重算
  category     TEXT    NOT NULL,
  txn_kind     TEXT    NOT NULL DEFAULT 'expense',  -- expense | refund | payment
  note         TEXT,
  source       TEXT    NOT NULL,           -- receipt | statement | manual
  upload_id    INTEGER REFERENCES uploads(id) ON DELETE SET NULL,
  seq          INTEGER NOT NULL DEFAULT 1, -- 「当天同店同金额的第几笔」，去重第②层的关键
  pending      INTEGER NOT NULL DEFAULT 0, -- 手机银行里还没正式入账的那些行
  merged_into  INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  created_at   TEXT    NOT NULL
);

-- 去重第②层：同一来源下，(日期,店铺,金额,第几笔) 唯一。
-- source 参与索引是故意的：小票和账单的同一笔不在这里撞，交给第③层人工确认。
CREATE UNIQUE INDEX IF NOT EXISTS ux_txn_fp
  ON transactions(txn_date, merchant_key, amount_cents, currency, seq, source);
CREATE INDEX IF NOT EXISTS ix_txn_date  ON transactions(txn_date);
CREATE INDEX IF NOT EXISTS ix_txn_merged ON transactions(merged_into);

-- 去重第③层：小票 ↔ 账单的疑似配对，等你点确认。
CREATE TABLE IF NOT EXISTS match_candidates (
  id           INTEGER PRIMARY KEY,
  receipt_id   INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  statement_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  score        REAL    NOT NULL,
  reason       TEXT,
  status       TEXT    NOT NULL DEFAULT 'pending',  -- pending | merged | ignored
  created_at   TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_match_pair
  ON match_candidates(receipt_id, statement_id);

CREATE TABLE IF NOT EXISTS categories (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT,
  hint  TEXT,                      -- 给模型看的语义提示，拼进识别提示词
  sort  INTEGER NOT NULL DEFAULT 0
);

-- 商户记忆：你手动改过一次某商户的分类，就记在这，以后识别到同一个
-- merchant_key 直接用这里的，不听模型的。分类准确度靠它稳住。
CREATE TABLE IF NOT EXISTS merchant_rules (
  merchant_key TEXT PRIMARY KEY,
  merchant     TEXT NOT NULL,      -- 展示用的原始店名
  category     TEXT NOT NULL,
  hits         INTEGER NOT NULL DEFAULT 0,   -- 命中过几次
  updated_at   TEXT NOT NULL
);
`);

// 老库升级：加 hint 列
const catCols = db.prepare('PRAGMA table_info(categories)').all().map(c => c.name);
if (!catCols.includes('hint')) db.exec('ALTER TABLE categories ADD COLUMN hint TEXT');
const txnCols = db.prepare('PRAGMA table_info(transactions)').all().map(c => c.name);
if (!txnCols.includes('pending')) {
  db.exec('ALTER TABLE transactions ADD COLUMN pending INTEGER NOT NULL DEFAULT 0');
}
// 老库的指纹索引没带币种，¥124.91 和 $124.91 会撞在一起，重建一次
const fpIdx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_txn_fp'").get();
if (fpIdx && !/currency/i.test(fpIdx.sql || '')) {
  db.exec(`DROP INDEX ux_txn_fp;
    CREATE UNIQUE INDEX ux_txn_fp
      ON transactions(txn_date, merchant_key, amount_cents, currency, seq, source);`);
}
if (!txnCols.includes('main_cents')) {
  db.exec('ALTER TABLE transactions ADD COLUMN main_cents INTEGER');
  // 老数据本来就是主币种记的，折算值等于原值
  db.exec('UPDATE transactions SET main_cents = amount_cents WHERE main_cents IS NULL');
}

// 首次启动灌入预设分类
const catCount = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
if (catCount === 0) {
  const ins = db.prepare('INSERT INTO categories (name, color, hint, sort) VALUES (?, ?, ?, ?)');
  DEFAULT_CATEGORIES.forEach((c, i) => ins.run(c.name, c.color, c.hint, i));
} else {
  // 老库：预设分类还没有 hint 的补上，用户自定义的分类不动
  const fill = db.prepare('UPDATE categories SET hint = ? WHERE name = ? AND (hint IS NULL OR hint = \'\')');
  for (const c of DEFAULT_CATEGORIES) fill.run(c.hint, c.name);
}

export const nowISO = () => new Date().toISOString();

/* ---------------------------------------------------------------- 分类 */

export const listCategories = () =>
  db.prepare('SELECT id, name, color, hint, sort FROM categories ORDER BY sort, id').all();

export const categoryNames = () => listCategories().map(c => c.name);

export function addCategory(name, color, hint) {
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), -1) AS s FROM categories').get().s;
  db.prepare('INSERT INTO categories (name, color, hint, sort) VALUES (?, ?, ?, ?)')
    .run(name, color || '#6b7280', hint || null, maxSort + 1);
}

export function updateCategory(id, name, color, hint) {
  const old = db.prepare('SELECT name FROM categories WHERE id = ?').get(id);
  if (!old) return;
  const clash = db.prepare('SELECT id FROM categories WHERE name = ? AND id != ?').get(name, id);
  if (clash) throw new Error(`已经有一个叫「${name}」的分类了`);
  db.prepare('UPDATE categories SET name = ?, color = ?, hint = ? WHERE id = ?')
    .run(name, color, hint ?? null, id);
  // 改名后把已有账目一起迁过去，不让历史数据掉队
  if (old.name !== name) {
    db.prepare('UPDATE transactions SET category = ? WHERE category = ?').run(name, old.name);
    db.prepare('UPDATE merchant_rules SET category = ? WHERE category = ?').run(name, old.name);
  }
}

export function deleteCategory(id) {
  const row = db.prepare('SELECT name FROM categories WHERE id = ?').get(id);
  if (!row) return null;
  // 迁移目标必须是删完之后还存在的分类，否则账目会指向一个不存在的分类
  const others = categoryNames().filter(n => n !== row.name);
  if (!others.length) return null;
  const fallback = others.includes(FALLBACK_CATEGORY) ? FALLBACK_CATEGORY : others[0];
  db.prepare('UPDATE transactions SET category = ? WHERE category = ?').run(fallback, row.name);
  db.prepare('UPDATE merchant_rules SET category = ? WHERE category = ?').run(fallback, row.name);
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  return fallback;
}

/* ---------------------------------------------------------------- 上传 */

export const findUploadBySha = sha =>
  db.prepare('SELECT * FROM uploads WHERE sha256 = ?').get(sha);

export function insertUpload(u) {
  const r = db.prepare(`
    INSERT INTO uploads (sha256, filename, stored_name, mime, bytes, kind, model, raw_json, status, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(u.sha256, u.filename, u.stored_name, u.mime, u.bytes, u.kind, u.model,
         u.raw_json, u.status, u.error, nowISO());
  return Number(r.lastInsertRowid);
}

export const getUpload = id => db.prepare('SELECT * FROM uploads WHERE id = ?').get(id);

/** 上次读截断了，这次重传同一张图 —— 复用那条记录而不是新插一条（sha256 是唯一索引） */
export function updateUpload(id, u) {
  db.prepare(`
    UPDATE uploads SET kind = ?, model = ?, raw_json = ?, status = ?, error = ?
     WHERE id = ?
  `).run(u.kind, u.model, u.raw_json, u.status, u.error ?? null, id);
  return id;
}

/* ---------------------------------------------------------------- 账目 */

export function insertTransaction(t) {
  const r = db.prepare(`
    INSERT INTO transactions
      (txn_date, txn_time, merchant, merchant_key, amount_cents, currency, main_cents,
       category, txn_kind, note, source, upload_id, seq, pending, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(t.txn_date, t.txn_time, t.merchant, t.merchant_key, t.amount_cents,
         t.currency || 'USD', t.main_cents ?? null,
         t.category, t.txn_kind || 'expense', t.note || null,
         t.source, t.upload_id ?? null, t.seq, t.pending ? 1 : 0, nowISO());
  return Number(r.lastInsertRowid);
}

export const getTransaction = id =>
  db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);

/** 库里已有几笔完全一样的（同来源）—— 去重第②层的「计数对账」 */
export const countExisting = (date, key, cents, source, currency = 'USD') =>
  db.prepare(`
    SELECT COUNT(*) AS n FROM transactions
    WHERE txn_date = ? AND merchant_key = ? AND amount_cents = ?
      AND currency = ? AND source = ?
  `).get(date, key, cents, currency, source).n;

export function updateTransaction(id, f) {
  const cur = getTransaction(id);
  if (!cur) return null;
  db.prepare(`
    UPDATE transactions
       SET txn_date = ?, txn_time = ?, merchant = ?, merchant_key = ?,
           amount_cents = ?, currency = ?, main_cents = ?,
           category = ?, txn_kind = ?, note = ?
     WHERE id = ?
  `).run(f.txn_date, f.txn_time, f.merchant, f.merchant_key,
         f.amount_cents, f.currency, f.main_cents ?? null,
         f.category, f.txn_kind, f.note, id);
  return getTransaction(id);
}

export function deleteTransaction(id) {
  // 被它吞掉的那条要放出来，否则合并错了就找不回来了
  db.prepare('UPDATE transactions SET merged_into = NULL WHERE merged_into = ?').run(id);
  db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
}

/* ------------------------------------------------------- 列表 / 筛选 */

/**
 * 流水查询。merged_into 非空的行是被合并掉的，默认不出现，也不进统计。
 * filters: { month, from, to, q, category, min, max, kind, limit, offset }
 */
export function queryTransactions(f = {}) {
  const where = ['t.merged_into IS NULL'];
  const args = [];

  if (f.from)     { where.push('t.txn_date >= ?'); args.push(f.from); }
  if (f.to)       { where.push('t.txn_date <= ?'); args.push(f.to); }
  if (f.category) { where.push('t.category = ?');  args.push(f.category); }
  if (f.kind)     { where.push('t.txn_kind = ?');  args.push(f.kind); }
  if (f.min != null) { where.push('t.amount_cents >= ?'); args.push(Math.round(f.min * 100)); }
  if (f.max != null) { where.push('t.amount_cents <= ?'); args.push(Math.round(f.max * 100)); }
  if (f.q) {
    where.push('(t.merchant LIKE ? OR t.note LIKE ? OR t.category LIKE ?)');
    const like = `%${f.q}%`;
    args.push(like, like, like);
  }

  const sql = `
    SELECT t.*,
           u.stored_name AS image,
           (SELECT COUNT(*) FROM transactions m WHERE m.merged_into = t.id) AS merged_count
      FROM transactions t
      LEFT JOIN uploads u ON u.id = t.upload_id
     WHERE ${where.join(' AND ')}
     ORDER BY t.txn_date DESC, COALESCE(t.txn_time,'23:59') DESC, t.id DESC
     LIMIT ? OFFSET ?`;

  const rows = db.prepare(sql).all(...args, f.limit ?? 200, f.offset ?? 0);
  const total = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN t.txn_kind='expense' THEN COALESCE(t.main_cents,0)
                                             WHEN t.txn_kind='refund'  THEN -COALESCE(t.main_cents,0)
                                             ELSE 0 END), 0) AS cents
       FROM transactions t WHERE ${where.join(' AND ')}`
  ).get(...args);

  return { rows, total: total.n, sum_cents: total.cents };
}

/** 支出净额：支出 - 退款，还款/转账不算 */
// 统计一律用折算后的主币种金额，这样人民币和美元的账能加在一起
const NET = `SUM(CASE WHEN txn_kind='expense' THEN COALESCE(main_cents, 0)
                      WHEN txn_kind='refund'  THEN -COALESCE(main_cents, 0)
                      ELSE 0 END)`;

/**
 * 按账期区间统计。from/to 都是闭区间，由 server 用 lib/period.js 算好传进来。
 * 用 txn_date BETWEEN 而不是 strftime，既支持任意起止日，也能吃到 ix_txn_date 索引。
 */
export function rangeSummary({ from, to, prevFrom, prevTo }) {
  const totalOf = (a, b) => db.prepare(`
    SELECT COALESCE(${NET}, 0) AS cents, COUNT(*) AS n
      FROM transactions
     WHERE merged_into IS NULL AND txn_date >= ? AND txn_date <= ?
  `).get(a, b);

  const byCategory = db.prepare(`
    SELECT t.category AS name,
           COALESCE(${NET}, 0) AS cents,
           COUNT(*) AS n,
           (SELECT color FROM categories c WHERE c.name = t.category) AS color
      FROM transactions t
     WHERE t.merged_into IS NULL
       AND t.txn_date >= ? AND t.txn_date <= ?
       AND t.txn_kind != 'payment'
     GROUP BY t.category
     HAVING cents != 0
     ORDER BY cents DESC
  `).all(from, to);

  const daily = db.prepare(`
    SELECT txn_date AS date, COALESCE(${NET}, 0) AS cents
      FROM transactions
     WHERE merged_into IS NULL AND txn_date >= ? AND txn_date <= ?
     GROUP BY txn_date ORDER BY txn_date
  `).all(from, to);

  const topMerchants = db.prepare(`
    SELECT merchant AS name, COALESCE(${NET}, 0) AS cents, COUNT(*) AS n
      FROM transactions
     WHERE merged_into IS NULL AND txn_date >= ? AND txn_date <= ?
       AND txn_kind != 'payment'
     GROUP BY merchant_key
     HAVING cents > 0
     ORDER BY cents DESC LIMIT 5
  `).all(from, to);

  const cur = totalOf(from, to);
  return {
    from, to,
    total_cents: cur.cents,
    count: cur.n,
    prev_total_cents: prevFrom ? totalOf(prevFrom, prevTo).cents : 0,
    by_category: byCategory,
    daily,
    top_merchants: topMerchants,
  };
}

/** 有账目的日期范围，给账期下拉列表用 */
export const dateBounds = () =>
  db.prepare(`
    SELECT MIN(txn_date) AS min, MAX(txn_date) AS max
      FROM transactions WHERE merged_into IS NULL
  `).get();

/* ------------------------------------------------- 疑似配对（第③层） */

export function addCandidate(receiptId, statementId, score, reason) {
  try {
    db.prepare(`
      INSERT INTO match_candidates (receipt_id, statement_id, score, reason, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(receiptId, statementId, score, reason, nowISO());
    return true;
  } catch {
    return false; // 已经提过这一对了（可能是之前被忽略的），不重复打扰
  }
}

export const pendingCandidates = () =>
  db.prepare(`
    SELECT mc.id, mc.score, mc.reason,
           r.id AS r_id, r.txn_date AS r_date, r.txn_time AS r_time,
           r.merchant AS r_merchant, r.amount_cents AS r_cents, r.category AS r_category,
           s.id AS s_id, s.txn_date AS s_date,
           s.merchant AS s_merchant, s.amount_cents AS s_cents, s.category AS s_category
      FROM match_candidates mc
      JOIN transactions r ON r.id = mc.receipt_id
      JOIN transactions s ON s.id = mc.statement_id
     WHERE mc.status = 'pending'
       AND r.merged_into IS NULL AND s.merged_into IS NULL
     ORDER BY mc.score DESC, mc.id DESC
  `).all();

export const pendingCandidateCount = () =>
  db.prepare(`
    SELECT COUNT(*) AS n FROM match_candidates mc
      JOIN transactions r ON r.id = mc.receipt_id
      JOIN transactions s ON s.id = mc.statement_id
     WHERE mc.status='pending' AND r.merged_into IS NULL AND s.merged_into IS NULL
  `).get().n;

/**
 * 合并：保留账单那条（金额是银行实扣的，最准），
 * 把小票那条标记成 merged_into，它的分类和小票时间补给账单条，原图链接也跟过去。
 */
export function mergeCandidate(id) {
  const mc = db.prepare('SELECT * FROM match_candidates WHERE id = ?').get(id);
  if (!mc) return null;
  const receipt = getTransaction(mc.receipt_id);
  const stmt = getTransaction(mc.statement_id);
  if (!receipt || !stmt) return null;

  db.prepare(`
    UPDATE transactions
       SET txn_time  = COALESCE(txn_time, ?),
           category  = ?,
           upload_id = COALESCE(upload_id, ?)
     WHERE id = ?
  `).run(receipt.txn_time, receipt.category, receipt.upload_id, stmt.id);

  db.prepare('UPDATE transactions SET merged_into = ? WHERE id = ?').run(stmt.id, receipt.id);
  db.prepare("UPDATE match_candidates SET status = 'merged' WHERE id = ?").run(id);
  return getTransaction(stmt.id);
}

export function ignoreCandidate(id) {
  db.prepare("UPDATE match_candidates SET status = 'ignored' WHERE id = ?").run(id);
}

/** 撤销合并 */
export function unmergeTransaction(childId) {
  db.prepare('UPDATE transactions SET merged_into = NULL WHERE id = ?').run(childId);
  db.prepare("UPDATE match_candidates SET status='ignored' WHERE receipt_id = ?").run(childId);
}

/* --------------------------------------------------- 商户记忆（分类） */

/**
 * 你手动改过一次某商户的分类 → 记下来 → 以后识别到同一个 merchant_key
 * 直接用这条规则，不听模型的。模型只负责第一次见到的新店。
 * merchant_key 是去重用的那个归一化店名，所以 "STARBUCKS #4472 SEATTLE WA"
 * 和 "Starbucks" 会命中同一条规则。
 */
export function getMerchantRule(key) {
  if (!key) return null;
  const exact = db.prepare('SELECT * FROM merchant_rules WHERE merchant_key = ?').get(key);
  if (exact) return exact;
  // 规则要按品牌生效，不是按门店：STARBUCKS 这条得管得住 STARBUCKS PORTLAND。
  // 带上 ' %' 是为了卡在词边界（不能让 STAR 匹配 STARBUCKS PORTLAND）。
  // 取最长的那条，这样更具体的规则（AMAZON FRESH）能盖过更宽的（AMAZON）。
  return db.prepare(`
    SELECT * FROM merchant_rules
     WHERE ? LIKE merchant_key || ' %' OR merchant_key LIKE ? || ' %'
     ORDER BY LENGTH(merchant_key) DESC
     LIMIT 1
  `).get(key, key) || null;
}

export function saveMerchantRule(key, merchant, category) {
  if (!key || !category) return;
  db.prepare(`
    INSERT INTO merchant_rules (merchant_key, merchant, category, hits, updated_at)
    VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(merchant_key) DO UPDATE
      SET merchant = excluded.merchant,
          category = excluded.category,
          updated_at = excluded.updated_at
  `).run(key, merchant || key, category, nowISO());
}

export const deleteMerchantRule = key =>
  Number(db.prepare('DELETE FROM merchant_rules WHERE merchant_key = ?').run(key).changes);

export const listMerchantRules = () =>
  db.prepare(`
    SELECT r.merchant_key, r.merchant, r.category, r.hits, r.updated_at,
           (SELECT COUNT(*) FROM transactions t
             WHERE (t.merchant_key = r.merchant_key
                    OR t.merchant_key LIKE r.merchant_key || ' %')
               AND t.merged_into IS NULL) AS txn_count
      FROM merchant_rules r
     ORDER BY txn_count DESC, r.updated_at DESC
  `).all();

export const bumpRuleHit = key =>
  db.prepare('UPDATE merchant_rules SET hits = hits + 1 WHERE merchant_key = ?').run(key);

/** 把这个商户的历史账目一起改成新分类，返回改了几笔（不含你正在编辑的那笔） */
export function recategorizeMerchant(key, category, exceptId) {
  const r = db.prepare(`
    UPDATE transactions SET category = ?
     WHERE (merchant_key = ? OR merchant_key LIKE ? || ' %')
       AND category != ? AND id != ?
  `).run(category, key, key, category, exceptId ?? -1);
  return Number(r.changes);
}

/**
 * 你过去的分类习惯，喂给第二段分类调用当例子。
 * 先取这批商户自己的历史（最相关），再用全局最常见的补齐。
 */
export function categoryHistoryExamples(merchantKeys = [], limit = 40) {
  const out = new Map();

  const perKey = db.prepare(`
    SELECT merchant, category, COUNT(*) AS n
      FROM transactions
     WHERE merged_into IS NULL
       AND (merchant_key = ? OR merchant_key LIKE ? || ' %' OR ? LIKE merchant_key || ' %')
     GROUP BY category
     ORDER BY n DESC, MAX(created_at) DESC
     LIMIT 1
  `);
  for (const k of merchantKeys) {
    if (!k || out.has(k)) continue;
    const row = perKey.get(k, k, k);
    if (row) out.set(k, { merchant: row.merchant, category: row.category });
  }

  const common = db.prepare(`
    SELECT merchant_key, merchant, category, COUNT(*) AS n
      FROM transactions
     WHERE merged_into IS NULL
     GROUP BY merchant_key
     ORDER BY n DESC, MAX(created_at) DESC
     LIMIT ?
  `).all(limit);
  for (const c of common) {
    if (out.size >= limit) break;
    if (!out.has(c.merchant_key)) out.set(c.merchant_key, { merchant: c.merchant, category: c.category });
  }
  return [...out.values()];
}

/* --------------------------------------------------------- 多币种 */

/** 有多少笔外币还没折算（汇率没配） */
export const unconvertedCount = () =>
  db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE main_cents IS NULL').get().n;

/** 账目里出现过哪些币种 */
export const usedCurrencies = () =>
  db.prepare(`
    SELECT currency, COUNT(*) AS n FROM transactions
     WHERE merged_into IS NULL GROUP BY currency ORDER BY n DESC
  `).all();

/**
 * 改了汇率之后重算所有折算值。
 * 原币金额（amount_cents）不动 —— 那是事实；只有派生的 main_cents 会变。
 */
export function recomputeMain(mainCurrency, rates = {}) {
  const rows = db.prepare('SELECT id, amount_cents, currency FROM transactions').all();
  const upd = db.prepare('UPDATE transactions SET main_cents = ? WHERE id = ?');
  let changed = 0, unconverted = 0;
  for (const r of rows) {
    let v;
    if (r.currency === mainCurrency) v = r.amount_cents;
    else {
      const rate = Number(rates?.[r.currency]);
      v = (Number.isFinite(rate) && rate > 0) ? Math.round(r.amount_cents * rate) : null;
    }
    if (v == null) unconverted++;
    upd.run(v, r.id);
    changed++;
  }
  return { changed, unconverted };
}

/**
 * 把某张图读出来的所有账目改成指定币种，并重算折算值。
 * 用在两种时候：模型把 ¥ 看成了 $，或者你上传时忘了指定。
 * 原币金额不动 —— 变的只是「这个数字是什么币种」这个判断。
 */
export function setUploadCurrency(uploadId, currency, mainCurrency, rates = {}) {
  const rows = db.prepare(
    'SELECT id, amount_cents FROM transactions WHERE upload_id = ?'
  ).all(uploadId);
  if (!rows.length) return { total: 0, changed: 0, conflicts: 0 };

  const upd = db.prepare('UPDATE transactions SET currency = ?, main_cents = ? WHERE id = ?');
  const rate = Number(rates?.[currency]);

  // 全改或全不改。改一半留一半的话，同一张图里会出现两种币种，比不改还糟
  let conflicts = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const main = currency === mainCurrency
        ? r.amount_cents
        : (Number.isFinite(rate) && rate > 0 ? Math.round(r.amount_cents * rate) : null);
      try { upd.run(currency, main, r.id); }
      catch { conflicts++; }      // 换币种后撞上了已有的同指纹记录
    }
    if (conflicts) { db.exec('ROLLBACK'); return { total: rows.length, changed: 0, conflicts }; }
    db.exec('COMMIT');
    return { total: rows.length, changed: rows.length, conflicts: 0 };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
