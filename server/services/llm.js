/**
 * Local LLM triage client — Ollama + Qwen2.5
 * -------------------------------------------------------------------------
 * Calls a locally-served Ollama model's /api/chat endpoint with
 * `"format": "json"` so the reply is constrained to a single JSON object.
 * This is the concrete implementation of the "swap in a real LLM call"
 * note that used to sit at the bottom of triage.js. The caller
 * (`triage.js` -> `runTriage`) still validates every field against the
 * live DB taxonomy and falls back to the deterministic rule engine if this
 * throws, times out, or returns something invalid.
 *
 * No new npm dependency: Node's built-in `fetch` / `AbortController` do
 * the work.
 *
 *   OLLAMA_HOST        default http://localhost:11434
 *   OLLAMA_MODEL       default qwen2.5:7b-instruct
 *   OLLAMA_TIMEOUT_MS  default 20000  (per-triage-call abort — see note)
 *   OLLAMA_WARMUP_MS   default 35000  (startup warm-up only — see warmUp())
 *
 * Cloud fallback (optional): if the local call fails and FALLBACK_API_KEY is
 * set, the same prompt goes to an OpenAI-compatible API — see chat().
 *   FALLBACK_API_KEY, FALLBACK_API_URL (default https://api.openai.com/v1),
 *   FALLBACK_MODEL (default gpt-4o-mini), FALLBACK_TIMEOUT_MS (default 15000)
 *
 * NOTE on OLLAMA_TIMEOUT_MS: the startup warmUp() removes the cold model-load
 * spike (20-30s), but a *warm* qwen2.5:7b triage call — big system prompt +
 * JSON generation — still takes ~12-15s on modest hardware, so 8s was never
 * enough and every ticket silently fell back to rules. 20s covers a warm call
 * with headroom. This budget applies to the triage LLM call ONLY; no other
 * request reads it.
 */

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct';
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 20000;
const WARMUP_MS = Number(process.env.OLLAMA_WARMUP_MS) || 35000;

// Optional cloud fallback, used only when the local model fails. Any
// OpenAI-compatible endpoint works; leave FALLBACK_API_KEY empty to disable.
const FALLBACK_API_KEY = process.env.FALLBACK_API_KEY || '';
const FALLBACK_API_URL = process.env.FALLBACK_API_URL || 'https://api.openai.com/v1';
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || 'gpt-4o-mini';
const FALLBACK_TIMEOUT_MS = Number(process.env.FALLBACK_TIMEOUT_MS) || 15000;

const OUTPUT_SHAPE = `{
  "category": "<one of the allowed categories, copied verbatim>",
  "priority": "<one of the allowed priorities, copied verbatim>",
  "department": "<one of the allowed departments, copied verbatim>",
  "summary": "<one neutral sentence summarising the reported problem>",
  "reason": "<one or two sentences explaining why this category/priority/department>",
  "suggested_next_action": "<short concrete next step for the assigned team>",
  "confidence": <number between 0 and 1>,
  "physical_visit_required": <true or false>,
  "access_mode_recommendation": "<NONE | STUDENT_PRESENT_PREFERRED | ESCORT_REQUIRED>"
}`;

