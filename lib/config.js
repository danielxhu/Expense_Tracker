import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const FILE = path.join(process.cwd(), 'config.json');

const DEFAULTS = {
  port: 8788,
  // 视觉模型走 OpenAI 兼容接口。换供应商只改这三行，代码一行不用动。
  vision: {
    provider: 'gemini',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    api_key: '',
    json_mode: false,      // 有的供应商不支持 response_format，默认关掉靠解析兜底
    max_tokens: 8000,      // 带思考的模型会先花掉一部分，留够余量
    reasoning_effort: '',  // 填 none 可关掉思考（Gemini 2.5 等支持）；留空则不发这个字段
    timeout_ms: 90000,
  },
  // 第二段：专职分类的调用。走同一个 base_url/key，模型可以单独指定。
  classify: {
    enabled: true,
    provider: '',        // 留空 = 整个跟视觉共用（同一家、同一个 key）
    base_url: '',        // 填了就换一家 —— 第二段只要文本模型，可以挑额度更大的
    api_key: '',
    model: '',
    use_history: true,   // 把你过去的分类习惯当例子喂给模型
  },
  // 记账主币种。外币交易按下面的汇率折算成它来统计。
  currency: 'USD',
  // 外币 → 主币种 的汇率。1 单位外币值多少主币种。
  // 信用卡实际入账已经按银行汇率换过一次了，这里只是把它折回来看个大概，不必追求精确。
  rates: { CNY: 0.1400, HKD: 0.1280, EUR: 1.0800, GBP: 1.2700, JPY: 0.0067, TWD: 0.0310 },
  // 账期起始日。15 = 每月 15 号起算一期（8/15–9/14）。设成 1 就是自然月。
  cycle_start_day: 15,
};

/** 各家免费/低价方案的现成配置，设置页里一键填入 */
/**
 * 各家现成配置。vision:false 的只能做第二段（分类）——
 * 它们不读图，但纯文本的免费额度反而大得多。
 * 模型名以各家官网列表为准，这里填的是当下常见的那个，过时了自己改。
 */
