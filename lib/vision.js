/**
 * 模型调用。两段式：
 *
 *   第一段 analyzeImage —— 视觉模型，只管把字读准：店名、金额、日期、时间、
 *                          收支类型，小票的话再读几条商品明细。
 *   第二段 classifyRows —— 纯文本调用，专门做分类。它能拿到分类提示、商品明细，
 *                          还有你过去的分类习惯当例子 —— 这些塞进 OCR 那次调用里
 *                          只会跟识别任务抢注意力。
 *
 * 两段都走 OpenAI 兼容的 /chat/completions，所以 Gemini / 智谱 / 阿里百炼 /
 * OpenRouter / 任何中转都是同一套代码。分类那段可以单独配一个更强的文本模型。
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { FALLBACK_CATEGORY } from './categories.js';

/* ------------------------------------------------------------ 共用调用 */

/**
 * 输出被截断时，把 transactions 数组里已经写完整的那些对象捞出来。
 * 30 行的账单读到第 22 行断了，那 22 行是好的 —— 不该整张作废。
 * 手写括号匹配（不是正则）：要正确跳过字符串里的花括号和转义。
 */
function salvageTruncated(text) {
  const kind = (text.match(/"kind"\s*:\s*"(receipt|statement|unknown)"/) || [])[1] || 'statement';
  const at = text.indexOf('"transactions"');
  if (at < 0) return null;
  const start = text.indexOf('[', at);
  if (start < 0) return null;

  const out = [];
  let depth = 0, objStart = -1, inStr = false, esc = false;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) objStart = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try { out.push(JSON.parse(text.slice(objStart, i + 1))); } catch { /* 半截的丢掉 */ }
        objStart = -1;
      }
    } else if (ch === ']' && depth === 0) break;
  }
  return out.length ? { kind, transactions: out, truncated: true } : null;
}

/** 模型有时会裹 markdown 或加一句废话，这里硬提取 JSON。 */
function extractJSON(text) {
  if (!text || !text.trim()) throw new Error('模型返回了空内容');
  const s = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try { return JSON.parse(s); } catch { /* 继续兜底 */ }
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* 继续兜底 */ }
  }
  // 整体解析不了，多半是写到一半被 max_tokens 掐了 —— 能捞多少捞多少
  const partial = salvageTruncated(s);
  if (partial) return partial;
  throw new Error('模型没有返回合法 JSON。原文开头：' + text.slice(0, 200));
}

/** 从各家五花八门的响应形状里把正文抠出来 */
function pickContent(msg = {}) {
  let c = msg.content;
  if (Array.isArray(c)) {                    // 有的把正文拆成 parts 数组
    c = c.map(x => (typeof x === 'string' ? x : (x?.text ?? ''))).join('');
  }
  if (typeof c === 'string' && c.trim()) return c;
  // 推理模型偶尔只填了思考字段、正文留空
  for (const k of ['reasoning_content', 'reasoning']) {
    if (typeof msg[k] === 'string' && msg[k].trim()) return msg[k];
  }
  return '';
}

/**
 * 正文为空时给一条能定位问题的报错。
 * 「模型返回了空内容」本身没有任何信息量 —— 真正有用的是 finish_reason：
 * length = 预算被思考吃光了，content_filter = 被安全过滤拦了，两者处理方式完全不同。
 */
function emptyContentError(choice, payload, what) {
  const fr = String(choice?.finish_reason || choice?.native_finish_reason || '未提供');
  const u = payload?.usage || {};
  const detail = [`finish_reason=${fr}`];
  const used = u.completion_tokens ?? u.output_tokens;
  if (used != null) detail.push(`已生成 ${used} token`);
  const think = u.completion_tokens_details?.reasoning_tokens;
  if (think) detail.push(`其中思考占了 ${think}`);

  let hint;
  if (fr === 'length') {
    hint = '输出被 max_tokens 截断了。带思考的模型（Gemini 2.5、DeepSeek 推理系）会先花预算思考，'
         + '正文还没开始写就到顶了。去「设置」把 max_tokens 调大，或把 reasoning_effort 设成 none 关掉思考。';
  } else if (/filter|safety|block|prohibit|censor/i.test(fr)) {
    hint = '这家的安全过滤把图拦了 —— 银行账单截图容易被当成敏感内容。'
         + '换一家供应商试试，或者把截图里账号那一块裁掉再传。';
  } else {
    hint = '模型正常结束却什么都没输出。先确认你选的是能读图的视觉模型'
         + '（Cerebras、Groq 这类只能做第二段分类，不会读图）；也可能是图片格式它不认，试试存成 JPG 再传。';
  }
  return new Error(`${what}时模型返回了空内容（${detail.join('，')}）。${hint}`
    + ' 详细情况已存到 data\\last-error.json，看不明白就把这个文件发出来。');
}

