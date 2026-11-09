#!/usr/bin/env node
// Teste de carga de ponta a ponta contra uma api do AAO (staging/produção).
// Cada usuário virtual: login -> cria conversa -> N mensagens, lendo o SSE até
// o final_message. Usa a chave de LLM REAL da empresa: CUSTA TOKENS. Rode numa
// empresa de teste e comece pequeno (--users 10).
//
// Uso:
//   node scripts/loadtest.mjs --base https://api.seudominio/api \
//     --email teste@empresa.com --password '***' --users 50 --turns 2 --ramp 30
//   # várias contas: --accounts contas.csv  (uma por linha: email,senha)
//
// Sem dependências (Node 20+: fetch nativo).

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({
  options: {
    base: { type: 'string' },
    email: { type: 'string' },
    password: { type: 'string' },
    accounts: { type: 'string' },
    users: { type: 'string', default: '10' },
    turns: { type: 'string', default: '1' },
    ramp: { type: 'string', default: '10' }, // segundos para subir todos os usuários
    message: {
      type: 'string',
      default: 'Em uma frase: qual é o seu papel no escritório?',
    },
    timeout: { type: 'string', default: '600' }, // segundos por turno
  },
});

if (!opt.base || (!opt.accounts && !(opt.email && opt.password))) {
  console.error(
    'uso: node scripts/loadtest.mjs --base <url da api, com /api> (--email E --password P | --accounts contas.csv) [--users 10 --turns 1 --ramp 10]',
  );
  process.exit(64);
}

const base = opt.base.replace(/\/$/, '');
const users = Number(opt.users);
const turns = Number(opt.turns);
const rampMs = Number(opt.ramp) * 1000;
const turnTimeoutMs = Number(opt.timeout) * 1000;
const accounts = opt.accounts
  ? readFileSync(opt.accounts, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [email, ...rest] = l.split(',');
        return { email: email.trim(), password: rest.join(',').trim() };
      })
  : [{ email: opt.email, password: opt.password }];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** Lê o SSE da conversa até final_message/error; devolve tempos e flags. */
async function readTurn(token, conversationId, t0) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), turnTimeoutMs);
  const out = { ttft: null, total: null, queued: false, error: null, text: '' };
  try {
    const res = await fetch(`${base}/conversations/${conversationId}/stream`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        if (!data) continue;
        let ev;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        if (ev.type === 'agent_status' && ev.data?.queued) out.queued = true;
        if (ev.type === 'token_chunk' && out.ttft === null) out.ttft = Date.now() - t0;
        if (ev.type === 'error') {
          out.error = ev.text || 'erro';
          out.total = Date.now() - t0;
          return out;
        }
        if (ev.type === 'final_message') {
          out.text = ev.text || '';
          out.total = Date.now() - t0;
          return out;
        }
      }
    }
    out.error = 'stream encerrou sem final_message';
  } catch (err) {
    out.error = ctrl.signal.aborted ? `timeout de ${opt.timeout}s` : err.message;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  out.total = Date.now() - t0;
  return out;
}

async function virtualUser(i, results) {
  await sleep((rampMs / Math.max(users, 1)) * i);
  const acc = accounts[i % accounts.length];
  let token;
  const tLogin = Date.now();
  try {
    token = (await api('/auth/login', { method: 'POST', body: acc })).token;
    results.logins.push(Date.now() - tLogin);
  } catch (err) {
    results.errors.push(`login u${i}: ${err.message}`);
    return;
  }
  let conversationId;
  try {
    conversationId = (
      await api('/conversations', {
        token,
        method: 'POST',
        body: { title: `[loadtest] usuário ${i}` },
      })
    ).id;
  } catch (err) {
    results.errors.push(`conversa u${i}: ${err.message}`);
    return;
  }
  for (let n = 0; n < turns; n++) {
    const t0 = Date.now();
    try {
      await api(`/conversations/${conversationId}/messages`, {
        token,
        method: 'POST',
        body: { content: opt.message },
      });
    } catch (err) {
      results.errors.push(`mensagem u${i}#${n}: ${err.message}`);
      continue;
    }
    const r = await readTurn(token, conversationId, t0);
    results.turns.push(r);
    if (r.error) results.errors.push(`turno u${i}#${n}: ${r.error}`);
  }
}

const pct = (arr, q) => {
  if (!arr.length) return '-';
  const s = [...arr].sort((a, b) => a - b);
  return `${(s[Math.min(s.length - 1, Math.floor(q * s.length))] / 1000).toFixed(1)}s`;
};

const results = { logins: [], turns: [], errors: [] };
const started = Date.now();
console.log(`${users} usuário(s) x ${turns} turno(s), subindo em ${opt.ramp}s, contra ${base}`);
await Promise.all(Array.from({ length: users }, (_, i) => virtualUser(i, results)));

const ok = results.turns.filter((t) => !t.error);
console.log(`\nduração: ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log(`logins: ${results.logins.length}/${users} | p50 ${pct(results.logins, 0.5)} p95 ${pct(results.logins, 0.95)}`);
console.log(`turnos ok: ${ok.length}/${users * turns} | passaram pela fila: ${results.turns.filter((t) => t.queued).length}`);
console.log(
  `1º token: p50 ${pct(ok.map((t) => t.ttft ?? t.total), 0.5)} p95 ${pct(ok.map((t) => t.ttft ?? t.total), 0.95)}`,
);
console.log(`resposta completa: p50 ${pct(ok.map((t) => t.total), 0.5)} p95 ${pct(ok.map((t) => t.total), 0.95)}`);
if (results.errors.length) {
  console.log(`\nerros (${results.errors.length}):`);
  const counts = new Map();
  for (const e of results.errors) {
    const key = e.replace(/u\d+(#\d+)?/, 'u*');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [e, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${n}x ${e}`);
}
process.exit(results.errors.length ? 1 : 0);
