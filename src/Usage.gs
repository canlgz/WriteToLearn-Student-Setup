/**
 * Gemini API usage tracking.
 * Stored in ScriptProperties (cheap, atomic with LockService).
 * Pricing applied retroactively via getUsageStats_; tokens never re-counted.
 *
 * Properties keyed like:
 *   usage:2026-05:gen_prompt    (cumulative input tokens for the month)
 *   usage:2026-05:gen_output    (cumulative output tokens)
 *   usage:2026-05:gen_calls
 *   usage:2026-05:embed_prompt  (approx tokens from input char count)
 *   usage:2026-05:embed_calls
 *   usage:2026-05-17:calls      (daily total for RPD tracking)
 */

// USD per 1,000,000 tokens. Approximate — text-equivalent pricing is used for
// multimodal too; audio in particular is more expensive on Google's actual
// bill, so this is a lower bound. Update when Google adjusts rates.
const GEMINI_PRICING = {
  'gemini-3.5-flash':       { inputPerM: 1.50,  outputPerM: 9.00 },
  'gemini-2.5-flash':       { inputPerM: 0.075, outputPerM: 0.30 },
  'gemini-embedding-001':   { inputPerM: 0,     outputPerM: 0     }
};

// Free tier limits (AI Studio key, shared across all callers of the key).
const FREE_TIER_RPD = 1500;
const FREE_TIER_RPM = 15;

function currentMonthKey_() {
  return Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM');
}

function currentDayKey_() {
  return Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
}

function recordGenerateUsage_(usageMetadata) {
  if (!usageMetadata) return;
  bumpProps_({
    [`usage:${currentMonthKey_()}:gen_prompt`]: usageMetadata.promptTokenCount || 0,
    [`usage:${currentMonthKey_()}:gen_output`]: usageMetadata.candidatesTokenCount || 0,
    [`usage:${currentMonthKey_()}:gen_calls`]:  1,
    [`usage:${currentDayKey_()}:calls`]:        1
  });
}

function recordEmbedUsage_(inputCharCount) {
  // Embedding API doesn't return token count; approximate by input char count.
  // Chinese chars roughly 1 char ≈ 1 token, ASCII ~4 chars/token. Char count
  // is therefore an upper bound, fine for free-tier tracking.
  bumpProps_({
    [`usage:${currentMonthKey_()}:embed_prompt`]: inputCharCount,
    [`usage:${currentMonthKey_()}:embed_calls`]:  1,
    [`usage:${currentDayKey_()}:calls`]:          1
  });
}

function bumpProps_(deltas) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;  // best effort — don't block ingest on contention
  try {
    const props = PropertiesService.getScriptProperties();
    for (const key in deltas) {
      const cur = parseInt(props.getProperty(key) || '0', 10);
      props.setProperty(key, String(cur + deltas[key]));
    }
  } finally {
    lock.releaseLock();
  }
}

function getUsageStats_() {
  const month = currentMonthKey_();
  const day = currentDayKey_();
  const props = PropertiesService.getScriptProperties();
  const get = (k) => parseInt(props.getProperty(k) || '0', 10);
  const monthGenPrompt = get(`usage:${month}:gen_prompt`);
  const monthGenOutput = get(`usage:${month}:gen_output`);
  const monthEmbedPrompt = get(`usage:${month}:embed_prompt`);
  const gen = GEMINI_PRICING[MODELS.GENERATION] || { inputPerM: 0, outputPerM: 0 };
  const emb = GEMINI_PRICING[MODELS.EMBEDDING]   || { inputPerM: 0, outputPerM: 0 };
  const costUsd =
    (monthGenPrompt   * gen.inputPerM +
     monthGenOutput   * gen.outputPerM +
     monthEmbedPrompt * emb.inputPerM) / 1e6;
  return {
    month, day,
    todayCalls:      get(`usage:${day}:calls`),
    monthGenCalls:   get(`usage:${month}:gen_calls`),
    monthGenPrompt,
    monthGenOutput,
    monthEmbedCalls: get(`usage:${month}:embed_calls`),
    monthEmbedPrompt,
    costUsd
  };
}

/** Translate a Gemini error code into a user-friendly Chinese message. */
function geminiErrorMessage_(code, body) {
  if (code === 429) {
    return [
      '⚠️ Gemini 額度已用完',
      `免費 tier：${FREE_TIER_RPM} 次/分、${FREE_TIER_RPD} 次/日`,
      '請稍候再試（每日太平洋時區 0:00 重置）。'
    ].join('\n');
  }
  if (code === 403) {
    return '⚠️ Gemini API 權限不足或 key 失效：\n' + (body || '').slice(0, 300);
  }
  return null;  // no friendly translation; caller falls back to raw error
}

/** Wipe every "usage:*" ScriptProperty. Returns the number of keys removed. */
function resetUsage_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  let removed = 0;
  for (const key in all) {
    if (key.indexOf('usage:') === 0) {
      props.deleteProperty(key);
      removed++;
    }
  }
  return removed;
}
