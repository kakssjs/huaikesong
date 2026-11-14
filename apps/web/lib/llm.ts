// 大模型客户端（OpenAI 兼容 /chat/completions）。使用 curl 子进程绕过 webpack fetch polyfill 问题。
// JSON body 通过 stdin 传递，避免 Windows 命令行编码问题。
// 供应商只由环境变量决定：LLM_API_KEY（必填）、LLM_BASE_URL、LLM_MODEL、LLM_VISION_MODEL（看图用，默认同 LLM_MODEL）。

const { spawn } = eval('require')('node:child_process');

import { mergeRuns, parseRecognition, type RawRoom, type RawRun } from './recognition';
import { assignOpeningsToRooms } from '@i-renovation/shared/plan';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export function httpsPost(url: string, body: Record<string, unknown>, headers: Record<string, string>, timeoutMs = 65000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headerArgs = Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
    const args = ['-s', '-w', '\n%{http_code}', '-X', 'POST', ...headerArgs, '--data-binary', '@-', url];

    const child = spawn('curl', args, { timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });
    child.on('error', (err: Error) => reject(new Error(`curl spawn failed: ${err.message}`)));
    child.on('close', (code: number | null) => {
      if (code !== 0) { reject(new Error(`curl exit ${code}: ${stderr}`)); return; }
      const lastNewline = stdout.lastIndexOf('\n');
      const bodyStr = lastNewline > 0 ? stdout.slice(0, lastNewline) : stdout;
      const statusStr = lastNewline > 0 ? stdout.slice(lastNewline + 1).trim() : '0';
      resolve({ status: parseInt(statusStr, 10) || 0, body: bodyStr });
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

interface Provider { base: string; key: string; model: string }

function providerFor(withImage: boolean): Provider | null {
  const key = process.env.LLM_API_KEY;
  if (!key) return null;
  const base = (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = process.env.LLM_MODEL || 'deepseek-flash';
  // 实测 deepseek-v4-pro 对图片返回 200 但忽略图像、凭空编造内容，所以 DeepSeek 看图固定默认 deepseek-flash；
  // 换成别的供应商时看图模型默认同 LLM_MODEL，需要不同模型就设 LLM_VISION_MODEL。
  const visionDefault = base.includes('deepseek.com') ? 'deepseek-flash' : model;
  return { base, key, model: withImage ? process.env.LLM_VISION_MODEL || visionDefault : model };
}

async function requestChat(p: Provider, messages: ChatMessage[], opts?: { imageBase64?: string; mime?: string; maxTokens?: number; noThinking?: boolean }): Promise<{ text: string; tokensUsed: number }> {
  let content: unknown = messages[messages.length - 1].content;
  if (opts?.imageBase64) {
    content = [
      { type: 'text', text: messages[messages.length - 1].content },
      { type: 'image_url', image_url: { url: `data:${opts.mime ?? 'image/png'};base64,${opts.imageBase64}` } },
    ];
  }

  const body = {
    model: p.model,
    messages: [...messages.slice(0, -1), { role: 'user', content }],
    max_tokens: opts?.maxTokens ?? 2000,
    // 看图识别这类任务不需要长时间思考：关掉思考，约快 4 倍，且不会因思考耗尽回答长度而返回空内容。
    // thinking 是 DeepSeek V4 的开关；换成不认识该字段的供应商时请求会被拒（400），需删掉这一行。
    ...(opts?.noThinking ? { thinking: { type: 'disabled' } } : {}),
  };

  // 直连实测有 10 秒以上的波动，65 秒上限会误杀正常回答
  const res = await httpsPost(`${p.base}/chat/completions`, body, {
    'content-type': 'application/json',
    authorization: `Bearer ${p.key}`,
  }, 120_000);
  if (res.status < 200 || res.status >= 300) throw new Error(`LLM API ${res.status}: ${res.body.slice(0, 200)}`);

  const data = JSON.parse(res.body) as { choices: { message: { content: string | null } }[]; usage?: { total_tokens?: number } };
  // reasoning_content 是思考过程，不能当答案用
  const text = data.choices[0]?.message?.content ?? '';
  if (!text.trim()) throw new Error('LLM API 返回空内容');
  return { text, tokensUsed: data.usage?.total_tokens ?? 0 };
}

export async function callLLM(messages: ChatMessage[], opts?: { imageBase64?: string; mime?: string; maxTokens?: number; noThinking?: boolean }): Promise<{ text: string; tokensUsed: number }> {
  const provider = providerFor(!!opts?.imageBase64);
  if (!provider) throw new Error('LLM_API_KEY not configured');
  return requestChat(provider, messages, opts);
}

/**
 * 户型图视觉识别（画板「AI 识别房间」和 floor_plan 智能体共用这一份实现）：
 * 图片 → 房间矩形 + 门窗（归一化 0~1 坐标）。同一张图并行识别 runs 次，只保留多数次一致的结果。
 */
export async function recognizeFloorPlan(b64: string, mime: string, runs = 3): Promise<
  { rooms: (RawRoom & { openings: ReturnType<typeof assignOpeningsToRooms>[number] })[]; runs: number; tokensUsed: number }
  | { error: string; raw: string; status: number; tokensUsed: number }> {
    const prompt = [
      '这是一张户型平面图（可能是手绘草图或标准制图）。请识别图中所有房间，以及墙上所有的门和窗。',
      '只返回严格 JSON，不要 markdown 代码块、不要解释：',
      '{"rooms":[{"name":"客厅","x":0.1,"y":0.2,"w":0.35,"d":0.4}],"windows":[{"x":0.2,"y":0.19,"w":0.1,"d":0.02}],"doors":[{"x":0.44,"y":0.5,"w":0.02,"d":0.08}]}',
      '所有坐标都是相对整图的归一化坐标（0~1），x 向右、y 向下，w/d 为宽高。',
      'rooms 是房间矩形，忽略尺寸标注和文字注释，房间名用中文（客厅/主卧/次卧/厨房/卫生间/阳台/书房/餐厅等）。',
      'windows 是每一扇窗在图上的外框（窗通常画成墙上的蓝色双线或细线）。doors 是每一扇门在图上的外框（门画成墙上的一个缺口，常带一段弧线）。',
      '一扇门或窗只写一次，即使它被两个房间共用。只写图上真的画出来的，不要猜。没有就写 []。',
    ].join('\n');

    const settled = await Promise.allSettled(Array.from({ length: runs }, () =>
      callLLM([{ role: 'user', content: prompt }], { imageBase64: b64, mime, maxTokens: 4000, noThinking: true })));

    const parsed: RawRun[] = [];
    let tokensUsed = 0;
    let lastRaw = '';
    let lastError = '';
    for (const r of settled) {
      if (r.status === 'rejected') { lastError = (r.reason as Error).message; continue; }
      tokensUsed += r.value.tokensUsed;
      lastRaw = r.value.text;
      const run = parseRecognition(r.value.text);
      if (run) parsed.push(run);
    }
    if (parsed.length === 0) {
      return { error: lastError || '识别结果无法解析', raw: lastRaw.slice(0, 200), status: lastError ? 502 : 422, tokensUsed };
    }

    const merged = mergeRuns(parsed);
    const { rooms, windows, doors } = merged.run;
    if (rooms.length === 0) {
      return { error: '多次识别没有一致的房间，请换一张更清晰的户型图', raw: lastRaw.slice(0, 200), status: 422, tokensUsed };
    }
    const hints = assignOpeningsToRooms(rooms, [
      ...windows.map(({ votes, ...b }) => ({ type: 'window' as const, ...b, conf: votes / merged.runs })),
      ...doors.map(({ votes, ...b }) => ({ type: 'door' as const, ...b, conf: votes / merged.runs })),
    ]);

    return { rooms: rooms.map((r, i) => ({ ...r, openings: hints[i] })), runs: merged.runs, tokensUsed };
}
