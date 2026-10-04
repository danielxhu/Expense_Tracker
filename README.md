# Personal Expense Tracker

Upload a receipt photo or a bank statement screenshot. It reads the merchant, amount, time and
category automatically. Three layers of de-duplication make sure nothing gets recorded twice.

Runs on your own Windows laptop. All data lives in a single local file, `data/data.db`.

> **Note on language:** the web interface is in Chinese. Where this document mentions a button or
> a field, the Chinese label is given in brackets so you can find it on screen.

---

## 1. Getting it running on the Windows laptop

### 1.1 Install Node.js

Download the **LTS build** from <https://nodejs.org> — it must be **version 24 or newer**. Accept
all the defaults.

When it's done, open Command Prompt and run `node -v`. You should see `v24.x.x`.

### 1.2 Copy this folder to the laptop

Anywhere is fine, e.g. `D:\jizhang`.

**No `npm install` needed.** This project has **zero dependencies** — the database is Node 24's
built-in SQLite. Nothing has to be compiled, so there is no "it won't install" failure mode.

### 1.3 Double-click `start.bat`

A console window prints the addresses to use, and your browser opens automatically.

The first time it runs, Windows Firewall will ask for permission — **tick "Private networks"
(专用网络) and allow it**, otherwise your phone won't be able to connect.

> That console window *is* the service. **Closing the window stops it.** To keep it running, just
> minimise it.

### 1.4 Add a free API key for image recognition

Open the site → **Settings** (「设置」, top right) → pick a provider → click **Get a key ↗**
(「去申请 key ↗」) → paste the key back in → **Save** (「保存」) → click **Test connection**
(「测试连通性」).

Recognition and categorisation are **two separate API calls** (see section 5), so you can point
them at different providers. The second call only needs a *text* model, which unlocks providers
that don't do vision at all but have far bigger free quotas.

**Stage one — recognition (must support images)**

| Provider | Free tier | Notes |
|---|---|---|
| **Google Gemini** (default) | Flash models: a few hundred to ~1,500 requests/day | Reachable from the US, least hassle |
| **Mistral** | Experiment plan: 1 billion tokens/month | Phone verification only, no credit card, works from the US. Absurdly generous |
| **DeepSeek V4 Flash Vision** | No free tier; ~$0.0005 per image | ⚠ **Not suitable for phone statement screenshots**: every image is downscaled to about 800×800 and billed at a maximum of 384 tokens, so small text on a tall screenshot turns to mush. What you save is resolution |
| **SiliconFlow** | Free tier at 1,000 RPM, several free models | Also offers DeepSeek-OCR, built for pulling text out of document images |
| **ModelScope** | 2,000 requests/day total, 500 per model | Alibaba's model hub, no card required |
| **Doubao / Volcengine Ark** | 500k trial tokens | Requires real-name verification and a minimum ¥1 top-up before you can create an inference endpoint; servers are in China |
| **Zhipu GLM-4V-Flash** | Completely free | Sign-up requires a mainland China phone number |
| **Alibaba Bailian Qwen-VL** | Trial credit for new users, very cheap after | Reads both Chinese and English receipts well |
| **OpenRouter** | Models with a `:free` suffix cost nothing | One key for every vendor |

**Stage two — categorisation (text only, and the quotas are bigger here)**

| Provider | Free tier |
|---|---|
| **Cerebras** | 1M tokens/day, 30 RPM, no card, extremely fast. 8K context; the categorisation prompt is ~2,000 tokens, so it fits |
| **Groq** | 30 RPM, thousands to tens of thousands of requests/day, also very fast |
| Leave blank | Reuse the same provider and key as stage one |

**Recommended combination:** **Gemini** or **Mistral** for recognition (they preserve the most
detail on high-resolution tall screenshots, which is what makes the small print on a statement
legible), and **Cerebras** for categorisation. Both have free tiers, so this costs nothing.

When reading phone statement screenshots, **do not pick a cheap model with a low resolution
ceiling for the recognition stage** — a 900×2000 screenshot squeezed down to 800×800 turns the
amounts and merchant names into mosaic.

