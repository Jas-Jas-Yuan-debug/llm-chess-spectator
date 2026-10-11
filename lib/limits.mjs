export class DataLimitError extends Error {}

export const DEFAULT_GAME_LIMITS = Object.freeze({
  maxMoveBytes: 16 * 1024,
  maxGameBytes: 8 * 1024 * 1024,
  maxSavedBytes: 8 * 1024 * 1024,
  maxHistoryLength: 1000,
});

export function gameLimits(input = {}) {
  const limits = { ...DEFAULT_GAME_LIMITS };
  for (const key of Object.keys(limits)) {
    if (input[key] === undefined) continue;
    if (!Number.isSafeInteger(input[key]) || input[key] < 1 || input[key] > limits[key]) {
      throw new Error(`${key} must be a positive integer no greater than ${limits[key]}.`);
    }
    limits[key] = input[key];
  }
  return limits;
}

export function boundedJson(value, maxBytes, label) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > maxBytes) throw new DataLimitError(`${label} exceeds the ${maxBytes}-byte safety limit.`);
  return json;
}

const COUNTER_LIMIT = 1_000_000_000;
const ROOT_COUNTERS = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
const DETAIL_COUNTERS = {
  prompt_tokens_details: ['cached_tokens', 'audio_tokens'],
  completion_tokens_details: ['reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens'],
};

// Never retain arbitrary provider data in history or send it to the browser.
export function normalizeUsage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const output = {};
  const copy = (source, keys, target) => {
    for (const key of keys) {
      const value = Object.hasOwn(source, key) ? source[key] : undefined;
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= COUNTER_LIMIT) target[key] = value;
    }
  };
  copy(input, ROOT_COUNTERS, output);
  for (const [key, keys] of Object.entries(DETAIL_COUNTERS)) {
    const source = Object.hasOwn(input, key) ? input[key] : null;
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const details = {};
    copy(source, keys, details);
    if (Object.keys(details).length) output[key] = details;
  }
  return Object.keys(output).length ? output : null;
}
