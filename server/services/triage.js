/**
 * Auto-Triage Engine — real campus routing chart
 * -------------------------------------------------------------------------
 * Section 11 asks for an AI pipeline that receives the ticket
 * title/description/location (plus `location_type`, see below), returns a
 * STRICT JSON object from an allowed taxonomy, and is then validated /
 * overridden by backend business rules (Section 12) before being trusted.
 *
 * Two implementations live here:
 *
 *  - `runTriage(...)` (async) — the REAL implementation. It calls a local
 *    LLM (Qwen2.5 via Ollama, see ./llm.js), then validates every field of
 *    the model's JSON against the live DB taxonomy exactly as the rule
 *    engine's output was validated. If the LLM call throws / times out, or
 *    the result fails validation, it logs a warning and falls back to the
 *    rule engine — a ticket must never fail to get triaged because the
 *    local model hiccupped. `process.env.TRIAGE_MODE=rules` skips the LLM
 *    entirely (offline demo / viva). The returned object carries an
 *    internal `_source: "llm" | "rules"` tag for the caller to log; the
 *    caller strips it before persisting the clean contract.
 *
 *  - `ruleBasedTriage(...)` (sync) — the deterministic, explainable
 *    keyword classifier, kept fully intact as the fallback. Runs offline
 *    with no model. Output shape matches Section 11.2 exactly.
 *
 * Location-dependent routing
 * --------------------------
 * "Electrical", "plumbing", "AC / HVAC", "furniture" and "housekeeping"
 * issues route to DIFFERENT departments depending on WHERE they happen — the
 * exact same "the AC is leaking" text is a Warden / Hostel Administration
 * job in a hostel room and a Gateway ("Campus Facilities") job in an
 * academic / admin block. Keyword matching decides the ISSUE TYPE; the
 * caller-supplied `location_type` decides which department that issue type
 * lands in. Wi-Fi / Network, Account / Software, Classroom / AV, Transport,
 * Security and Library are NOT location-dependent and route the same way
 * regardless of `location_type`.
 */

const db = require('../db/db');
const { triageWithLLM } = require('./llm');

// The 13 real categories (Section 12.2 routing chart). The Hostel – *
// categories are distinct from "Campus Facilities" even though the
// underlying issue type (electrical / plumbing / AC) overlaps.
const ALLOWED_CATEGORIES = new Set([
  'Wi-Fi / Network',
  'Account / Software',
  'Classroom / AV',
  'Hostel – Electrical',
  'Hostel – Plumbing',
  'Hostel – Furniture',
  'Hostel – AC / HVAC',
  'Hostel – Housekeeping',
  'Campus Facilities',
  'Transport',
  'General',
  'Security',
  'Library',
]);
const ALLOWED_PRIORITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

// The required "Location Type" dropdown on ticket creation. Only
// 'Hostel Room' pulls the ambiguous issue types towards the Warden;
// everything else is treated as campus infrastructure.
const ALLOWED_LOCATION_TYPES = [
  'Hostel Room',
  'Academic / Admin Block',
  'Library',
  'Transport / Campus Grounds',
  'Other',
];

function normalize(text) {
  return (text || '').toLowerCase();
}

// Section 12.1: safety / security ALWAYS wins and short-circuits, regardless
// of location_type.
const SAFETY_RULES = [
  {
    keywords: ['fire', 'gas leak', 'explosion', 'smoke alarm', 'unauthorized entry', 'intruder', 'weapon', 'assault'],
    priority: 'CRITICAL',
    reason: 'Detected mandatory safety/security escalation keywords.',
  },
  {
    keywords: ['hacked', 'suspicious login', 'account compromised', 'phishing', 'unauthorized access', 'suspicious activity', 'theft', 'stolen', 'trespass'],
    priority: 'HIGH',
    reason: 'Detected security / unauthorized-access keywords.',
  },
];

