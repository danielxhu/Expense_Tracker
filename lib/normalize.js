/** 把模型吐回来的松散字段，收紧成能进数据库的形状。 */
import { merchantKey } from './dedupe.js';
import { FALLBACK_CATEGORY } from './categories.js';

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const isRealDate = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/**
 * 只有 MM/DD 没有年份时（账单截图很常见）猜年份：
 * 取「不晚于今天+3天」里离今天最近的那个年份。
 * 九月看到 12/28，那是去年的，不是今年年底的。
 */
function inferYear(month, day, today) {
  const limit = Date.parse(today) + 3 * 86400000;
  const base = Number(today.slice(0, 4));
  let best = null;
  for (const y of [base, base - 1, base + 1]) {
    if (!isRealDate(y, month, day)) continue;
    const t = Date.parse(ymd(y, month, day));
    if (t <= limit && (best === null || t > best.t)) best = { y, t };
  }
  return best ? best.y : base;
}

export function normalizeDate(value, today) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;

  let m;
  // 2026-09-01 / 2026/9/1
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) {
    const [, y, mo, d] = m.map(Number);
    return isRealDate(y, mo, d) ? ymd(y, mo, d) : null;
  }
  // 09/01/2026 或 09/01/26（美式 MM/DD/YYYY）
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/))) {
    const mo = +m[1], d = +m[2];
    let y = +m[3];
    if (y < 100) y += y > 70 ? 1900 : 2000;
    return isRealDate(y, mo, d) ? ymd(y, mo, d) : null;
  }
  // 09/01 —— 没有年份，靠今天推
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})$/))) {
    const mo = +m[1], d = +m[2];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return ymd(inferYear(mo, d, today), mo, d);
  }
  // Sep 1, 2026 / 1 Sep 2026
  if ((m = s.match(/([a-z]{3,4})\w*\.?\s+(\d{1,2})(?:\s*,)?\s*(\d{4})?/i))) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo) {
      const d = +m[2];
      const y = m[3] ? +m[3] : inferYear(mo, d, today);
      return isRealDate(y, mo, d) ? ymd(y, mo, d) : null;
    }
  }
  if ((m = s.match(/(\d{1,2})\s+([a-z]{3,4})\w*\.?\s*(\d{4})?/i))) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo) {
      const d = +m[1];
      const y = m[3] ? +m[3] : inferYear(mo, d, today);
      return isRealDate(y, mo, d) ? ymd(y, mo, d) : null;
    }
  }
  // 2026年9月1日
  if ((m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/))) {
    const [, y, mo, d] = m.map(Number);
    return isRealDate(y, mo, d) ? ymd(y, mo, d) : null;
  }
  return null;
}

export function normalizeTime(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s || /^(null|none|n\/a|-)$/i.test(s)) return null;
  const m = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?/i);
  if (!m) return null;
  let h = +m[1];
  const min = +m[2];
  const ap = m[3]?.toLowerCase().replace(/\./g, '');
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

/** 金额转成「分」，避免浮点误差。返回 null 表示读不出来。 */
export function normalizeAmountCents(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(Math.abs(value) * 100);
  }
  const s = String(value).replace(/[$¥￥€£,\s]/g, '').replace(/[()]/g, '');
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.abs(n) * 100);
}

const KINDS = new Set(['expense', 'refund', 'payment']);

const SYMBOL_TO_CODE = [
  ['HK$', 'HKD'], ['NT$', 'TWD'], ['US$', 'USD'],
  ['$', 'USD'], ['￥', 'CNY'], ['¥', 'CNY'], ['€', 'EUR'], ['£', 'GBP'], ['₩', 'KRW'],
];

/**
 * 币种识别。¥ 归到 CNY —— 日元虽然也用这个符号，但国内银行 App 里它就是人民币，
 * 真是日元的话模型会直接给 JPY 这个代码。
 */
export function normalizeCurrency(value, fallback = 'USD') {
  const s = String(value ?? '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(s)) return s;
  if (/RMB|人民币|元/.test(s)) return 'CNY';
  for (const [sym, code] of SYMBOL_TO_CODE) if (s.includes(sym)) return code;
  return fallback;
}

/**
 * 外币折算成主币种。返回 null 表示没配这个币种的汇率 ——
 * 宁可标成「未折算」让你去补汇率，也不要拿个瞎猜的数字混进统计。
 */
export function convertToMain(cents, currency, mainCurrency, rates = {}) {
  if (!Number.isFinite(cents)) return null;
  if (currency === mainCurrency) return cents;
  const rate = Number(rates?.[currency]);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Math.round(cents * rate);
}

/**
 * 一行模型输出 → 一行数据库记录。读不出金额或日期就丢掉（返回 null），
 * 宁可漏一笔让你手动补，也不要存一笔错的。
 */
export function normalizeRow(raw, { categories, today, source, mainCurrency = 'USD', rates = {} }) {
  const amount_cents = normalizeAmountCents(raw?.amount);
  if (!amount_cents || amount_cents <= 0) return null;

  // Pending 行在手机银行里没有日期（显示的是「Pending」），先用今天顶上并打标记。
  // 等它正式入账时会带真实日期回来，那时把这条提升掉，不会记成两笔。
  const pending = raw?.pending === true || /^pending$/i.test(String(raw?.date || '').trim());
  const txn_date = normalizeDate(raw?.date, today) || (pending ? today : null);
  if (!txn_date) return null;

  // 币种：模型给的优先，其次从金额原文里的符号猜，最后落到主币种
  const currency = normalizeCurrency(
    raw?.currency || (typeof raw?.amount === 'string' ? raw.amount : ''),
    mainCurrency
  );
  const main_cents = convertToMain(amount_cents, currency, mainCurrency, rates);

  const merchant = String(raw?.merchant || '').trim().slice(0, 120) || '未知商户';
  const rawDesc = String(raw?.merchant_raw || '').trim().slice(0, 200);
  const category = categories.includes(raw?.category) ? raw.category : FALLBACK_CATEGORY;
  const txn_kind = KINDS.has(raw?.kind) ? raw.kind : 'expense';

  return {
    txn_date,
    txn_time: normalizeTime(raw?.time),
    merchant,
    merchant_key: merchantKey(merchant) || merchantKey(rawDesc) || 'UNKNOWN',
    amount_cents,      // 原币种金额，事实，不随汇率变
    currency,
    main_cents,        // 折算值，null = 没配这个币种的汇率
    category,
    txn_kind,
    // 原始描述行留在备注里，方便你事后核对模型有没有读错店名
    note: rawDesc && merchantKey(rawDesc) !== merchantKey(merchant) ? rawDesc : null,
    source,
    pending: pending ? 1 : 0,
    confidence: typeof raw?.confidence === 'number' ? raw.confidence : null,
    // 小票上的商品明细。不入库，只喂给第二段分类调用 ——
    // 「Target 买的全是牛奶鸡蛋」和「Target 买了盏台灯」就靠它区分。
    items: Array.isArray(raw?.items)
      ? raw.items.map(x => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 8)
      : [],
  };
}
