/**
 * Live-LLM regression test for the BIDIRECTIONAL location_type override in
 * services/triage.js (Section 12.2).
 *
 *   cd server && OLLAMA_TIMEOUT_MS=30000 node test-triage-llm.js [runsPerCase]
 *   (default runsPerCase = 8)
 *
 * Needs Ollama up with OLLAMA_MODEL pulled. Forces TRIAGE_MODE=llm so the
 * real model path runs, not the deterministic fallback.
 *
 * ONE issue text, only location_type differs:
 *   "water leaking from the bathroom tap ..."
 *     + location_type "Hostel Room"            -> Hostel – Plumbing / Warden / Hostel Administration
 *     + location_type "Academic / Admin Block" -> Campus Facilities / Gateway
 *
 * Observed with qwen2.5:7b-instruct (temperature 0):
 *   - direction (a): the model reliably makes this mistake — it keeps the
 *     "Hostel – Plumbing" category / Warden for the "Academic / Admin Block"
 *     ticket. The override must flip it to Campus Facilities / Gateway. This
 *     is the "catch it consistently across repeated runs" case.
 *   - direction (b): the model did NOT make the reverse mistake ("Campus
 *     Facilities" for a "Hostel Room" ticket) in any run. So (b) is
 *     exercised by taking each run's REAL raw model output, flipping its
 *     category to "Campus Facilities", and asserting correctLocationRouting()
 *     remaps it back to Hostel – Plumbing / Warden.
 *
 * Every end-to-end run in both directions must resolve correctly.
 */
process.env.TRIAGE_MODE = 'llm';

const assert = require('assert');
const { triageWithLLM } = require('./services/llm');
const { runTriage, validateLLMTriage, correctLocationRouting, dbTaxonomy } = require('./services/triage');

const RUNS = Number(process.argv[2]) || 8;

const ISSUE = {
  title: 'Water leaking from the bathroom tap',
  description: 'Water keeps leaking from the bathroom tap and pooling on the floor. It has been dripping non-stop since last night.',
  location: 'second floor washroom',
};
const TEXT = `${ISSUE.title} ${ISSUE.description} ${ISSUE.location}`;

const EXPECT = {
  'Hostel Room':            { category: 'Hostel – Plumbing',  department: 'Warden / Hostel Administration' },
  'Academic / Admin Block': { category: 'Campus Facilities',  department: 'Gateway' },
};

let failed = 0;

const rawDirectionOk = (lt, cat) =>
  lt === 'Hostel Room' ? !['Campus Facilities', 'General'].includes(cat) : !String(cat).startsWith('Hostel');

(async () => {
  const tax = dbTaxonomy();
  console.log(`TRIAGE_MODE=${process.env.TRIAGE_MODE}  OLLAMA_TIMEOUT_MS=${process.env.OLLAMA_TIMEOUT_MS || 8000}  ${RUNS} runs/direction`);
  console.log(`issue text (identical for both directions): "${ISSUE.title}"\n`);

  for (const lt of Object.keys(EXPECT)) {
    const exp = EXPECT[lt];
    const dir = lt === 'Hostel Room' ? '(control + injected b)' : '(a) — model-mistake case';
    console.log(`── location_type "${lt}"  ${dir}  → expect ${exp.category} / ${exp.department}`);
    const input = { ...ISSUE, location_type: lt };
    let e2ePass = 0, fallback = 0, rawRight = 0, rawWrong = 0, overrideFixed = 0, injPass = 0;

    for (let i = 1; i <= RUNS; i++) {
      let e2e;
      try { e2e = await runTriage(input); }
      catch (err) { console.log(`  run ${i}: runTriage threw: ${err.message}`); failed++; continue; }
      const e2eOk = e2e.category === exp.category && e2e.department === exp.department;
      e2eOk ? e2ePass++ : failed++;
      if (e2e._source === 'rules') fallback++;

      let note = '';
      try {
        const raw = await triageWithLLM({ ...input, allowedCategories: tax.categories, allowedDepartments: tax.departments, allowedPriorities: tax.priorities });
        const v = validateLLMTriage(raw, tax);
        const corrected = correctLocationRouting(v, lt, TEXT);
        if (rawDirectionOk(lt, v.category)) { rawRight++; note = `raw direction OK (${v.category} / ${v.department})`; }
        else {
          rawWrong++;
          const ok = corrected.category === exp.category && corrected.department === exp.department;
          ok ? overrideFixed++ : failed++;
          note = `raw WRONG DIRECTION (${v.category} / ${v.department}) → override → ${corrected.category} / ${corrected.department} ${ok ? '' : '  !!'}`;
        }
        // direction (b): inject the "Campus Facilities for a Hostel Room" mistake
        // into a real raw output and confirm the override remaps it back.
        if (lt === 'Hostel Room') {
          const inj = correctLocationRouting({ ...v, category: 'Campus Facilities', department: 'Gateway' }, 'Hostel Room', TEXT);
          const injOk = inj.category === exp.category && inj.department === exp.department;
          injOk ? injPass++ : failed++;
          note += `  |  injected-(b): Campus Facilities → override → ${inj.category} / ${inj.department} ${injOk ? 'OK' : 'FAIL'}`;
        }
      } catch (err) { note = `raw probe threw (${err.message})`; }

      console.log(`  run ${i}: e2e ${e2eOk ? 'OK  ' : 'FAIL'} [${e2e.category} / ${e2e.department} · src=${e2e._source}]  |  ${note}`);
    }

    const inj = lt === 'Hostel Room' ? `  injected-(b) ${injPass}/${RUNS}` : '';
    console.log(`  → e2e ${e2ePass}/${RUNS}  (rules fallback ${fallback}/${RUNS})  |  raw model: direction right ${rawRight}, wrong ${rawWrong}, override fixed ${overrideFixed}/${rawWrong}${inj}\n`);
    assert.strictEqual(e2ePass, RUNS, `location_type "${lt}": every end-to-end run must resolve to ${exp.category} / ${exp.department}`);
  }

  if (failed) { console.error(`RESULT: ${failed} failing check(s)`); process.exit(1); }
  console.log('RESULT: both directions resolve correctly on every run.');
})();