If you upload a dozen images a day you will not exhaust any of the free tiers above. When quotas
change or you want to switch, **you only edit the boxes on the Settings page — not a single line
of code** — because every provider goes through the same OpenAI-compatible interface. Model names
do drift; take the current one from the provider's own list. The presets hold whatever was current
at the time.

**Test connection** tests **both stages separately**, so if one of the two keys or URLs is wrong
you'll be told exactly which.

---

## 2. Using it from your phone

### At home (same Wi-Fi)

The console window shows a line like `同一个 WiFi   http://192.168.x.x:8788` ("same Wi-Fi"). Open
that address in your phone's browser.

Use **Add to Home Screen** in Safari or Chrome and it behaves like an app.

### Away from home — Tailscale

Tailscale builds a private network between your own devices. **No public IP, no port forwarding on
your router, and nothing exposed to the internet** — only devices signed into your account can
reach it. The free tier is plenty.

1. Install <https://tailscale.com/download/windows> on the laptop and sign in
2. Install the Tailscale app on your phone, **sign into the same account**, and switch it on
3. Double-click `start.bat` again — the startup banner now shows an extra line,
   `出门在外 http://100.x.x.x:8788` ("away from home")
4. On your phone (works over 4G/5G with Wi-Fi off), open that address

MagicDNS is on by default, so you can also use the machine name instead of the numeric address:
`http://your-pc-name:8788`.

**If the LAN works but Tailscale doesn't**, it's almost always the firewall: if you only ticked
"Private networks" on that first prompt and Windows classified the Tailscale adapter as a public
network, the connection gets blocked. Open PowerShell **as Administrator** and add a rule that
only opens the port to the Tailscale range (far safer than opening public networks wholesale):

```powershell
New-NetFirewallRule -DisplayName "jizhang 8788 Tailscale" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8788 -RemoteAddress 100.64.0.0/10 -Profile Any
```

`100.64.0.0/10` is the address range Tailscale uses, so this rule only admits devices on your own
Tailscale network. The public internet still can't get in.

### Don't let the laptop sleep

If the laptop sleeps, the service stops.

Settings → System → Power & battery → **"When plugged in, put my device to sleep after: Never"**.

Closing the lid also sleeps it — go to Control Panel → Power Options → **Choose what closing the
lid does**, and set it to **Do nothing** when plugged in.

---

## 3. Billing periods: each one starts on the 15th

By default **Aug 15 – Sep 14 is one period**, and Sep 15 starts the next. The start day is the
*first* day of the new period — that way no single day falls into two periods, so nothing gets
counted twice.

The dropdown at the top of the home page lists periods (`8月15日 – 9月14日`). The donut chart, the
total, and the "vs. last period" comparison all follow the billing period.

To change the start day: **Settings → Billing period** (「账期」) → enter a number from 1 to 31.
**Setting it to 1 gives you ordinary calendar months.** A value like 31 is clamped to the last day
in short months (February becomes the 28th or 29th), and the following period correctly returns to
the 31st rather than staying clamped forever.

---

## 4. Multi-currency: converting a CNY statement to USD

Cards that charge US merchants but post in CNY (a Chinese credit card used for USD purchases) work
fine.

**The original amount is stored exactly as it appears on the statement and never changes with the
exchange rate.** The converted value is derived from it: change a rate under **Settings → Currency
& rates** (「币种与汇率」) and click **Save and recompute** (「保存并重算」) — every historical
record's converted value is recalculated, while the original amounts are untouched.

