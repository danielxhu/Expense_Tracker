/**
 * 三层去重。
 *
 *  ①  图片指纹      原文件 SHA-256，在 uploads 表上是唯一索引 —— 见 server.js 的上传入口
 *  ②  交易指纹      (日期 | 店铺归一化 | 金额 | 当天第几笔 | 来源) 唯一索引 —— reconcile()
 *  ③  疑似配对      小票 ↔ 账单，只能算「像」，标出来让人点 —— findCandidates()
 */
import { countExisting, insertTransaction, addCandidate, db } from './db.js';

/* BofA 这类账单描述行里的固定噪音。模型一般会给干净店名，
   但万一它直接把整行原文丢回来，这里兜一道底。 */
const NOISE = [
  // BofA 写成 "CHECKCARD 0901 ..."，那 4 位是无斜杠的 MMDD，要连着关键词一起剥，
  // 单独剥 4 位数字不安全（"99 RANCH MARKET"、"7 ELEVEN" 里的数字是店名的一部分）
  /\b(CHECKCARD|CHECK\s*CARD|PURCHASE|POS\s*DEBIT|DEBIT\s*CARD)\s+\d{3,4}\b/g,
  /\bCHECKCARD\b/g, /\bCHECK\s*CARD\b/g, /\bPURCHASE\b/g, /\bPOS\s*DEBIT\b/g,
  /\bDEBIT\s*CARD\b/g, /\bRECURRING\b/g, /\bDES:\S*/g,
  /\bID:\S*/g, /\bINDN:\S*/g, /\bCO\s*ID:\S*/g,
  /^\s*(SQ|TST|SP|PY|PP|IC)\s*\*/i,      // Square / Toast / Shopify / PayPal 前缀
  /\b\d{2}\/\d{2}(\/\d{2,4})?\b/g,       // 描述里嵌的日期
  /\b\d{6,}\b/g,                          // 长参考号
  /#\s*\d+/g,                             // 门店号 #4472
  /\b(STORE|STR|LOC|TERM)\s*\d+\b/g,
  /\s+[A-Z]{2}\s*$/,                      // 结尾的州缩写 " CA"
];