// Issue types that route the SAME way regardless of location_type. First
// keyword hit (array order) wins.
const FIXED_RULES = [
  {
    keywords: ['wifi', 'wi-fi', 'internet', 'lan', 'network', 'connectivity', 'no signal', 'router'],
    category: 'Wi-Fi / Network',
    department: 'Tech Support',
    priority: 'HIGH',
    visit: false,
    reason: 'Detected network / Wi-Fi keywords.',
  },
  {
    // before Account / Software so an explicit "library" beats a generic "login"
    keywords: ['library', 'book', 'reading room', 'e-resource', 'journal access', 'catalogue'],
    category: 'Library',
    department: 'Library Services',
    priority: 'LOW',
    visit: false,
    reason: 'Detected library service keywords.',
  },
  {
    keywords: ['login', 'log in', 'sign in', 'password', 'lms', 'account', 'software', 'install', 'app error', 'app not', 'application error'],
    category: 'Account / Software',
    department: 'Tech Support',
    priority: 'MEDIUM',
    visit: false,
    reason: 'Detected account / software keywords.',
  },
  {
    keywords: ['projector', 'microphone', 'speaker', 'display screen', 'smart board', 'smartboard', 'classroom equipment', 'podium', 'av system', 'hdmi'],
    category: 'Classroom / AV',
    department: 'AV Support',
    priority: 'MEDIUM',
    visit: true,
    reason: 'Detected classroom AV equipment keywords.',
  },
  {
    keywords: ['bus', 'shuttle', 'transport'],
    category: 'Transport',
    department: 'Gateway',
    priority: 'LOW',
    visit: false,
    reason: 'Detected campus transport keywords.',
  },
];

// Issue types whose DEPARTMENT depends on location_type. Keyword matching
// picks the issue type; `hostelCategory` is used (with the Warden) when
// location_type === 'Hostel Room', otherwise the issue is treated as campus
// infrastructure and routed to Gateway under "Campus Facilities".
const LOCATION_RULES = [
  {
    // checked before plumbing so "AC leakage" is HVAC, not plumbing.
    // Multi-word phrases ONLY — a bare "ac" / "ac " token collides with
    // words like zodiac, maniac, insomniac (all contain "ac "). "hvac" and
    // "ventilation" are kept as they don't appear inside other words.
    keywords: [
      'ac not cooling', 'ac not working', 'ac stopped', 'not cooling',
      'air conditioner', 'air conditioning',
      'ac leak', 'ac leaking', 'ac leakage', 'ac dripping', 'ac unit',
      'hvac', 'ventilation',
    ],
    hostelCategory: 'Hostel – AC / HVAC',
    priority: 'HIGH',
    visit: true,
    reason: 'Detected AC / HVAC keywords.',
  },
  {
    keywords: ['leak', 'leakage', 'tap', 'shower', 'no water', 'drainage', 'plumbing', 'pipe', 'water supply', 'flush', 'washbasin', 'clogged'],
    hostelCategory: 'Hostel – Plumbing',
    priority: 'HIGH',
    visit: true,
    reason: 'Detected plumbing / water keywords.',
  },
  {
    keywords: ['light', 'fan', 'socket', 'wiring', 'electrical', 'power cut', 'power outage', 'no power', 'no electricity', 'shock', 'short circuit', 'switchboard', 'plug point'],
    hostelCategory: 'Hostel – Electrical',
    priority: 'HIGH',
    visit: true,
    reason: 'Detected electrical keywords.',
  },
  {
    keywords: ['bed', 'chair', 'table', 'cupboard', 'furniture', 'desk', 'wardrobe', 'mattress'],
    hostelCategory: 'Hostel – Furniture',
    priority: 'LOW',
    visit: true,
    reason: 'Detected furniture keywords.',
  },
  {
    keywords: ['cleaning', 'housekeeping', 'not cleaned', 'dirty', 'common area', 'pest', 'garbage', 'trash', 'sweep', 'mop', 'cobweb'],
    hostelCategory: 'Hostel – Housekeeping',
    priority: 'MEDIUM',
    visit: true,
    reason: 'Detected housekeeping / cleaning keywords.',
  },
];

// location_type decides which of the two departments a location-dependent
// issue type lands in (design note at top of file).
function resolveLocationRule(rule, locationType) {
  if (locationType === 'Hostel Room') {
    return {
      category: rule.hostelCategory,
      department: 'Warden / Hostel Administration',
      priority: rule.priority,
      visit: rule.visit,
      reason: `${rule.reason} Location Type "Hostel Room" → Warden / Hostel Administration.`,
    };
  }
  return {
    category: 'Campus Facilities',
    department: 'Gateway',
    priority: rule.priority,
    visit: rule.visit,
    reason: `${rule.reason} Location Type "${locationType || 'unspecified'}" → Campus Facilities (Gateway).`,
  };
}

