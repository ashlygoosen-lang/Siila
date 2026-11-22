const db = require('./db');
const { notify } = require('./services');

// Alert professionals whose skills or headline match a newly opened job (like a project feed), capped to stay polite.
// Remote jobs reach everyone; on-site jobs skip foreign nationals who don't have South African work rights.
function announceJob(job, actorId = null) {
  const words = `${job.title} ${job.category}`.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 3);
  if (!words.length) return 0;
  const like = words.map(() => '(LOWER(p.skills) LIKE ? OR LOWER(p.headline) LIKE ?)').join(' OR ');
  const matches = db.prepare(`SELECT u.id FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.role = 'talent' AND u.status = 'active' AND (${like})
    AND (${job.remote ? '1' : "NOT (p.residency = 'foreign' AND p.work_rights != 'yes')"}) LIMIT 50`)
    .all(...words.flatMap(w => [`%${w}%`, `%${w}%`]));
  const where = job.remote ? 'remote' : `in ${job.city}`;
  const funded = job.escrow_required ? ' The budget is already in escrow.' : '';
  for (const m of matches) notify(m.id, 'job_match', `New ${job.remote ? 'remote ' : ''}job that matches your skills: "${job.title}" ${where}.${funded}`, `#job/${job.id}`, actorId);
  return matches.length;
}

module.exports = { announceJob };