/**
 * 把这次失败的完整上下文写到 data/last-error.json。
 * 光看报错文字猜不出来的时候，这个文件里有模型原样返回的 message 对象。
 * 注意：只写请求参数和响应，绝不写 api_key，也不写图片本身。
 */
function dumpFailure({ what, url, body, payload, choice }) {
  try {
    const out = {
      when: new Date().toISOString(),
      stage: what,
      endpoint: url,
      request: {
        model: body?.model ?? null,
        max_tokens: body?.max_tokens ?? null,
        reasoning_effort: body?.reasoning_effort ?? null,
        response_format: body?.response_format ?? null,
        has_image: JSON.stringify(body?.messages ?? '').includes('image_url'),
      },
      response: {
        model: payload?.model ?? null,
        finish_reason: choice?.finish_reason ?? choice?.native_finish_reason ?? null,
        usage: payload?.usage ?? null,
        message_fields: Object.keys(choice?.message ?? {}),
        message_raw: JSON.stringify(choice?.message ?? null)?.slice(0, 4000) ?? null,
        other_keys: Object.keys(payload ?? {}),
      },
    };
    writeFileSync(path.join(process.cwd(), 'data', 'last-error.json'),
                  JSON.stringify(out, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

async function postJSON(url, api_key, body, vision, what) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), vision.timeout_ms || 90000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api_key}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`${what}超时了，图片可能太大或网络慢，再试一次`);
    throw new Error(`连不上模型接口（${url}）：${e.message}`);
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) throw new Error(`${what}时模型返回 ${res.status}：${text.slice(0, 400)}`);
  try { return JSON.parse(text); }
  catch { throw new Error('接口返回的不是 JSON：' + text.slice(0, 300)); }
}

/**
 * endpoint 留空就整个跟视觉共用。第二段只需要文本模型，所以可以单独指到
 * 另一家额度更大的（比如视觉走 Gemini、分类走 Cerebras）。
 */