/**
 * Deterministic keyword classifier — the fallback path for `runTriage`, and
 * usable directly when TRIAGE_MODE=rules. Returns the Section 11.2 output
 * shape. `location_type` must be one of ALLOWED_LOCATION_TYPES (the deciding
 * factor between Hostel – * and Campus Facilities for electrical/plumbing/
 * AC-type complaints); anything else is treated as unspecified
 * (→ Campus Facilities).
 */
function ruleBasedTriage({ title, description, location, location_type }) {
  const haystack = normalize(`${title} ${description} ${location}`);
  const locationType = ALLOWED_LOCATION_TYPES.includes(location_type) ? location_type : null;

  let category;
  let department;
  let priority;
  let visit;
  let reason;
  let matchedKeyword = null;

  // 1. safety / security first — short-circuits, ignores location_type
  for (const rule of SAFETY_RULES) {
    const hit = rule.keywords.find((k) => haystack.includes(k));
    if (hit) {
      category = 'Security';
      department = 'Campus Security';
      priority = rule.priority;
      visit = rule.priority === 'CRITICAL';
      reason = rule.reason;
      matchedKeyword = hit;
      break;
    }
  }

  // 2. non-location-dependent issue types
  if (!category) {
    for (const rule of FIXED_RULES) {
      const hit = rule.keywords.find((k) => haystack.includes(k));
      if (hit) {
        ({ category, department, priority, visit, reason } = rule);
        matchedKeyword = hit;
        break;
      }
    }
  }

  // 3. location-dependent issue types: keyword picks the issue type,
  //    location_type picks the department (Section 12.2 note)
  if (!category) {
    for (const rule of LOCATION_RULES) {
      const hit = rule.keywords.find((k) => haystack.includes(k));
      if (hit) {
        ({ category, department, priority, visit, reason } = resolveLocationRule(rule, locationType));
        matchedKeyword = hit;
        break;
      }
    }
  }

  // 4. default fallback
  if (!category) {
    return {
      category: 'General',
      priority: 'LOW',
      department: 'Gateway',
      summary: (title || '').slice(0, 120),
      reason: 'No specific keyword pattern matched; routed to the Gateway general queue for manual review.',
      suggested_next_action: 'Gateway staff to review and manually classify.',
      confidence: 0.35,
      physical_visit_required: false,
      access_mode_recommendation: 'NONE',
    };
  }

  // Business-rule bound: category/department must exist in the DB's
  // configured taxonomy (Section 11.5 / 12.4), never trusted blindly even
  // though this engine is deterministic.
  const dept = db.prepare('SELECT id, name FROM departments WHERE name = ?').get(department);
  const cat = db.prepare('SELECT id, name FROM categories WHERE name = ?').get(category);

  const confidence = priority === 'CRITICAL' ? 0.97 : 0.85 + Math.random() * 0.1;

  return {
    category: cat ? cat.name : 'General',
    priority: ALLOWED_PRIORITIES.has(priority) ? priority : 'MEDIUM',
    department: dept ? dept.name : 'Gateway',
    summary: `${category} issue: ${(title || '').slice(0, 100)}`,
    reason: `${reason} (matched: "${matchedKeyword}")`,
    suggested_next_action: visit
      ? 'Assign to department queue; propose a physical visit slot with the student.'
      : 'Assign to department queue for remote resolution.',
    confidence: Number(confidence.toFixed(2)),
    physical_visit_required: !!visit,
    access_mode_recommendation: visit ? 'STUDENT_PRESENT_PREFERRED' : 'NONE',
  };
}

// --------------------------------------------------------------------------
// Real implementation: local LLM first, rule engine as fallback.
// --------------------------------------------------------------------------

const ACCESS_MODES = ['NONE', 'STUDENT_PRESENT_PREFERRED', 'ESCORT_REQUIRED'];
const HOSTEL_CATEGORIES = new Set([
  'Hostel – Electrical',
  'Hostel – Plumbing',
  'Hostel – Furniture',
  'Hostel – AC / HVAC',
  'Hostel – Housekeeping',
]);