In the list the main currency is on top (that's what the totals use) and the original below:

```
Longhorn Steakhouse                  $58.80
其他 · 账单                          ¥426.09
```

**De-duplication uses the original amount**, so changing the rate can never cause the same
transaction to be recorded twice — that specific case is covered by a test.

A currency with no configured rate is marked "not converted" (「未折算」) and is **excluded from
the total** — better that you can see the gap than that a made-up number quietly enters your
statistics. The home page shows how many are pending; add the rate, hit recompute, and they fall
into place.

Your bank already applied its own exchange rate when the charge posted, so this is only converting
it back for a rough picture. It doesn't need to be exact.

### Setting the currency for a specific image

Models occasionally confuse `¥` and `$`. You know which card the statement came from, so you can
just tell it:

- **Before uploading** — the **Upload** (「上传」) page has a **currency for this batch**
  (「这批图的币种」) dropdown under the drop zone. Pick one and the whole image is recorded in that
  currency regardless of what the model says. **Your choice is remembered**, so you don't have to
  reselect it every time you upload from the same card.
- **After the fact** — if it's already wrong, click the ✎ on that row → pick the right currency →
  **change every record from this image to XX** (「这张图的账目全部改成 XX」). Far better than
  fixing several dozen rows one at a time.

That operation is **all-or-nothing**: if the change would produce records identical to ones
already in the database (usually because this statement was already uploaded once with the correct
currency), nothing is changed and you're told why. You never end up with half an image in USD and
half in CNY.

The de-duplication fingerprint **includes the currency**, so `$124.91` and `¥124.91` at the same
merchant on the same day are two distinct records and won't displace each other.

---

## 5. How categorisation works

Categorisation and recognition are **two independent model calls** that each do one job.

### Stage one: the vision model only reads the text accurately

Merchant, amount, date, time, whether it's a charge or a credit; for a receipt it also reads up to
8 line items. The prompt explicitly tells it *"a separate step handles categorisation, don't spend
effort on it"* — asking one call to OCR every row without missing any **and** judge categories
makes the two tasks compete for attention.

### Stage two: dedicated categorisation (text-only call)

Everything stage one read is handed to a single categorisation call in one batch. It gets three
things stage one cannot provide:

1. **A semantic hint for every category** — spelling out typical merchants and easily confused
   cases, e.g. "娱乐 (entertainment) = cinema and event tickets … **but monthly subscriptions go
   to 通讯订阅**"
2. **Receipt line items** — at the same Target, `ORGANIC WHOLE MILK / LARGE EGGS / BANANAS` is
   groceries (「超市日用」); a lamp is shopping (「购物」)
3. **Your own past choices** — fed in as examples like `- Netflix → 通讯订阅`, with the prompt
   stating explicitly that the user's habit outranks the model's prior

Category hints are **editable directly on the Settings page** and take effect on the very next
image.

**The categorisation model can be set separately**: Settings → Recognition model → categorisation
call. Leave it blank to reuse the vision model, or use a cheap fast model for vision and a stronger
text model for categorisation.

**Graceful degradation**: if stage two fails (rate limit, timeout) the upload isn't wasted — the
rough guess from stage one is recorded instead, and the result tells you plainly that the
categorisation step didn't run.

**Whitelist**: any category from stage two that isn't on the list (invented, or returned in
English) is discarded and the rough guess kept. No junk categories ever reach the database.

**Quota saving**: rows that already have a merchant rule are never sent for categorisation; if
every row in an image has a rule, stage two isn't called at all.

### Merchant memory: what you set by hand is final

Even a good model is inconsistent sometimes, so there's one deterministic layer on top.

When you click the ✎ on a record and change its category, **"Remember: always file this merchant
here"** (「记住：以后这个商户都归到这一类」) is ticked automatically. With it ticked:

- A rule is saved, and **every historical record from the same merchant is updated too** (you're
  told how many)
- From then on that merchant **uses the category you chose** — whatever either model says

Rules apply **per brand, not per store**: a rule for `Starbucks` also matches
`STARBUCKS #9911 PORTLAND OR`. More specific rules win — with both `AMAZON` and `AMAZON FRESH`
present, an Amazon Fresh charge follows the latter.

Rules are listed and removable under **Settings → Merchant memory** (「商户记忆」). Delete one and
the decision goes back to the model. The checkbox is not auto-ticked when you only change an
amount or date, so you won't create a rule by accident.

