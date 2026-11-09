'use strict';

/**
 * 本地桩：模拟一个 OpenAI 兼容的 /v1/chat/completions 服务。
 *
 * 用途是在没有真实 API Key 的情况下，端到端验证「解读 + 长尾归类」这条链路：
 * 请求体长什么样、返回的 JSON 能不能被解析、归类结果有没有真的写回 digest。
 * 它只依赖 Node 内置 http，不装任何依赖。
 *
 * 用法：
 *   node tools/stub-ai-server.js [port]        # 默认 8799
 *   # 另开一个终端：
 *   HOTSPOT_AI_BASE_URL=http://127.0.0.1:8799/v1 \
 *   HOTSPOT_AI_MODEL=stub-model \
 *   HOTSPOT_AI_KEY=stub-key-1234 \
 *   electron . --interpret-once --user-data=<临时目录> --no-sandbox --disable-gpu
 *
 * 注意：桩只用于自测，不要把它当成真实模型来评估解读质量。
 */

const http = require('http');

const PORT = Number(process.argv[2]) || 8799;

/** 与 config/boards.json 的九个板块 id 保持一致 */
const BOARDS = [
  'society',
  'ent',
  'tech',
  'finance',
  'sports',
  'world',
  'life',
  'health',
  'other',
];

/** 从提示词里抠出末尾的 JSON 数组 */
function pickJsonArray(text) {
  const s = String(text || '');
  const first = s.indexOf('[');
  const last = s.lastIndexOf(']');
  if (first === -1 || last <= first) return null;
  try {
    return JSON.parse(s.slice(first, last + 1));
  } catch {
    return null;
  }
}

function hashOf(key) {
  let h = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 100000;
  return h;
}

function boardFor(key) {
  return BOARDS[hashOf(key) % BOARDS.length];
}

function buildResponse(userText) {
  if (userText.includes('逐条写解读')) {
    const rows = pickJsonArray(userText) || [];
    const out = rows.map((r) => ({
      rank: r.rank,
      read: `[桩] 第 ${r.rank} 条「${String(r.title || '').slice(0, 14)}」来自 ${(r.platforms || []).join('/')}，此处为链路自测文案。`,
    }));
    return { task: 'interpret', n: out.length, content: JSON.stringify(out) };
  }

  // 终审：一半沿用规则给的 suggested（考验「不覆盖」路径），一半改成桩自己的判断（考验回写路径）
  const rows = pickJsonArray(userText) || [];
  const out = rows.map((r) => {
    const keep = hashOf(r.key) % 2 === 0;
    return {
      key: r.key,
      board: keep && r.suggested ? r.suggested : boardFor(r.key),
      confidence: 'high',
    };
  });
  return { task: 'classify', n: out.length, content: JSON.stringify(out) };
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url || '')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }

  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch {
      /* 原样继续，下面的解析会给出空结果 */
    }

    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const userText = messages
      .filter((m) => m && m.role === 'user')
      .map((m) => String(m.content || ''))
      .join('\n');
    const systemLen = messages
      .filter((m) => m && m.role === 'system')
      .map((m) => String(m.content || '').length)
      .reduce((a, b) => a + b, 0);

    const built = buildResponse(userText);
    const auth = String(req.headers.authorization || '');

    console.log(
      `[stub] ${built.task} n=${built.n} model=${payload.model} auth=${auth ? auth.slice(0, 18) + '…' : '(无)'} systemChars=${systemLen}`,
    );

    const reply = {
      id: 'stub-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: payload.model || 'stub-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: built.content },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: Math.ceil(userText.length / 2),
        completion_tokens: Math.ceil(built.content.length / 2),
        total_tokens: Math.ceil((userText.length + built.content.length) / 2),
      },
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[stub] 桩服务已启动 http://127.0.0.1:${PORT}/v1  （Ctrl+C 退出）`);
});