async function callModel({ messages, model, what, endpoint }) {
  const { vision } = loadConfig();
  const base_url = endpoint?.base_url || vision.base_url;
  const api_key = endpoint?.base_url ? (endpoint.api_key || vision.api_key) : vision.api_key;
  if (!api_key) {
    const err = new Error('还没配置模型的 API key，去「设置」页填一下');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const url = base_url.replace(/\/+$/, '') + '/chat/completions';
  const budget = Number(vision.max_tokens) || 8000;
  const baseBody = { model: model || vision.model, temperature: 0, max_tokens: budget, messages };
  if (vision.json_mode) baseBody.response_format = { type: 'json_object' };
  // 只在明确配置了才发 —— 有的供应商见到不认识的字段会直接 400
  if (vision.reasoning_effort) baseBody.reasoning_effort = vision.reasoning_effort;

  // 正文为空时的重试阶梯：
  //   ① 原始预算
  //   ② 预算翻三倍 + 关掉思考（带思考的模型写不出正文，基本都是预算被思考吃光了）
  //   ③ 只加预算 —— 有的供应商不认 reasoning_effort，会直接 400，得退一步
  const retryBudget = Math.min(budget * 3, 32000);
  const canDisableThinking = !vision.reasoning_effort;
  const ladder = [
    {},
    { max_tokens: retryBudget, ...(canDisableThinking ? { reasoning_effort: 'none' } : {}) },
    ...(canDisableThinking ? [{ max_tokens: retryBudget }] : []),
  ];

  for (let i = 0; i < ladder.length; i++) {
    const body = { ...baseBody, ...ladder[i] };
    let payload;
    try {
      payload = await postJSON(url, api_key, body, vision, what);
    } catch (e) {
      const msg = String(e?.message || '');
      // 这家不认 reasoning_effort（会 400）
      const badParam = /reasoning_effort|unrecognized|unsupported|unknown\s+(argument|parameter|field)/i
        .test(msg);
      // 这家的 max_tokens 上限比我加到的低（不少供应商卡在 8192）
      const tokenCap = /max_tokens|max_completion_tokens|token[^.]*\b(limit|exceed|too\s*large)/i
        .test(msg);
      if (i < ladder.length - 1 && (badParam || tokenCap)) {
        if (tokenCap) {
          // 后面几轮别再往上加了，压回原始预算
          for (let j = i + 1; j < ladder.length; j++) ladder[j].max_tokens = budget;
          // 撞上限跟 reasoning_effort 无关，别把「关掉思考」一起丢了 ——
          // 下一轮本来是给「不认这个参数」的供应商准备的
          if (ladder[i].reasoning_effort && ladder[i + 1] && !ladder[i + 1].reasoning_effort) {
            ladder[i + 1].reasoning_effort = ladder[i].reasoning_effort;
          }
          console.warn(`  [${what}] 这家的 max_tokens 上限低于 ${retryBudget}，压回 ${budget} 重试…`);
        } else {
          console.warn(`  [${what}] 这家不认 reasoning_effort，去掉它重试…`);
        }
        continue;
      }
      throw e;
    }

    const choice = payload?.choices?.[0];
    const content = pickContent(choice?.message);
    if (content.trim()) {
      return { parsed: extractJSON(content), model: payload.model || body.model, raw: content };
    }

    const fr = String(choice?.finish_reason || choice?.native_finish_reason || '');
    const retryable = fr === 'length' || fr === '';   // 空的 finish_reason 也值得再试一次
    if (!retryable || i === ladder.length - 1) {
      dumpFailure({ what, url, body, payload, choice });
      throw emptyContentError(choice, payload, what);
    }
    console.warn(`  [${what}] 正文为空（finish_reason=${fr || '未提供'}），`
      + `把 max_tokens 提到 ${retryBudget}${ladder[i + 1].reasoning_effort ? ' 并关掉思考' : ''} 重试…`);
  }
}

/* -------------------------------------------------- 第一段：读图取数 */

const EXTRACT_SYSTEM = `You extract spending transactions from images of receipts and bank statement screenshots.
You always reply with a single raw JSON object and nothing else — no prose, no markdown fences.`;

function extractPrompt(categoryNames, today) {
  return `Read the attached image and extract every spending transaction. Your job here is ACCURACY OF THE NUMBERS AND NAMES — a separate step handles categorisation, so do not spend effort on it.

First decide what the image is:
- "receipt"   — a single store receipt / order confirmation. Output exactly ONE transaction using the FINAL TOTAL actually paid (after tax and tip). Do NOT output one transaction per line item.
- "statement" — a bank/card statement or transaction-list screenshot (e.g. Bank of America). Output ONE transaction per visible row.
- "unknown"   — you cannot tell. Output an empty transactions list.

CRITICAL RULES FOR STATEMENTS:
1. Output EVERY visible transaction row, top to bottom, in the order shown.
2. If two rows have the same merchant, same date and same amount, they are TWO separate real purchases. Output BOTH. Never collapse, merge or de-duplicate rows — de-duplication is handled downstream and it needs the true count.
3. Include rows marked "Pending" as well (see below for how).
4. Ignore anything that is not a transaction row: "Current Balance", available credit, rewards points, search bars, tab headers, "Now viewing", card nicknames and card numbers, date separators.

MOBILE BANKING APP SCREENSHOTS (Bank of America and similar) — read this carefully, these
layouts have two traps:

TRAP 1 — TWO DOLLAR AMOUNTS PER ROW. Each row shows the transaction amount in large/bold/coloured
type, and directly BELOW it, in smaller grey type, the RUNNING BALANCE after that transaction.
Example row:

    Pending                        $7.16      <- transaction amount, USE THIS
    ORANGE COFFEE                $640.64      <- running balance, IGNORE IT

    Sep 1, 2026                   $37.42      <- transaction amount, USE THIS
    PUBLIX #1811 COVINGTON       $626.51      <- running balance, IGNORE IT
    GA

The running balance is always the second, smaller, greyer number and it drifts smoothly from row
to row (603.39, 600.29, 626.51 …). The transaction amount is the one that matches what was spent.
NEVER put a running balance in "amount". If you are unsure which is which, the transaction amount
is the visually prominent one on the first line of the row.

TRAP 2 — PENDING ROWS HAVE NO DATE. Where a posted row shows "Sep 3, 2026", a pending row shows
the word "Pending" instead. For those rows set "date": null and "pending": true. Do NOT invent a
date and do NOT skip the row. Posted rows get "pending": false.

Also in these layouts:
- A merchant name often WRAPS over two or three lines. Join the wrapped lines into ONE merchant
  string; they are a single transaction, not several. e.g. "COCA COLA" / "LAWRENCEVILLE" /
  "GLAWRENCEVILLEGA" is one row whose merchant is "Coca Cola".
- A LEADING MINUS SIGN (-$26.22) means money came INTO the account — a card payment, a transfer
  from another account, or a credit. Those are "kind":"payment" (or "refund" for a merchant
  refund), never a normal expense. Report "amount" as a positive number regardless.

TRAP 3 — DATES MAY BE GROUP HEADERS, NOT PART OF THE ROW. Many apps (especially Chinese bank
apps) print the date ONCE as a separator, then list several transactions under it, and those
rows carry no date of their own:

    08-29                                     <- date header
      MOLLY TEA DULUTH        ¥109.89         <- this row is 08-29
      YES FORMOSA             ¥124.91         <- this row is ALSO 08-29
      YES FORMOSA             ¥124.91         <- ALSO 08-29, and a SECOND real purchase
      WM SUPERCENTER #459     ¥433.95         <- ALSO 08-29
    08-27                                     <- next date header
      MCGRAW-HILL HIGHER ED   ¥922.92         <- this row is 08-27

Carry the most recent date header down to every row beneath it until the next header. Never
output a row with a missing date just because the row itself had no date printed on it.

CURRENCY. Report the currency of the amount as printed, in "currency", as a 3-letter ISO code:
"$" -> USD, "¥" or "￥" in a Chinese bank app -> CNY, "€" -> EUR, "£" -> GBP, "HK$" -> HKD.
Report "amount" as the number exactly as printed in that currency — do NOT convert it yourself,
conversion happens downstream with a configured rate. A Chinese card statement often shows
US merchants (WALMART, UBER EATS) billed in CNY; that is normal — the merchant is the US one and
the currency is CNY.

Also ignore, in these apps: the summary total at the top ("最新消费 ¥4,113.29", "Current Balance"),
the bank's own category tag on each row ("其他", "餐饮" printed by the bank — you assign the
category separately), card nicknames, and card last-4 labels ("尾号1077").

PRIVACY: never output account numbers, card numbers, or balances.

Return JSON in exactly this shape:
{
  "kind": "receipt" | "statement" | "unknown",
  "transactions": [
    {
      "merchant": "Starbucks",
      "merchant_raw": "CHECKCARD 0901 STARBUCKS STORE 04472 SEATTLE WA",
      "date": "2026-09-01",
      "time": "14:32",
      "amount": 8.50,
      "currency": "USD",
      "kind": "expense",
      "pending": false,
      "items": ["Caffe Latte Grande", "Butter Croissant"],
      "category": "餐饮",
      "confidence": 0.95
    }
  ]
}

Field rules:
- "merchant": the clean, canonical brand name a human would say — "Starbucks", "Trader Joe's", "Amazon", "Uber". Strip store numbers, city, state, processor prefixes (SQ*, TST*), and reference codes.
- "merchant_raw": the descriptor text exactly as printed. Use "" if there is nothing extra.
- "date": always YYYY-MM-DD. Statements often show only MM/DD — infer the year from context; today is ${today}, and transactions are in the past, so never return a date more than 3 days in the future. For a row marked "Pending" use null instead.
- "pending": true only for rows the app labels "Pending"; false otherwise.
- "time": HH:MM in 24-hour form, only if actually printed on the image. Statements normally have no time — use null then. Do not invent a time.
- "amount": the TRANSACTION amount as printed — never the running balance, never a summary total. A positive number, no currency symbol, no thousands separator, positive even for refunds and payments.
- "currency": 3-letter ISO code of the amount as printed. Do not convert.
- "kind": "expense" for normal spending; "refund" for returns/credits/reversals; "payment" for card payments, transfers between your own accounts, ATM withdrawals, and "PAYMENT - THANK YOU" rows.
- "items": ON A RECEIPT ONLY, up to 8 of the purchased line-item names, copied as printed. This is what lets the next step tell a grocery run apart from a furniture purchase at the same store, so it matters. On a statement row use [].
- "category": a rough first guess, one of: ${categoryNames.join(' / ')}. A dedicated step will redo this properly, so do not overthink it.
- "confidence": 0-1, how sure you are about this row's amount and merchant.

If the image contains no readable transaction, return {"kind":"unknown","transactions":[]}.`;
}

/** 第一段：读图。返回 { kind, transactions, model, raw } */
export async function analyzeImage({ base64, mime, categories, today }) {
  const names = categories.map(c => (typeof c === 'string' ? c : c.name));
  const { parsed, model, raw } = await callModel({
    what: '识别',
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: extractPrompt(names, today) },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
        ],
      },
    ],
  });

  return {
    kind: parsed.kind || 'unknown',
    transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
    truncated: Boolean(parsed.truncated),
    model, raw,
  };
}