// Detect the ambiguous infra issue type (electrical / plumbing / AC-HVAC /
// furniture / housekeeping) from the ticket text, using the SAME keyword
// lists and precedence as the rule engine (LOCATION_RULES order: AC before
// plumbing, etc.). Returns the matching 'Hostel – *' category, or null if no
// infra keyword is present.
function detectHostelIssueCategory(text) {
  const haystack = normalize(text);
  for (const rule of LOCATION_RULES) {
    if (rule.keywords.some((k) => haystack.includes(k))) return rule.hostelCategory;
  }
  return null;
}

// Section 12.2 business-rule override — BIDIRECTIONAL. The hostel-vs-campus
// split for the ambiguous infra issue types is a pure function of
// location_type, so enforce it deterministically both ways when the LLM gets
// the direction wrong:
//   (a) 'Hostel – *' category + location_type is NOT a hostel room
//         -> Campus Facilities / Gateway
//   (b) 'Campus Facilities' category + location_type IS 'Hostel Room'
//         -> the matching 'Hostel – *' category / Warden, picked from the
//            detected issue type. If no infra keyword is present we can't
//            pick a Hostel – * category, so it's left for the caller to send
//            to the rule-engine fallback.
function correctLocationRouting(t, locationType, text) {
  // (a) hostel category, non-hostel location
  if (locationType !== 'Hostel Room' && HOSTEL_CATEGORIES.has(t.category)) {
    return {
      ...t,
      category: 'Campus Facilities',
      department: 'Gateway',
      reason: `${t.reason} [backend override: location_type "${locationType || 'unspecified'}" is not a hostel room → Campus Facilities / Gateway]`,
    };
  }
  // (b) campus-infra category, hostel room
  if (locationType === 'Hostel Room' && t.category === 'Campus Facilities') {
    const hostelCategory = detectHostelIssueCategory(text);
    if (hostelCategory) {
      return {
        ...t,
        category: hostelCategory,
        department: 'Warden / Hostel Administration',
        reason: `${t.reason} [backend override: location_type "Hostel Room" → ${hostelCategory} / Warden / Hostel Administration]`,
      };
    }
  }
  return t;
}

// The exact category/department strings currently seeded — pulled live so
// the LLM prompt and the validator always match whatever the DB holds.
function dbTaxonomy() {
  return {
    categories: db.prepare('SELECT name FROM categories WHERE active = 1 ORDER BY id').all().map((r) => r.name),
    departments: db.prepare('SELECT name FROM departments WHERE active = 1 ORDER BY id').all().map((r) => r.name),
    priorities: [...ALLOWED_PRIORITIES],
  };
}

/**
 * Validates a raw LLM triage object against the DB taxonomy exactly like
 * the rule-engine output was validated: category + department must exist in
 * the DB, priority must be one of the 4 allowed values, confidence must be
 * a number in 0..1, physical_visit_required must be a real boolean. Returns
 * a cleaned Section 11.2 object, or throws with the reason it can't be
 * trusted (so the caller falls back to the rule engine).
 */
function validateLLMTriage(out, taxonomy) {
  if (!out || typeof out !== 'object') throw new Error('LLM output was not an object');

  const category = String(out.category || '').trim();
  const department = String(out.department || '').trim();
  const priority = String(out.priority || '').trim().toUpperCase();

  if (!taxonomy.categories.includes(category)) throw new Error(`category "${category}" not in DB taxonomy`);
  if (!taxonomy.departments.includes(department)) throw new Error(`department "${department}" not in DB taxonomy`);
  if (!ALLOWED_PRIORITIES.has(priority)) throw new Error(`priority "${out.priority}" not one of ${[...ALLOWED_PRIORITIES].join('/')}`);

  const confidence = Number(out.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`confidence "${out.confidence}" is not a number in 0..1`);
  }
  if (typeof out.physical_visit_required !== 'boolean') {
    throw new Error('physical_visit_required is not a boolean');
  }

  return {
    category,
    priority,
    department,
    summary: String(out.summary || '').trim().slice(0, 400) || `${category} issue`,
    reason: String(out.reason || '').trim().slice(0, 800) || 'Classified by local LLM (Qwen2.5 via Ollama).',
    suggested_next_action:
      String(out.suggested_next_action || '').trim().slice(0, 400) || 'Assign to department queue.',
    confidence: Number(confidence.toFixed(2)),
    physical_visit_required: out.physical_visit_required,
    access_mode_recommendation: ACCESS_MODES.includes(out.access_mode_recommendation)
      ? out.access_mode_recommendation
      : out.physical_visit_required
      ? 'STUDENT_PRESENT_PREFERRED'
      : 'NONE',
  };
}