**When not to create a rule**: a store like Target where you buy both groceries and furniture —
let stage two decide from the receipt's line items instead of forcing one answer.

---

## 6. How de-duplication works

This is where most of the care went. Three layers:

**① The same image uploaded twice** — judged by the SHA-256 fingerprint of the original file,
100% certain. Upload it again and you're told "this image was already uploaded on X" — not a
single record is duplicated.

**② Overlapping scrolled statement screenshots** — judged by
`date + normalised merchant + amount + which occurrence that day`, also deterministic.

"Which occurrence that day" is the key. If Starbucks $8.50 appears twice in one screenshot, those
are **two real coffees**, stored as occurrence 1 and 2. The next, overlapping screenshot reads the
same two, finds the database already holds 2 → skips both. If you genuinely bought a third, a new
screenshot shows 3 → only the third is added.

So overlapping screenshots don't cause duplicates, and several genuine purchases at the same shop
for the same price aren't mistaken for duplicates either.

**②a Dates as group headers** — some apps (Chinese bank apps especially) print the date once as a
separator with several transactions listed underneath, and those rows carry no date of their own.
The prompt explicitly requires "carry the nearest date header above down to every row beneath it",
so nothing is dropped just because its row had no date printed.

**②b Pending transactions being confirmed** — the top rows in a banking app are marked `Pending`
and have no date. These are recorded under today's date and tagged "pending" (「待入账」). A few
days later, when the charge posts with a real date and is read again, the program **updates the
existing record in place** rather than adding a new one. It matches on same source + same merchant
+ same amount + dates within 7 days.

**③ A receipt and a statement line being the same purchase** — this layer **cannot be settled by
code with certainty**, so it never touches your data automatically.

The receipt you photographed in the shop says `Starbucks 09/01 14:32 $8.50`; a few days later the
BofA statement says `CHECKCARD 0901 STARBUCKS STORE 04472 SEATTLE WA 09/02 $8.50` — different
date, different merchant string, only the amount matches.

