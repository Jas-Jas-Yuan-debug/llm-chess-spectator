// Keep fetch and its dispatcher on the same protocol across supported Node versions.
import { fetch as undiciFetch, getGlobalDispatcher } from 'undici';
import { DataLimitError, normalizeUsage } from './limits.mjs';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8317/v1';
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class ProviderDisconnectError extends Error {}

function incompleteProviderStream(status, detail) {
  return status === 408 && typeof detail === 'string'
    && /stream disconnected before completion|stream closed before response\.completed/i.test(detail);
}

function socketDisconnected(error) {
  // Do not infer retryability from arbitrary provider-controlled error text.
  let disconnected = false;
  for (let depth = 0; error && depth < 5; depth += 1, error = error.cause) {
    if (error instanceof DataLimitError || error.name === 'AbortError') return false;
    if (error.code === 'ECONNRESET' || error.code === 'UND_ERR_SOCKET') disconnected = true;
  }
  return disconnected;
}

function contentEncodingCount(controller, headers) {
  const values = [];
  const add = value => {
    if (Array.isArray(value)) value.forEach(add);
    else if (value !== undefined) values.push(Buffer.isBuffer(value) ? value.toString('latin1') : String(value));
  };
  const raw = controller?.rawHeaders;
  if (Array.isArray(raw)) {
    for (let index = 0; index < raw.length; index += 2) {
      if (String(raw[index]).toLowerCase() === 'content-encoding') add(raw[index + 1]);
    }
  } else {
    for (const [name, value] of Object.entries(headers ?? {})) if (name.toLowerCase() === 'content-encoding') add(value);
  }
  // Count empty comma-separated entries too, just as Undici fetch does.
  const combined = values.join(',');
  return combined ? combined.split(',').length : 0;
}