function buildSystemPrompt({ allowedCategories, allowedDepartments, allowedPriorities }) {
  return [
    'You are the auto-triage classifier for a university campus helpdesk.',
    'You receive one support ticket (as JSON) and classify it for routing.',
    '',
    'ALLOWED CATEGORIES (use one of these strings EXACTLY — never invent a new one):',
    allowedCategories.map((c) => `  - ${c}`).join('\n'),
    '',
    'ALLOWED DEPARTMENTS (use one of these strings EXACTLY):',
    allowedDepartments.map((d) => `  - ${d}`).join('\n'),
    '',
    `ALLOWED PRIORITIES (use one of these strings EXACTLY): ${allowedPriorities.join(', ')}`,
    '',
    'ROUTING RULES (apply in this order):',
    '',
    '1. SAFETY / SECURITY FIRST. Fire, gas leak, smoke, intruder, unauthorized access, tailgating,',
    '   theft, assault, harassment, or any immediate danger to people -> category "Security",',
    '   department "Campus Security". Use priority CRITICAL when people are in immediate danger,',
    '   otherwise HIGH. This overrides every other rule and ignores location_type.',
    '',
    '2. LOCATION-DEPENDENT issue types: electrical (lights, fans, sockets, wiring, power),',
    '   plumbing (leaks, taps, drainage, no water), AC / HVAC, furniture (bed, chair, desk,',
    '   cupboard), and housekeeping (cleaning). For these, the DEPARTMENT is decided ONLY by',
    '   "location_type", NOT by the words in the text:',
    '     - location_type EXACTLY "Hostel Room"  -> category is the matching "Hostel – ..." one',
    '       (Hostel – Electrical / Hostel – Plumbing / Hostel – Furniture / Hostel – AC / HVAC /',
    '       Hostel – Housekeeping), department "Warden / Hostel Administration".',
    '     - location_type is ANYTHING ELSE ("Academic / Admin Block", "Library",',
    '       "Transport / Campus Grounds", "Other")  -> category "Campus Facilities",',
    '       department "Gateway". Do NOT use any "Hostel – ..." category in this case.',
    '   Worked examples (identical text, different location_type):',
    '     {"description":"socket sparked and smells burnt","location_type":"Hostel Room"}',
    '        -> category "Hostel – Electrical", department "Warden / Hostel Administration"',
    '     {"description":"socket sparked and smells burnt","location_type":"Academic / Admin Block"}',
    '        -> category "Campus Facilities", department "Gateway"',
    '',
    '3. NOT location-dependent — classify the same way regardless of location_type:',
    '   Wi-Fi / Network, Account / Software, Classroom / AV, Transport, Library.',
    '',
    '4. If nothing above fits -> category "General", department "Gateway".',
    '',
    'OUTPUT:',
    'Respond with ONLY a single JSON object — no prose, no markdown fences — matching this shape exactly:',
    OUTPUT_SHAPE,
    '',
    'CONSTRAINTS:',
    '- category, department and priority MUST be copied verbatim from the allowed lists above.',
    '- Do NOT assert facts that are not present in the ticket text (no invented room numbers, causes, names, dates or history).',
    '- "confidence" is your own certainty, a number from 0 to 1.',
    '- Keep "summary" and "reason" neutral, factual and short.',
  ].join('\n');
}

function buildUserPrompt({ title, description, location, location_type }) {
  return JSON.stringify(
    {
      title: title || '',
      description: description || '',
      location: location || '',
      location_type: location_type || '',
    },
    null,
    2
  );
}

/**
 * POSTs one chat request. Ollama (/api/chat) and OpenAI-compatible
 * (/chat/completions) differ only in URL, auth, body and where the reply
 * text lives. Always throws on timeout / non-200 / empty reply.
 */
async function postChat({ name, url, headers, body, pick, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${name} timed out after ${timeoutMs}ms`);
    throw new Error(`${name} request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${name} got HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const content = pick(await res.json());
  if (!content) throw new Error(`${name} response had no message content.`);
  return content;
}

/**
 * Local-first chat with a cloud fallback. Tries Ollama; if that throws and
 * FALLBACK_API_KEY is set, retries the same prompt against any
 * OpenAI-compatible API (OpenAI, Groq, OpenRouter, Gemini's OpenAI endpoint…).
 * `json: true` constrains both providers to a single JSON object and parses it.
 * Returns { content, provider }. Throws only if every provider failed.
 */
async function chat({ system, user, json = false, timeoutMs = TIMEOUT_MS }) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const parse = (content, name) => {
    if (!json) return content;
    try {
      return JSON.parse(content);
    } catch (err) {
      throw new Error(`${name} returned non-JSON content: ${String(content).slice(0, 200)}`);
    }
  };

  let localErr;
  try {
    const content = await postChat({
      name: `Ollama (${OLLAMA_MODEL})`,
      url: `${OLLAMA_HOST}/api/chat`,
      body: { model: OLLAMA_MODEL, stream: false, ...(json && { format: 'json' }), options: { temperature: 0 }, messages },
      pick: (p) => p && p.message && p.message.content,
      timeoutMs,
    });
    return { content: parse(content, 'Ollama'), provider: 'local' };
  } catch (err) {
    localErr = err;
  }

  if (!FALLBACK_API_KEY) throw localErr;
  console.warn(`[llm] local model unusable (${localErr.message}) — trying cloud fallback ${FALLBACK_MODEL}.`);
  const content = await postChat({
    name: `Cloud fallback (${FALLBACK_MODEL})`,
    url: `${FALLBACK_API_URL.replace(/\/$/, '')}/chat/completions`,
    headers: { Authorization: `Bearer ${FALLBACK_API_KEY}` },
    body: { model: FALLBACK_MODEL, temperature: 0, ...(json && { response_format: { type: 'json_object' } }), messages },
    pick: (p) => p && p.choices && p.choices[0] && p.choices[0].message && p.choices[0].message.content,
    timeoutMs: FALLBACK_TIMEOUT_MS,
  });
  return { content: parse(content, 'Cloud fallback'), provider: 'cloud' };
}

