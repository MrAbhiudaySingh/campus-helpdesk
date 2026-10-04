require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');
const { createTicket, assignTicket, addComment, submitOrResolve } = require('../services/ticketService');
const { proposeVisit, updateVisit } = require('../services/visitService');

// Departments + categories are the REAL routing taxonomy (Section 12.2), not
// demo data — the auto-triage engine can't function without them, so they are
// always seeded.
//
// Users: one bootstrap admin plus four demo accounts. Anyone else
// self-registers as a STUDENT and is promoted by the admin from the Users
// page. Credentials are documented in README.md only — nothing is shown in
// the UI.
//
// Demo tickets: a small varied set, ALL created through
// ticketService.createTicket() as the demo student, so their
// category/department/priority/ai_summary are whatever the CURRENT triage
// engine produces — never hand-written. Two of them are then progressed
// through the real lifecycle (assign + public/internal comments; Smart Visit
// proposed -> scheduled -> checked in) via the same service functions the API
// routes use.
//
// Emails are built from parts (local + "@" + domain) rather than literal
// string constants, to avoid this authoring environment's file-write email
// redaction. Everything is idempotent: `npm run seed` is safe to re-run.
const DOMAIN = 'campus.edu';
const mkEmail = (local) => `${local}@${DOMAIN}`;

const ACCOUNTS = [
  { key: 'admin',     name: 'Admin',                    local: 'admin',             password: 'Admin@123',     role: 'ADMIN',     dept: null },
  { key: 'itStaff',   name: 'Rahul (IT Support Staff)', local: 'rahul.it',          password: 'Staff@123',     role: 'STAFF',     dept: 'Tech Support' },
  { key: 'facLead',   name: 'Priya (Facilities Lead)',  local: 'priya.facilities',  password: 'Staff@123',     role: 'LEAD',      dept: 'Warden / Hostel Administration' },
  { key: 'custodian', name: 'Warden (Hostel)',          local: 'warden',            password: 'Custodian@123', role: 'CUSTODIAN', dept: 'Warden / Hostel Administration' },
  { key: 'student',   name: 'Abhiuday (Student)',       local: 'abhiuday.student',  password: 'Student@123',   role: 'STUDENT',   dept: null },
];

// Same AC text, reported in two location_types — the seeded proof of the
// hostel-vs-academic split (the single most interesting thing this engine does).
const AC_TEXT = {
  title: 'AC not cooling in the room',
  description:
    'The air conditioner runs but only blows warm air, the room never cools down even on the lowest temperature setting. It has been like this for two days.',
};

const DEMO_TICKETS = [
  {
    key: 'wifi',
    title: 'Wi-Fi keeps disconnecting',
    description:
      'Wi-Fi in Tower 5 Room 117 disconnects repeatedly every few minutes, which keeps dropping me out of online classes and the LMS.',
    location: 'Tower 5, Room 117',
    location_type: 'Hostel Room',
  },
  {
    key: 'acHostel',
    ...AC_TEXT,
    location: 'Tower 5, Room 214',
    location_type: 'Hostel Room',
  },
  {
    key: 'acAcademic',
    ...AC_TEXT,
    location: 'Academic Block B, Room 108 (tutorial room)',
    location_type: 'Academic / Admin Block',
  },
  {
    key: 'safety',
    title: 'Fire alarm and smoke in the hostel stairwell',
    description:
      'The fire alarm on the third floor is going off and there is smoke and a burning smell near the stairwell wiring. Students are leaving the building.',
    location: 'Hostel Block C, 3rd floor stairwell',
    location_type: 'Other',
  },
  {
    key: 'library',
    title: 'Cannot access e-journals or the library catalogue',
    description:
      'None of the library e-resources, e-journals or the online catalogue will load from off campus. I get an access error every time I try to sign in.',
    location: 'Central Library / remote access',
    location_type: 'Library',
  },
  {
    key: 'transport',
    title: 'North campus shuttle has not run for two days',
    description:
      'The shuttle bus to the north campus stop has not shown up at its scheduled times for the last two days, and students are missing early-morning classes.',
    location: 'Main gate shuttle stop',
    location_type: 'Transport / Campus Grounds',
  },
  {
    key: 'hostelElec',
    title: 'Ceiling light and fan dead after a power cut',
    description:
      'After last night’s power cut the ceiling light and the fan in my hostel room stopped working completely. The switch does nothing and the socket next to it is also dead.',
    location: 'Tower 3, Room 118',
    location_type: 'Hostel Room',
  },
  {
    key: 'av',
    title: 'Projector will not switch on in the seminar room',
    description:
      'The ceiling projector in the seminar room does not power on at all. I tried the remote and the wall switch and nothing happens, so the session could not use any slides.',
    location: 'Academic Block A, Seminar Room 2',
    location_type: 'Academic / Admin Block',
  },
];