/**
 * Real auto-triage entrypoint (async — does a local network call).
 *
 * TRIAGE_MODE=rules  -> skip the LLM, use `ruleBasedTriage` directly.
 * otherwise (default "llm") -> call the local model, validate its JSON
 * against the DB taxonomy, and fall back to `ruleBasedTriage` on any
 * throw / timeout / validation failure.
 *
 * The returned object has an extra internal `_source` field ("llm" |
 * "rules") for the caller to record in ticket_history; the caller strips
 * it before persisting / returning the clean contract.
 */
async function runTriage({ title, description, location, location_type }) {
  const mode = (process.env.TRIAGE_MODE || 'llm').toLowerCase();
  const input = { title, description, location, location_type };

  if (mode === 'rules') {
    return { ...ruleBasedTriage(input), _source: 'rules' };
  }

  try {
    const taxonomy = dbTaxonomy();
    const raw = await triageWithLLM({
      ...input,
      allowedCategories: taxonomy.categories,
      allowedDepartments: taxonomy.departments,
      allowedPriorities: taxonomy.priorities,
    });
    const text = `${title || ''} ${description || ''} ${location || ''}`;
    const clean = correctLocationRouting(validateLLMTriage(raw, taxonomy), location_type, text);
    // Direction (b) safety net: if the model returned Campus Facilities for a
    // Hostel Room ticket AND the override couldn't pick a Hostel – * category
    // (no infra keyword in the text), defer to the rule engine.
    if (location_type === 'Hostel Room' && clean.category === 'Campus Facilities') {
      throw new Error('LLM returned Campus Facilities for a Hostel Room ticket and no infra keyword to remap on');
    }
    return { ...clean, _source: 'llm' };
  } catch (err) {
    console.warn(`[triage] LLM path unusable (${err.message}) — falling back to rule engine.`);
    return { ...ruleBasedTriage(input), _source: 'rules' };
  }
}

module.exports = {
  runTriage,
  ruleBasedTriage,
  ALLOWED_CATEGORIES,
  ALLOWED_PRIORITIES,
  ALLOWED_LOCATION_TYPES,
  // exported for the live-LLM regression test (server/test-triage-llm.js)
  correctLocationRouting,
  validateLLMTriage,
  detectHostelIssueCategory,
  dbTaxonomy,
};