/* ------------------------------------------------- 第二段：专职分类 */

const CLASSIFY_SYSTEM = `You are a personal-finance categoriser. You assign each transaction to exactly one category from a fixed list.
You always reply with a single raw JSON object and nothing else — no prose, no markdown fences.`;

function classifyPrompt({ items, categories, history }) {
  const catBlock = categories
    .map(c => `- ${c.name}${c.hint ? ` — ${c.hint}` : ''}`)
    .join('\n');
  const names = categories.map(c => c.name);

  const historyBlock = history?.length
    ? `\nHOW THIS USER HAS CATEGORISED THINGS BEFORE (their own past choices — follow them for the same or similar merchants):\n`
      + history.map(h => `- ${h.merchant} → ${h.category}`).join('\n') + '\n'
    : '';

  return `Assign a category to each transaction below.

CATEGORIES (you must copy one of these names verbatim, in Chinese: ${names.join(' / ')}):
${catBlock}
${historyBlock}
TRANSACTIONS:
${JSON.stringify(items, null, 1)}

How to decide:
1. If this user has already categorised the same merchant (see the list above), use that same category. Their habit beats your prior.
2. Otherwise decide from what was actually bought, not just the merchant's industry. "items" tells you this: a Target run full of milk and eggs is groceries; a Target run with a lamp is shopping. When "items" is empty you only have the merchant name, so go with what that merchant is best known for.
3. "kind":"payment" means money was moved, not spent — those always go to the transfer/repayment category.
4. Prefer a specific category over "${FALLBACK_CATEGORY}". Only fall back to "${FALLBACK_CATEGORY}" when nothing else plausibly fits.

Return JSON, one entry per transaction, keyed by the same "i" index:
{"results":[{"i":0,"category":"餐饮","confidence":0.93,"why":"coffee shop"}]}

"why" is at most 6 words and is only for debugging. Every index must appear exactly once.`;
}