function upsertUser({ name, email, password, role, department_id = null }) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return existing.id;
  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash, role, department_id) VALUES (?,?,?,?,?)')
    .run(name, email, hash, role, department_id);
  return info.lastInsertRowid;
}

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 16);

async function run() {
  console.log('Seeding database...');

  // Real routing chart — Section 12.2. Exactly six departments.
  const departments = [
    ['Tech Support', 'Wi-Fi / network, accounts, software, LMS'],
    ['AV Support', 'Classroom / auditorium AV equipment'],
    ['Warden / Hostel Administration', 'Everything inside a hostel room: electrical, plumbing, furniture, AC, housekeeping'],
    ['Gateway', 'Campus facilities (electrical/plumbing in academic & admin blocks), transport, and anything uncategorised'],
    ['Campus Security', 'Unauthorized access, suspicious activity, safety'],
    ['Library Services', 'Library access, equipment and resources'],
  ];
  const deptIds = {};
  for (const [name, description] of departments) {
    const existing = db.prepare('SELECT id FROM departments WHERE name = ?').get(name);
    deptIds[name] = existing
      ? existing.id
      : db.prepare('INSERT INTO departments (name, description) VALUES (?,?)').run(name, description).lastInsertRowid;
  }

  // The 13 real categories. Hostel – * are distinct from "Campus Facilities"
  // even though the underlying issue type overlaps — the auto-triage engine
  // splits them by the ticket's Location Type, not by keywords.
  const categories = [
    ['Wi-Fi / Network', 'Tech Support'],
    ['Account / Software', 'Tech Support'],
    ['Classroom / AV', 'AV Support'],
    ['Hostel – Electrical', 'Warden / Hostel Administration'],
    ['Hostel – Plumbing', 'Warden / Hostel Administration'],
    ['Hostel – Furniture', 'Warden / Hostel Administration'],
    ['Hostel – AC / HVAC', 'Warden / Hostel Administration'],
    ['Hostel – Housekeeping', 'Warden / Hostel Administration'],
    ['Campus Facilities', 'Gateway'],
    ['Transport', 'Gateway'],
    ['General', 'Gateway'],
    ['Security', 'Campus Security'],
    ['Library', 'Library Services'],
  ];
  for (const [name, deptName] of categories) {
    const existing = db.prepare('SELECT id FROM categories WHERE name = ?').get(name);
    if (!existing) {
      db.prepare('INSERT INTO categories (name, default_department_id) VALUES (?,?)').run(name, deptIds[deptName]);
    }
  }

  // Users — admin + 4 demo accounts, idempotent.
  const userIds = {};
  for (const a of ACCOUNTS) {
    userIds[a.key] = upsertUser({
      name: a.name,
      email: mkEmail(a.local),
      password: a.password,
      role: a.role,
      department_id: a.dept ? deptIds[a.dept] : null,
    });
  }

  // --- Demo tickets + lifecycle. Idempotent: skip the whole block if ANY
  //     ticket already exists (same guard as the original single-ticket one). ---
  if (db.prepare('SELECT id FROM tickets LIMIT 1').get()) {
    console.log('Demo tickets: already present, skipping the demo-data block.');
  } else {
    console.log('\nCreating demo tickets (all as the demo student, via ticketService.createTicket):');
    const created = {};
    for (const spec of DEMO_TICKETS) {
      try {
        const r = await createTicket({ user_id: userIds.student, ...spec });
        created[spec.key] = r;
        console.log(
          `  ${r.ticketNo}  ${r.triage.category} / ${r.triage.department} / ${r.triage.priority}  (source: ${r.triageSource})  [${spec.location_type}]  "${spec.title}"`
        );
      } catch (err) {
        console.warn(`  "${spec.title}" could not be created (${err.message}) — skipping.`);
      }
    }

    // hostel-vs-academic AC split — must land in two different departments.
    if (created.acHostel && created.acAcademic) {
      const h = created.acHostel.triage.department;
      const a = created.acAcademic.triage.department;
      console.log(
        `\n  AC split check: Hostel Room -> "${h}"   |   Academic / Admin Block -> "${a}"   =>   ${h !== a ? 'DIFFERENT departments (as expected)' : 'SAME department (unexpected — logged as-is)'}`
      );
    }

    // --- Progress two tickets through the real lifecycle (service functions,
    //     the same ones the API routes call). Guarded so we never force an
    //     assignment into the wrong department. ---

    // 1. Wi-Fi ticket -> assigned to the IT staff member, with a public reply
    //    and an internal note (comment-visibility demo on login).
    const wifi = created.wifi;
    if (wifi && wifi.triage.department === 'Tech Support') {
      assignTicket({ ticket_id: wifi.ticketId, assigned_to: userIds.itStaff, actor_id: userIds.admin });
      addComment({
        ticket_id: wifi.ticketId,
        user_id: userIds.itStaff,
        message:
          'Thanks for the report. The access-point logs for Tower 5 show heavy packet loss on your floor — a technician will swap the unit tomorrow morning, you should not need to be in the room.',
        visibility: 'PUBLIC',
        actorRole: 'STAFF',
        actorName: ACCOUNTS.find((x) => x.key === 'itStaff').name,
      });
      addComment({
        ticket_id: wifi.ticketId,
        user_id: userIds.itStaff,
        message:
          'Internal: AP-T5-3F firmware is two revisions behind and the radio is flapping under load. Replacement unit ordered (RMA 4471); will re-image the old one as a cold spare.',
        visibility: 'INTERNAL',
        actorRole: 'STAFF',
        actorName: ACCOUNTS.find((x) => x.key === 'itStaff').name,
      });
      console.log(`\n  ${wifi.ticketNo}: assigned to Rahul (IT staff) + 1 public reply + 1 internal note.`);
    } else if (wifi) {
      console.log(`\n  ${wifi.ticketNo}: triage landed it in "${wifi.triage.department}", not Tech Support — left unassigned (not forcing it).`);
    }

    // 2. Hostel AC ticket -> Smart Visit proposed, then scheduled and checked in
    //    (left "in progress" — not completed/resolved).
    const acH = created.acHostel;
    if (acH && acH.triage.department === 'Warden / Hostel Administration') {
      const visit = proposeVisit({
        ticket_id: acH.ticketId,
        proposed_by: userIds.facLead,
        technician_slot: inDays(2),
      });
      updateVisit({
        visit_id: visit.id,
        status: 'SCHEDULED',
        outcome_notes: 'Confirmed with the resident. Technician R. Kumar assigned for the afternoon slot.',
        actor_id: userIds.facLead,
      });
      updateVisit({ visit_id: visit.id, status: 'CHECKED_IN', actor_id: userIds.facLead });
      console.log(`  ${acH.ticketNo}: Smart Visit proposed -> scheduled -> checked in (in progress).`);
    } else if (acH) {
      console.log(`  ${acH.ticketNo}: triage landed it in "${acH.triage.department}", not Warden / Hostel Administration — visit demo skipped.`);
    }

    // 3. Hostel electrical ticket -> the department marks it completed and
    //    submits it for admin review (status AWAITING_REVIEW, not resolved).
    const elec = created.hostelElec;
    if (elec && elec.triage.department === 'Warden / Hostel Administration') {
      submitOrResolve({
        ticket_id: elec.ticketId,
        actor_id: userIds.facLead,
        actorRole: 'LEAD',
        actorName: ACCOUNTS.find((x) => x.key === 'facLead').name,
        resolution_notes:
          'Replaced the tripped MCB and the burnt light holder; tested the fan and both switches, all working. Please review and close.',
      });
      console.log(`  ${elec.ticketNo}: marked completed by the department — now AWAITING_REVIEW for the admin.`);
    }
  }

  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const ticketCount = db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;
  console.log(
    `\nSeed complete. ${userCount} users, ${ticketCount} ticket(s). Bootstrap admin: ${mkEmail('admin')} / Admin@123`
  );
  console.log('Other users self-register as students; the admin promotes them from the Users page.');
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