export function createRequestDispatcher(timeoutMs, baseDispatcher = getGlobalDispatcher()) {
  return {
    dispatch(options, handler) {
      let guarded = handler;
      if (typeof handler.onResponseStart === 'function') {
        guarded = new Proxy(handler, {
          get(target, key) {
            if (key === 'onResponseStart') return (controller, status, headers, statusText) => {
              if (contentEncodingCount(controller, headers) > 5) {
                // Reject before fetch constructs its body stream: Undici's own
                // rejection here can otherwise destroy a stream without a listener.
                throw new DataLimitError('Model API response has too many Content-Encoding layers (maximum 5).');
              }
              return target.onResponseStart.call(target, controller, status, headers, statusText);
            };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }
      // Node fetch otherwise inherits a 300-second headers/body cutoff.
      return baseDispatcher.dispatch({ ...options, headersTimeout: timeoutMs, bodyTimeout: timeoutMs }, guarded);
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
  constructor({ baseUrl = DEFAULT_BASE_URL, apiKey = '', timeoutMs = 1_000_000, fetchImpl = undiciFetch, maxResponseBytes = MAX_RESPONSE_BYTES, modelsCacheTtlMs = 15_000, maxModelsConsumers = 64 } = {}) {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('OPENAI_BASE_URL must use http or https.');
    this.baseUrl = parsed.toString().replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES) throw new Error('maxResponseBytes must be from 1 to 1048576.');
    if (!Number.isSafeInteger(modelsCacheTtlMs) || modelsCacheTtlMs < 1 || modelsCacheTtlMs > 60_000) throw new Error('modelsCacheTtlMs must be from 1 to 60000.');
    if (!Number.isSafeInteger(maxModelsConsumers) || maxModelsConsumers < 1 || maxModelsConsumers > 64) throw new Error('maxModelsConsumers must be from 1 to 64.');
    this.maxResponseBytes = maxResponseBytes;
    this.modelsCacheTtlMs = modelsCacheTtlMs;
    this.maxModelsConsumers = maxModelsConsumers;
    this._modelsFlight = null;
    this._modelsCache = null;
  }

  async request(path, { body, signal, timeoutMs = this.timeoutMs } = {}) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    let receivedStatus;
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
        redirect: 'error',
      });
      receivedStatus = response.status;
      const reader = response.body?.getReader();
      const buffer = Buffer.alloc(this.maxResponseBytes);
      let bytes = 0;
      try {
        if (reader) {
          while (true) {
            const { done, value } = await withAbort(reader.read(), controller.signal);
            if (done) break;
            bytes += value.byteLength;
            if (bytes > this.maxResponseBytes) {
              controller.abort();
              throw new DataLimitError(`Model API decoded response exceeds the ${this.maxResponseBytes}-byte safety limit.`);
            }
            buffer.set(value, bytes - value.byteLength);
          }
        }
      } catch (error) {
        controller.abort();
        // Do not let a custom stream's cancellation hook hold the deadline open.
        reader?.cancel().catch(() => {});
        throw error;
      } finally { reader?.releaseLock(); }
      const raw = buffer.subarray(0, bytes).toString('utf8');
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error(`Model API returned non-JSON (HTTP ${response.status}).`); }
      if (!response.ok) {
        const detail = data?.error?.message ?? data?.error ?? response.statusText;
        const message = `Model API HTTP ${response.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
        if (incompleteProviderStream(response.status, detail)) throw new ProviderDisconnectError(message);
        throw new Error(message);
      }
      return data;
    } catch (error) {
      if (timedOut) throw new Error(`Model request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      if (signal?.aborted) throw abortError();
      const safeError = error?.cause instanceof DataLimitError ? error.cause : error;
      const message = publicError(safeError, this.apiKey);
      const socketRetryAllowed = receivedStatus === undefined || (receivedStatus >= 200 && receivedStatus < 300);
      if (error instanceof ProviderDisconnectError || (socketRetryAllowed && socketDisconnected(safeError))) throw new ProviderDisconnectError(message);
      throw new Error(message);
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
    return { text, usage: normalizeUsage(data.usage) };
  }

  listModels({ signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this._modelsCache?.expiresAt > Date.now()) return Promise.resolve(structuredClone(this._modelsCache.value));
    let flight = this._modelsFlight;
    if (!flight) {
      flight = { controller: new AbortController(), consumers: new Set(), promise: null };
      this._modelsFlight = flight;
      flight.promise = this.request('models', { timeoutMs: 12_000, signal: flight.controller.signal }).then(result => {
        if (!Array.isArray(result.data) || result.data.length > 512) throw new DataLimitError('Model catalog exceeds the 512-model safety limit or is malformed.');
        const models = [];
        for (const model of result.data) {
          if (typeof model?.id !== 'string') continue;
          if (model.id.length > 256) throw new DataLimitError('Model identifier exceeds the 256-character safety limit.');
          models.push(model.id);
        }
        return { models, baseUrl: this.baseUrl, connected: true };
      }).catch(error => ({ models: [], baseUrl: this.baseUrl, connected: false, error: publicError(error, this.apiKey) })).then(value => {
        flight.settled = true;
        this._modelsCache = { value, expiresAt: Date.now() + this.modelsCacheTtlMs };
        // One completion callback fans out to the bounded active set. Cancelled
        // callers are removed entirely instead of accumulating promise listeners.
        for (const consumer of [...flight.consumers]) {
          consumer.leave();
          consumer.resolve(structuredClone(value));
        }
        return value;
      }).finally(() => { if (this._modelsFlight === flight) this._modelsFlight = null; });
    }
    if (flight.consumers.size >= this.maxModelsConsumers) {
      return Promise.resolve({ models: [], baseUrl: this.baseUrl, connected: false, error: 'Too many concurrent model catalog consumers.' });
    }
    return new Promise((resolve, reject) => {
      const consumer = { resolve, leave: null };
      const leave = () => {
        signal?.removeEventListener('abort', onAbort);
        flight.consumers.delete(consumer);
        if (!flight.consumers.size && !flight.settled && this._modelsFlight === flight) flight.controller.abort();
      };
      const onAbort = () => { leave(); reject(abortError()); };
      consumer.leave = leave;
      flight.consumers.add(consumer);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