/**
 * Classifies a ticket. Returns the parsed JSON object the model produced;
 * throws on any failure so runTriage() falls back to the rule engine.
 */
async function triageWithLLM({
  title,
  description,
  location,
  location_type,
  allowedCategories,
  allowedDepartments,
  allowedPriorities,
}) {
  const { content } = await chat({
    system: buildSystemPrompt({ allowedCategories, allowedDepartments, allowedPriorities }),
    user: buildUserPrompt({ title, description, location, location_type }),
    json: true,
  });
  return content;
}

const SELF_HELP_PROMPT = [
  'You are the first-line assistant of a university campus helpdesk.',
  'A student describes a problem BEFORE a ticket is filed. If there are simple, safe things',
  'a student can try themselves (e.g. Wi-Fi not working -> turn Wi-Fi off and on, forget and',
  're-join the network, restart the device), list them so the ticket may not be needed.',
  '',
  'Return an EMPTY list when the student cannot safely fix it themselves:',
  '- any safety / security issue (fire, smoke, gas, sparks, burning smell, exposed wires,',
  '  water near electrics, intruders, theft, harassment, injury) — these must reach staff now;',
  '- physical repairs (broken furniture, leaks, AC repair, electrical work);',
  '- anything needing staff access or permissions.',
  '',
  'Respond with ONLY this JSON object:',
  '{ "steps": ["<short imperative step>", ...] }',
  'At most 4 steps, each under 120 characters. Do not invent campus-specific facts',
  '(no made-up phone numbers, URLs, network names or office locations).',
].join('\n');

/**
 * Quick-fix suggestions shown before a ticket is filed. Returns
 * { steps: string[], provider } — steps is empty when self-help isn't
 * appropriate. Throws if no model is reachable (caller just skips the step).
 */
async function selfHelp({ title, description }) {
  const { content, provider } = await chat({
    system: SELF_HELP_PROMPT,
    user: JSON.stringify({ title: title || '', description: description || '' }),
    json: true,
  });
  const steps = Array.isArray(content && content.steps)
    ? content.steps.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 200)).slice(0, 4)
    : [];
  return { steps, provider };
}

/**
 * One-time startup warm-up. Sends a trivial 1-token prompt to the configured
 * model so Ollama loads it into memory before the first real ticket arrives —
 * a cold `ollama` load can take 20-30s, which would blow the per-request
 * TIMEOUT_MS budget and force a rules fallback on the first ticket after a
 * restart. Uses its own generous WARMUP_MS budget so it does NOT affect any
 * subsequent request's timeout. Never throws — returns a status object the
 * caller logs.
 */
async function warmUp() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WARMUP_MS);
  const started = Date.now();
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        options: { temperature: 0, num_predict: 1 },
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status} from Ollama${body ? `: ${body.slice(0, 160)}` : ''}` };
    }
    await res.json().catch(() => ({}));
    return { ok: true, ms: Date.now() - started, model: OLLAMA_MODEL };
  } catch (err) {
    return {
      ok: false,
      error: err.name === 'AbortError' ? `no response within ${WARMUP_MS}ms` : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chat, triageWithLLM, selfHelp, warmUp, OLLAMA_HOST, OLLAMA_MODEL };