/** 归一化店名。去重第②层和第③层都基于它。 */
export function merchantKey(name) {
  let s = String(name || '').normalize('NFKC').toUpperCase();
  for (const re of NOISE) s = s.replace(re, ' ');
  return s
    .replace(/[‘’'`´]/g, '')          // TRADER JOE'S -> TRADER JOES
    .replace(/[^A-Z0-9一-鿿]+/g, ' ')        // 保留中文
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

/** 两个店名有多像。1 = 完全一致，0 = 毫无关系。 */
export function similarity(a, b) {
  const ka = merchantKey(a), kb = merchantKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const A = new Set(ka.split(' ').filter(Boolean));
  const B = new Set(kb.split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  const inter = [...A].filter(t => B.has(t)).length;
  const jaccard = inter / new Set([...A, ...B]).size;
  // 一个是另一个的前缀（STARBUCKS vs STARBUCKS SEATTLE）算强相似
  if (ka.startsWith(kb) || kb.startsWith(ka)) return Math.max(jaccard, 0.85);
  // 首个词一致（品牌名对上了）也给个底分
  const firstA = ka.split(' ')[0], firstB = kb.split(' ')[0];
  if (firstA.length >= 4 && firstA === firstB) return Math.max(jaccard, 0.6);
  return jaccard;
}

const MATCH_THRESHOLD = 0.45;
const MATCH_DAYS = 4;              // 刷卡到入账通常 0~4 天

/**
 * 去重第②层：计数对账。
 *
 * 同一张图里 Starbucks $8.50 出现两次 = 两杯咖啡，存成 seq 1 和 2。
 * 下次重叠截图又读到这两笔，库里已有 2 笔 → 一笔都不插。
 * 真的喝了第三杯，新截图里出现 3 笔 → 只插第 3 笔（seq=3）。
 */
export function reconcile(rows, source) {
  const groups = new Map();
  for (const r of rows) {
    const gk = [r.txn_date, r.merchant_key, r.amount_cents, r.currency].join(' ');
    if (!groups.has(gk)) {
      groups.set(gk, { date: r.txn_date, key: r.merchant_key, cents: r.amount_cents,
                       currency: r.currency, items: [] });
    }
    groups.get(gk).items.push(r);
  }

  const toInsert = [], skipped = [];
  for (const g of groups.values()) {
    const already = countExisting(g.date, g.key, g.cents, source, g.currency);
    g.items.forEach((item, i) => {
      if (i < already) skipped.push({ ...item, reason: `库里已有 ${already} 笔完全相同的记录` });
      else toInsert.push({ ...item, seq: i + 1 });
    });
  }
  return { toInsert, skipped };
}

/** 插入时如果 seq 撞了（比如你手动删过中间某笔），往后顺延，不让整批失败。 */
export function insertWithSeq(txn) {
  for (let bump = 0; bump < 50; bump++) {
    try {
      return insertTransaction({ ...txn, seq: txn.seq + bump });
    } catch (e) {
      if (!String(e?.message || e).includes('UNIQUE')) throw e;
    }
  }
  throw new Error('seq 连续冲突 50 次，数据可能有问题');
}

/**
 * 去重第③层：找小票 ↔ 账单的疑似同一笔。
 * 金额必须分毫不差，日期差 ≤4 天，店名相似度 ≥0.45，两边来源不同。
 * 只写进 match_candidates 等你确认，绝不自动动数据。
 */
export function findCandidates(txnId) {
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId);
  if (!t || t.merged_into != null || t.txn_kind !== 'expense') return 0;

  const isStatement = t.source === 'statement';
  const otherSources = isStatement ? ['receipt', 'manual'] : ['statement'];
  const placeholders = otherSources.map(() => '?').join(',');

  const others = db.prepare(`
    SELECT * FROM transactions
     WHERE merged_into IS NULL
       AND id != ?
       AND amount_cents = ?
       AND txn_kind = 'expense'
       AND source IN (${placeholders})
       AND ABS(julianday(txn_date) - julianday(?)) <= ?
  `).all(t.id, t.amount_cents, ...otherSources, t.txn_date, MATCH_DAYS);

  let found = 0;
  for (const o of others) {
    const score = similarity(t.merchant, o.merchant);
    if (score < MATCH_THRESHOLD) continue;

    const receipt   = isStatement ? o : t;
    const statement = isStatement ? t : o;
    const days = Math.round(Math.abs(
      (Date.parse(statement.txn_date) - Date.parse(receipt.txn_date)) / 86400000
    ));
    const reason = `金额都是 $${(t.amount_cents / 100).toFixed(2)}，`
      + `店名相似度 ${(score * 100).toFixed(0)}%，`
      + (days === 0 ? '同一天' : `相差 ${days} 天`);

    if (addCandidate(receipt.id, statement.id, score, reason)) found++;
  }
  return found;
}

const PENDING_DAYS = 7;   // 授权到正式入账通常 1~5 天，留点余量

/**
 * Pending 提升。
 *
 * 手机银行里 "Pending ORANGE COFFEE $7.16" 没有日期，我们先按今天记下。
 * 过几天它正式入账变成 "Sep 5, 2026 ORANGE COFFEE $7.16" —— 日期变了，
 * 指纹也就变了，第②层拦不住，会记成两笔。
 *
 * 所以在计数对账之前先做一步：新来的已入账行，如果能对上一条还挂着的 pending
 * （同来源 + 同店 + 同金额 + 日期相差 ≤7 天），就把那条原地改成已入账，
 * 而不是新插一条。
 */
export function promotePending(rows, source) {
  const find = db.prepare(`
    SELECT id, txn_date FROM transactions
     WHERE pending = 1 AND merged_into IS NULL
       AND source = ? AND merchant_key = ? AND amount_cents = ? AND currency = ?
       AND ABS(julianday(txn_date) - julianday(?)) <= ?
     ORDER BY ABS(julianday(txn_date) - julianday(?))
     LIMIT 1
  `);
  const upd = db.prepare('UPDATE transactions SET txn_date = ?, pending = 0, seq = ? WHERE id = ?');

  const promoted = [], rest = [];
  for (const r of rows) {
    if (r.pending) { rest.push(r); continue; }        // 进来的本身还是 pending，不提升
    const hit = find.get(source, r.merchant_key, r.amount_cents, r.currency,
                         r.txn_date, PENDING_DAYS, r.txn_date);
    if (!hit) { rest.push(r); continue; }
    // 换了日期就得重排 seq，撞上唯一索引的话退回去走正常流程
    const seq = countExisting(r.txn_date, r.merchant_key, r.amount_cents, source, r.currency) + 1;
    try {
      upd.run(r.txn_date, seq, hit.id);
      promoted.push({ ...r, id: hit.id, was: hit.txn_date });
    } catch {
      rest.push(r);
    }
  }
  return { promoted, rest };
}
