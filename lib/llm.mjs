// Keep fetch and its dispatcher on the same protocol across supported Node versions.
import { fetch as undiciFetch, getGlobalDispatcher } from 'undici';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8317/v1';

export function createRequestDispatcher(timeoutMs, baseDispatcher = getGlobalDispatcher()) {
  return {
    dispatch(options, handler) {
      // Node fetch otherwise inherits a 300-second headers/body cutoff.
      return baseDispatcher.dispatch({ ...options, headersTimeout: timeoutMs, bodyTimeout: timeoutMs }, handler);
    },
  };
}

function abortError() {
  return new DOMException('The request was cancelled.', 'AbortError');
}

export function withAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => finish(reject, abortError());
    const finish = (settle, value) => {
      signal.removeEventListener('abort', onAbort);
      settle(value);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => typeof part === 'string' ? part : (part?.text ?? part?.content ?? '')).join('\n');
  }
  return '';
}

export function publicError(error, apiKey = '') {
  let message = error instanceof Error ? error.message : String(error);
  if (apiKey) message = message.split(apiKey).join('[redacted]');
  return message.slice(0, 700);
}

export class OpenAIClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, apiKey = '', timeoutMs = 1_000_000, fetchImpl = undiciFetch } = {}) {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('OPENAI_BASE_URL must use http or https.');
    this.baseUrl = parsed.toString().replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async request(path, { body, signal, timeoutMs = this.timeoutMs } = {}) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}/${path}`, {
        dispatcher: createRequestDispatcher(timeoutMs),
        method: body ? 'POST' : 'GET',
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error(`Model API returned non-JSON (HTTP ${response.status}).`); }
      if (!response.ok) {
        const detail = data?.error?.message ?? data?.error ?? response.statusText;
        throw new Error(`Model API HTTP ${response.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
      }
      return data;
    } catch (error) {
      if (timedOut) throw new Error(`Model request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      if (signal?.aborted) throw abortError();
      throw new Error(publicError(error, this.apiKey));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  async move({ fen, pgn, board, legalMoves, color, model, effort, feedback, signal }) {
    const prompt = [
      `You are playing ${color === 'w' ? 'White' : 'Black'}. Choose exactly one legal move from the numbered list.`,
      `FEN: ${fen}`,
      `Game PGN: ${pgn || '(no moves yet)'}`,
      `Board:\n${board}`,
      `Legal moves in UCI format:\n${legalMoves.map((move, index) => `${index + 1}. ${move}`).join('\n')}`,
      feedback ? `Your last response was rejected: ${feedback}. Choose a move exactly from the legal list.` : '',
      'Return only JSON with this structure: {"move":"<one listed legal UCI move>","comment":"<brief spectator commentary>","explanation":{"idea":"<main chess idea>","threats":"<immediate threats or risks>","alternatives":[{"move":"<a different listed legal UCI move>","whyNot":"<brief high-level comparison>"}],"plan":"<short plan after this move>"}}',
      'The explanation is a concise public chess decision summary for spectators. Use one or two sentences per section, at most 400 characters for idea, threats, and plan, and at most two alternatives with comparisons of at most 300 characters each. Alternatives must be different legal moves from the same list; use an empty array if no comparison is useful.',
      'Use a promotion suffix when listed, such as e7e8q. Do not provide private reasoning or a chain of thought, internal deliberations, or detailed calculation lines. Give only high-level chess rationale suitable for sharing publicly.',
    ].filter(Boolean).join('\n\n');
    const data = await this.request('chat/completions', {
      signal,
      body: {
        model,
        reasoning_effort: effort,
        max_completion_tokens: 4096,
        messages: [
          { role: 'system', content: 'You are a chess player. Follow chess rules and return the requested JSON object with one legal move, a short public comment, and a concise public chess decision summary. Never include private reasoning or a chain of thought.' },
          { role: 'user', content: prompt },
        ],
      },
    });
    const message = data?.choices?.[0]?.message;
    let text = contentText(message?.content);
    if (!text && message?.tool_calls?.[0]?.function?.arguments) text = message.tool_calls[0].function.arguments;
    if (!text) throw new Error('Model API returned no move content.');
    return { text, usage: data.usage ?? null };
  }

  async listModels() {
    try {
      const result = await this.request('models', { timeoutMs: 12_000 });
      return { models: (result.data ?? []).map(model => model.id).filter(id => typeof id === 'string'), baseUrl: this.baseUrl, connected: true };
    } catch (error) {
      return { models: [], baseUrl: this.baseUrl, connected: false, error: publicError(error, this.apiKey) };
    }
  }
}