When the **amount matches exactly, the merchant names are ≥45% similar, and the dates are within
4 days**, a notice appears at the top of the records page: "N possible duplicates found". You open
it, glance at the pair, and either merge them or say they're not the same. Merging keeps the
statement row (the bank's amount is authoritative) and copies the receipt's exact time and
category onto it.

**A wrong merge is reversible**: click the ✎ on that record → **Undo merge** (「撤销合并」) and the
absorbed record comes back exactly as it was.

---

## 7. Day-to-day use

- **Receipts**: open **Upload** (「上传」) on your phone → tap the box → take a photo or pick from
  the library → it's recognised and recorded
- **Statements**: scroll and take several screenshots in the banking app → select them all and
  upload at once; overlaps are skipped automatically. The `Pending` rows at the top are recorded
  too, tagged "pending", and are promoted automatically once they post — no duplicates
- **Faster on a computer**: take a screenshot and just press `Ctrl+V` on the Upload page
- **Something's wrong**: click the ✎ on the right of that row in the list
- **Wrong category**: click ✎, fix it, leave "Remember" ticked, and that shop is right from then on
- **Reshaping the category set**: the Settings page lets you add, edit and delete categories and
  their hints; renaming a category migrates existing records with it

---

## 8. Data and privacy

**Backup**: the entire database is the single file `data/data.db` — copy it and you have a
complete backup. Original images live in `data/uploads/`. The Settings page can also export CSV at
any time (with a BOM, so Chinese text opens correctly in Excel).

**On sending statement screenshots to a third party**: recognition works by uploading the image to
whichever model provider you chose. A few things worth knowing:

- The prompt explicitly instructs the model **not to output account numbers, card numbers or
  balances**, so those never reach the database
- But **the image itself** is transmitted in full. Free-tier data-use terms are typically looser
  than paid ones (some vendors use free traffic to improve their models)
- If that bothers you, there are two options: crop out the account number area before uploading,
  or switch the same provider to its paid tier — a fraction of a cent per image

---

## 9. Troubleshooting

**After an update, endpoints 404 or new features do nothing**
**Always restart the service after copying new files**: close the console window and double-click
`start.bat` again.

The web pages (everything under `public/`) are read from disk on every request, so the new
interface appears immediately — but `server.js` and `lib/` are loaded into memory when Node
starts, so without a restart the old code is still running. The symptom is confusing: **a new
button appears, and clicking it says "no such endpoint"**.

The program detects this itself — when you open a page, if the code on disk doesn't match what's
running in memory, a red banner appears at the top. Restart when you see it.

**`start.bat` flashes and disappears**
Node isn't installed, or the version is too old. Open Command Prompt, `cd /d D:\jizhang`, and run
`node server.js` — the error stays on screen.

**Phone can't connect**
① Check the phone and laptop are on the same Wi-Fi. ② Did you click "Deny" on that firewall
prompt? Go to Windows Security → Firewall & network protection → Allow an app through firewall,
and tick Node.js for private networks.

**"Port already in use"**
Usually one is already running. To change the port, edit `"port"` in `config.json`.

**A long statement was only partly recorded / "output was truncated"**
There's a limit to how much a model can write in one response, so a statement with many rows may
hit it mid-way. The program keeps the rows that were written completely (rather than discarding
the whole image) and lets you **upload the same image again** to fill in the rest — duplicate rows
are skipped, so nothing is recorded twice. Once complete, that image counts as fully read and a
further upload is blocked normally.
If this keeps happening, raise **max_tokens** on the Settings page (16000, say), or capture fewer
rows per screenshot.

**"The model returned empty content"**
First check whether the error includes a **`finish_reason`**. If it doesn't, the service is still
running old code — close the console window and double-click `start.bat` again.

If it does, the program has already tried three rounds (original budget → triple budget with
thinking disabled → triple budget) before reporting. Act on the `finish_reason`:

- `finish_reason=length` — the budget was consumed by the model's own reasoning. Raise
  **max_tokens** on the Settings page (16000, say), or set **reasoning effort** (「思考强度」) to
  `none`.
- `finish_reason=content_filter` — that provider's safety filter treated the bank statement as
  sensitive. Switch provider, or crop out the account number before uploading.
- `finish_reason=stop` with no output — usually means you picked a model that can't read images
  (Cerebras and Groq can only do stage two).

Full context for every failure is written to `data\last-error.json` — exactly what the model
returned, token usage, and the request parameters, **with no API key**. If it isn't clear, send
that file.

**Categories are inaccurate**
Start by making that category's **hint** more specific on the Settings page (typical merchants,
and which category it's easily confused with). If it's still wrong, fix one record with "Remember"
ticked and that shop is pinned from then on. You can also point the categorisation call at a
stronger model.

**Recognition is inaccurate (wrong amounts or merchant names)**
Try a different vision model (just change the model name on the Settings page). Photograph
receipts flat, well lit, with the whole slip in frame. Failing that, edit by hand, or use
**Add a record manually** (「手动记一笔」) at the bottom of the Upload page.

**Start automatically at boot**
Press `Win+R`, enter `shell:startup`, and drop a shortcut to `start.bat` into that folder.

---

## Technical notes

- **Zero dependencies**: Node 24's built-in `node:sqlite`, `node:crypto` and `fetch`.
  `package.json` lists no dependency at all
- **No frontend build**: plain HTML/CSS/JS — edit and refresh
- Vision calls go through the OpenAI-compatible `/chat/completions` endpoint, so switching provider
  means editing `config.json` only

```
server.js            HTTP server and routing
lib/db.js            Schema and every query
lib/dedupe.js        The three de-duplication layers
lib/period.js        Billing-period maths (starts on the 15th by default)
lib/normalize.js     Parsing and normalising dates, times and amounts
lib/vision.js        The two model calls: reading the image, and categorisation
lib/config.js        Configuration and provider presets
public/              The three pages
data/data.db         All of your data
```
