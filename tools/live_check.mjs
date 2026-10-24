// 临时活体验证：拿 live settings.json 里的配置真调一次本机网关。
// 只手动跑一次，不进 run-all（要花钱/要联网）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSettings, settingsTemplate, cleanOptimized, systemPromptFor } from '../src/optimize.js';

const file = path.join(os.homedir(), '.dsh', 'peak-whale', 'settings.json');
const s = readSettings(file, process.env);
console.log('file        :', file);
console.log('model       :', s.model);
console.log('effort      :', JSON.stringify(s.reasoningEffort));
console.log('baseUrl     :', s.baseUrl);
console.log('apiKey      :', s.apiKey ? `${s.apiKey.slice(0, 6)}…(${s.apiKey.length})` : '(空)');
console.log('settingsTpl :', settingsTemplate().model, '/', settingsTemplate().reasoningEffort);

const res = await fetch(`${s.baseUrl}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${s.apiKey}` },
  body: JSON.stringify({
    model: s.model,
    reasoning_effort: s.reasoningEffort,
    stream: false,
    messages: [
      {
        role: 'system',
        content: systemPromptFor('auto', s.promptStyle),
      },
      { role: 'user', content: `【原始提示词】\n整理一下我的日志文件` },
    ],
  }),
});
const payload = await res.json();
if (!res.ok) {
  console.log('HTTP', res.status, JSON.stringify(payload).slice(0, 400));
  process.exit(1);
}
const msg = payload.choices[0].message;
console.log('HTTP        :', res.status);
console.log('finish      :', payload.choices[0].finish_reason);
console.log('reasoning   :', typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0);
console.log('usage       :', JSON.stringify(payload.usage));
console.log('--- raw content ---');
console.log(msg.content);
console.log('--- cleanOptimized ---');
console.log(cleanOptimized(msg.content));