// Self-check: `node server/services/triage.js`. Covers the two bits of
// non-trivial LLM-path logic (validation + the location_type override)
// without needing Ollama.
if (require.main === module) {
  const assert = require('assert');
  const tax = {
    categories: [...ALLOWED_CATEGORIES],
    departments: ['Tech Support', 'AV Support', 'Warden / Hostel Administration', 'Gateway', 'Campus Security', 'Library Services'],
    priorities: [...ALLOWED_PRIORITIES],
  };
  const good = {
    category: 'Wi-Fi / Network', department: 'Tech Support', priority: 'high',
    summary: 's', reason: 'r', suggested_next_action: 'a', confidence: 0.8,
    physical_visit_required: false, access_mode_recommendation: 'NONE',
  };
  assert.strictEqual(validateLLMTriage(good, tax).priority, 'HIGH', 'priority upper-cased');
  assert.throws(() => validateLLMTriage({ ...good, category: 'Made Up' }, tax), /not in DB taxonomy/);
  assert.throws(() => validateLLMTriage({ ...good, confidence: 5 }, tax), /0\.\.1/);
  assert.throws(() => validateLLMTriage({ ...good, physical_visit_required: 'yes' }, tax), /boolean/);

  // direction (a): Hostel – * category + non-hostel location_type → Campus Facilities / Gateway
  const hostelPick = { ...good, category: 'Hostel – Electrical', department: 'Warden / Hostel Administration' };
  assert.strictEqual(correctLocationRouting(hostelPick, 'Academic / Admin Block', 'socket sparked').category, 'Campus Facilities', '(a) non-hostel → Campus Facilities');
  assert.strictEqual(correctLocationRouting(hostelPick, 'Academic / Admin Block', 'socket sparked').department, 'Gateway');
  assert.strictEqual(correctLocationRouting(hostelPick, 'Hostel Room', 'socket sparked').category, 'Hostel – Electrical', '(a) hostel room left alone');
  assert.strictEqual(correctLocationRouting(good, 'Other', 'wifi down').category, 'Wi-Fi / Network', 'non-infra untouched');

  // direction (b): Campus Facilities category + location_type "Hostel Room" → matching Hostel – *
  const campusPick = { ...good, category: 'Campus Facilities', department: 'Gateway' };
  const bAc = correctLocationRouting(campusPick, 'Hostel Room', 'AC leaking water in my room');
  assert.strictEqual(bAc.category, 'Hostel – AC / HVAC', '(b) hostel room + AC issue → Hostel – AC / HVAC');
  assert.strictEqual(bAc.department, 'Warden / Hostel Administration', '(b) → Warden');
  assert.strictEqual(
    correctLocationRouting(campusPick, 'Hostel Room', 'water leaking from the bathroom tap').category,
    'Hostel – Plumbing', '(b) hostel room + plumbing issue → Hostel – Plumbing'
  );
  assert.strictEqual(
    correctLocationRouting(campusPick, 'Hostel Room', 'the tube light and ceiling fan stopped working').category,
    'Hostel – Electrical', '(b) hostel room + electrical issue → Hostel – Electrical'
  );
  assert.strictEqual(
    correctLocationRouting(campusPick, 'Hostel Room', 'broken bed frame and cupboard door').category,
    'Hostel – Furniture', '(b) hostel room + furniture issue → Hostel – Furniture'
  );
  // symmetry: SAME text, the two location_types resolve to the two departments
  assert.strictEqual(correctLocationRouting(campusPick, 'Hostel Room', 'AC leaking water').department, 'Warden / Hostel Administration', '(b) AC + Hostel Room → Warden');
  assert.strictEqual(correctLocationRouting({ ...good, category: 'Hostel – AC / HVAC', department: 'Warden / Hostel Administration' }, 'Academic / Admin Block', 'AC leaking water').department, 'Gateway', '(a) AC + Academic block → Gateway');
  // no infra keyword: (b) can't remap, leaves Campus Facilities for the caller's fallback
  assert.strictEqual(correctLocationRouting(campusPick, 'Hostel Room', 'the corridor noticeboard is missing').category, 'Campus Facilities', '(b) no infra keyword → left as Campus Facilities');

  // --- rule-engine haystack / keyword-collision regressions ---

  // The keyword haystack is title + description + free-text location ONLY.
  // location_type is never scanned, so an "Academic / Admin Block" ticket
  // with zero infra keywords must fall through to General → Gateway, not be
  // dragged to Campus Facilities.
  const benign = ruleBasedTriage({
    title: 'Question about the academic calendar',
    description: 'Where do I find the academic calendar for next semester? Thanks.',
    location: 'Academic / Admin Block, 2nd floor',
    location_type: 'Academic / Admin Block',
  });
  assert.strictEqual(benign.category, 'General', 'benign academic-block ticket → General');
  assert.strictEqual(benign.department, 'Gateway', 'benign academic-block ticket → Gateway');

  // "zodiac" / "insomniac" / "academic" all contain the substring "ac " —
  // they must NOT trip the AC/HVAC rule now that bare "ac " is gone.
  const acCollision = ruleBasedTriage({
    title: 'Zodiac drama club room request',
    description: 'The zodiac drama club and the insomniac writers group need a room for weekly meetings.',
    location: 'academic block',
    location_type: 'Academic / Admin Block',
  });
  assert.notStrictEqual(acCollision.category, 'Campus Facilities', "'ac ' substring must not trigger HVAC routing");
  assert.notStrictEqual(acCollision.category, 'Hostel – AC / HVAC', "'ac ' substring must not trigger HVAC routing");

  // AC keyword list contains no bare "ac" token and is multi-word only
  // (bar the unambiguous "hvac" / "ventilation").
  const acRule = LOCATION_RULES.find((r) => r.hostelCategory === 'Hostel – AC / HVAC');
  assert.ok(!acRule.keywords.some((k) => k === 'ac' || k === 'ac ' || k === 'a/c'), "no bare 'ac' / 'a/c' token");
  assert.ok(
    acRule.keywords.every((k) => k.includes(' ') || k === 'hvac' || k === 'ventilation'),
    'AC keywords are multi-word phrases (except hvac / ventilation)'
  );

  console.log('triage.js self-check passed');
}