/**
 * 第二段：给一批交易分类。
 * rows 是归一化之后的记录（会被就地改写 category）。
 * 返回 { changed, model, raw }。任何异常都往上抛，由调用方决定是否降级。
 */
export async function classifyRows({ rows, categories, history, today }) {
  if (!rows.length) return { changed: 0, model: null, raw: null };

  const names = categories.map(c => c.name);
  const items = rows.map((r, i) => ({
    i,
    merchant: r.merchant,
    descriptor: r.note || undefined,          // 账单原始描述行，有时比干净店名信息多
    amount: r.amount_cents / 100,
    kind: r.txn_kind,
    date: r.txn_date,
    items: r.items?.length ? r.items.slice(0, 8) : undefined,
  }));

  const cls = loadConfig().classify || {};
  const { parsed, model, raw } = await callModel({
    what: '分类',
    model: cls.model || undefined,
    endpoint: { base_url: cls.base_url, api_key: cls.api_key },
    messages: [
      { role: 'system', content: CLASSIFY_SYSTEM },
      { role: 'user', content: classifyPrompt({ items, categories, history }) },
    ],
  });

  const results = Array.isArray(parsed.results) ? parsed.results : [];
  let changed = 0;
  for (const r of results) {
    const idx = Number(r?.i);
    if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) continue;
    if (!names.includes(r?.category)) continue;      // 白名单，模型编的一律不认
    if (rows[idx].category !== r.category) {
      rows[idx].category = r.category;
      changed++;
    }
    rows[idx].category_why = typeof r.why === 'string' ? r.why.slice(0, 60) : null;
  }
  return { changed, model, raw };
}