export const PRESETS = {
  gemini: {
    label: 'Google Gemini（视觉，免费额度大）',
    vision: true,
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    apply_url: 'https://aistudio.google.com/apikey',
    note: '免费档 Flash 系列每天几百到一千多次请求，自用绰绰有余。需要笔记本能访问 Google。',
  },
  mistral: {
    label: 'Mistral（视觉，每月 10 亿 token 免费）',
    vision: true,
    base_url: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    apply_url: 'https://console.mistral.ai/api-keys',
    note: 'Experiment 计划每月 10 亿 token，只需手机验证、不用信用卡，美国可直连。视觉模型也可填 pixtral-12b-2409。',
  },
  deepseek: {
    label: 'DeepSeek V4 Flash Vision（极便宜，但会把图缩到 800×800）',
    vision: true,
    base_url: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash-vision-exp',
    apply_url: 'https://platform.deepseek.com/api_keys',
    note: '⚠ 不建议用来读手机账单截图：它会把每张图缩到约 800×800、每图最多按 384 token 计费，'
        + '长截图上的小字缩完基本糊掉，读不准甚至读不出来。便宜（一张图约 $0.0005）'
        + '但省的是分辨率的钱。适合图少字大的场景。读账单截图请用 Gemini 或 Mistral。'
        + '另外它按量付费要充值，exp 后缀是实验版可能会变。',
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow（视觉，免费档 1000 RPM）',
    vision: true,
    base_url: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-VL-7B-Instruct',
    apply_url: 'https://cloud.siliconflow.cn/account/ak',
    note: '免费档速率很高，另有专做文档图片取字的 DeepSeek-OCR。模型名要照官网列表的完整 id 填。',
  },
  modelscope: {
    label: '魔搭 ModelScope（视觉，每天 2000 次免费）',
    vision: true,
    base_url: 'https://api-inference.modelscope.cn/v1',
    model: 'Qwen/Qwen2.5-VL-7B-Instruct',
    apply_url: 'https://modelscope.cn/my/myaccesstoken',
    note: '阿里的模型社区，不用信用卡。免费额度每天 2000 次总量、单模型 500 次。',
  },
  doubao: {
    label: '豆包 / 火山方舟（视觉，送 50 万 token）',
    vision: true,
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-1-6-251015',
    apply_url: 'https://console.volcengine.com/ark',
    note: '豆包 1.6 系列多模态能读图，现在可以直接填模型名（不用再建 ep-xxxx 接入点）。'
        + '送 50 万 token 试用，但要实名、且需最低充值 1 元才能创建推理接入点。服务器在国内，人在美国延迟会高些。',
  },
  zhipu: {
    label: '智谱 GLM-4V-Flash（视觉，完全免费）',
    vision: true,
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4v-flash',
    apply_url: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: '国内直连不用梯子，视觉模型免费。注册需要中国大陆手机号。',
  },
  dashscope: {
    label: '阿里百炼 Qwen-VL（视觉，新用户免费额度）',
    vision: true,
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-plus',
    apply_url: 'https://bailian.console.aliyun.com/',
    note: '中英文小票都读得好，单价极低，新用户送额度。',
  },
  openrouter: {
    label: 'OpenRouter（聚合，有免费模型）',
    vision: true,
    base_url: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.5-flash',
    apply_url: 'https://openrouter.ai/keys',
    note: '一个 key 通所有厂商，模型名带 :free 后缀的不花钱（速率较低）。',
  },
  cerebras: {
    label: 'Cerebras（只能分类，每天 100 万 token）',
    vision: false,
    base_url: 'https://api.cerebras.ai/v1',
    model: 'llama-3.3-70b',
    apply_url: 'https://cloud.cerebras.ai/',
    note: '不读图，只能用在第二段分类。每天 100 万 token、30 RPM、不用信用卡，速度极快。上下文 8K，分类那次提示词约 2000 token，够用。',
  },
  groq: {
    label: 'Groq（只能分类，速度极快）',
    vision: false,
    base_url: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    apply_url: 'https://console.groq.com/keys',
    note: '不读图，只能用在第二段分类。免费档 30 RPM、每天上千到上万次，不用信用卡。',
  },
  custom: {
    label: '自定义 / 我已有的中转',
    vision: true,
    base_url: '',
    model: '',
    apply_url: '',
    note: '任何 OpenAI 兼容的 /chat/completions 接口都能用，填 base_url 到 /v1 那一层。',
  },
};

// 这些字段是「整体替换」而不是「逐键合并」——
// 汇率表要能删掉某个币种，合并的话删了也删不掉
const REPLACE_WHOLE = new Set(['rates']);

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (REPLACE_WHOLE.has(k)) { out[k] = v; continue; }
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base[k] || {}, v) : v;
  }
  return out;
}

export function loadConfig() {
  if (!existsSync(FILE)) return { ...DEFAULTS };
  try {
    return deepMerge(DEFAULTS, JSON.parse(readFileSync(FILE, 'utf8')));
  } catch (e) {
    console.error('config.json 解析失败，先用默认配置：', e.message);
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg) {
  const merged = deepMerge(loadConfig(), cfg);
  writeFileSync(FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

/** 给前端看的版本：key 打码，别在页面上明文回显 */
const maskKey = k => (k ? k.slice(0, 4) + '••••••' + k.slice(-4) : '');

export function publicConfig() {
  const c = loadConfig();
  return {
    ...c,
    vision: {
      ...c.vision,
      api_key: maskKey(c.vision.api_key),
      api_key_set: Boolean(c.vision.api_key),
    },
    classify: {
      ...c.classify,
      api_key: maskKey(c.classify?.api_key),
      api_key_set: Boolean(c.classify?.api_key),
    },
  };
}
