// Inbox: one conversation per client + professional (+ job). Messages are pushed live over /api/me/stream.
const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { HttpError, auth, validate, z } = require('../util');
const { UPLOAD_DIR, postMessage, getOrCreateConversation, counts, MESSAGE_SELECT } = require('../services');
const { emit, isOnline } = require('../events');

router.use(auth());

const CHAT_DIR = path.join(UPLOAD_DIR, 'chat');
fs.mkdirSync(CHAT_DIR, { recursive: true });
const TYPES = {
  'application/pdf': ['.pdf', '25504446'], 'image/jpeg': ['.jpg', 'ffd8ff'], 'image/png': ['.png', '89504e47'],
  'image/webp': ['.webp', '52494646'], 'application/zip': ['.zip', '504b0304'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx', '504b0304'],
};
const upload = multer({
  storage: multer.diskStorage({ destination: CHAT_DIR, filename: (_q, f, cb) => cb(null, crypto.randomBytes(16).toString('hex') + (TYPES[f.mimetype]?.[0] || '')) }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_q, f, cb) => TYPES[f.mimetype] ? cb(null, true) : cb(new HttpError(400, 'Attach a PDF, image, Word document or ZIP file')),
});
function magicOk(file) {
  const b = Buffer.alloc(4), fd = fs.openSync(file.path, 'r');
  fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd);
  return b.toString('hex').startsWith(TYPES[file.mimetype][1]);
}

function load(req) {
  const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!c) throw new HttpError(404, 'Conversation not found');
  if (c.client_id !== req.user.id && c.talent_id !== req.user.id) throw new HttpError(403, 'This conversation belongs to other accounts');
  return c;
}

const LIST = `SELECT c.*, j.title AS job_title,
    cu.name AS client_name, tu.name AS talent_name, tp.avatar_color AS talent_color, tp.headline AS talent_headline, tp.verified AS talent_verified,
    lm.body AS last_body, lm.kind AS last_kind, lm.sender_id AS last_sender_id, lm.attachment_name AS last_attachment, lm.id AS last_id,
    (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id AND m.sender_id != ? AND m.id > IFNULL(r.last_read_id, 0)) AS unread,
    (SELECT last_read_id FROM conversation_reads o WHERE o.conversation_id = c.id AND o.user_id != ?) AS other_read_id
  FROM conversations c
  LEFT JOIN jobs j ON j.id = c.job_id
  JOIN users cu ON cu.id = c.client_id JOIN users tu ON tu.id = c.talent_id LEFT JOIN profiles tp ON tp.user_id = c.talent_id
  LEFT JOIN conversation_reads r ON r.conversation_id = c.id AND r.user_id = ?
  LEFT JOIN chat_messages lm ON lm.id = (SELECT MAX(id) FROM chat_messages WHERE conversation_id = c.id)`;

const shape = (c, me) => {
  const iAmClient = c.client_id === me;
  const otherId = iAmClient ? c.talent_id : c.client_id;
  return {
    id: c.id, job_id: c.job_id, job_title: c.job_title || null, last_message_at: c.last_message_at,
    other: { id: otherId, name: iAmClient ? c.talent_name : c.client_name, role: iAmClient ? 'talent' : 'client',
      headline: iAmClient ? c.talent_headline : null, avatar_color: iAmClient ? c.talent_color : null, verified: iAmClient ? !!c.talent_verified : false, online: isOnline(otherId) },
    last: c.last_id ? { body: c.last_kind === 'event' ? c.last_body.split('|')[0] : c.last_body, kind: c.last_kind, mine: c.last_sender_id === me, attachment: c.last_attachment || '' } : null,
    unread: c.unread, other_read_id: c.other_read_id || 0,
  };
};

router.get('/', validate(z.object({ q: z.string().trim().max(80).optional() }), 'query'), (req, res) => {
  const me = req.user.id;
  const args = [me, me, me, me, me];
  let where = 'WHERE (c.client_id = ? OR c.talent_id = ?)';
  if (req.q.q) { where += ' AND (cu.name LIKE ? OR tu.name LIKE ? OR j.title LIKE ?)'; args.push(...Array(3).fill(`%${req.q.q}%`)); }
  const rows = db.prepare(`${LIST} ${where} ORDER BY c.last_message_at DESC, c.id DESC LIMIT 100`).all(...args);
  res.json({ data: rows.map(r => shape(r, me)), counts: counts(me) });
});

// Start (or reopen) a conversation. Clients pick a professional; professionals can only reply to clients who already contacted them or who posted a job they bid on.
router.post('/', validate(z.object({ user_id: z.number().int(), job_id: z.number().int().optional(), body: z.string().trim().max(2000).default('') })), (req, res) => {
  const me = req.user.id, other = db.prepare("SELECT id, role FROM users WHERE id = ? AND status = 'active'").get(req.body.user_id);
  if (!other) throw new HttpError(404, 'Member not found');
  let clientId, talentId;
  if (req.user.role === 'client' && other.role === 'talent') { clientId = me; talentId = other.id; }
  else if (req.user.role === 'talent' && other.role === 'client') {
    clientId = other.id; talentId = me;
    const allowed = db.prepare('SELECT 1 FROM conversations WHERE client_id = ? AND talent_id = ?').get(clientId, talentId)
      || (req.body.job_id && db.prepare('SELECT 1 FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.user_id = ? AND j.id = ? AND j.client_id = ?').get(me, req.body.job_id, clientId));
    if (!allowed) throw new HttpError(403, 'Bid on one of this client\'s jobs to message them');
  } else throw new HttpError(400, 'Conversations are between a client and a professional');
  if (req.body.job_id && !db.prepare('SELECT 1 FROM jobs WHERE id = ? AND client_id = ?').get(req.body.job_id, clientId)) throw new HttpError(404, 'Job not found');
  const conv = getOrCreateConversation(clientId, talentId, req.body.job_id || null);
  if (req.body.body) postMessage(conv, me, req.body.body);
  res.status(201).json({ data: { id: conv.id } });
});

router.get('/:id', validate(z.object({ before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), 'query'), (req, res) => {
  const c = load(req), me = req.user.id;
  const { before, limit } = req.q;
  const rows = db.prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? ${before ? 'AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT ?`).all(c.id, ...(before ? [before] : []), limit).reverse();
  const head = shape(db.prepare(`${LIST} WHERE c.id = ?`).get(me, me, me, c.id), me);
  const contracts = db.prepare(`SELECT id, status, amount_cents, updated_at FROM contracts WHERE client_id = ? AND talent_id = ? AND (? IS NULL OR job_id = ?) ORDER BY id DESC`)
    .all(c.client_id, c.talent_id, c.job_id, c.job_id);
  res.json({ data: { ...head, contracts, messages: rows, has_more: rows.length === limit } });
});

router.post('/:id/messages', upload.single('file'), (req, res) => {
  const c = load(req);
  const body = String(req.body?.body ?? '').trim().slice(0, 4000);
  let attachment = null;
  if (req.file) {
    if (!magicOk(req.file)) { fs.rmSync(req.file.path, { force: true }); throw new HttpError(400, 'That file does not look like the type it claims to be'); }
    attachment = { path: path.basename(req.file.path), name: req.file.originalname.replace(/[^\w.\- ()]/g, '_').slice(0, 120), mime: req.file.mimetype, size: req.file.size };
  }
  if (!body && !attachment) throw new HttpError(400, 'Write a message or attach a file');
  const msg = postMessage(c, req.user.id, body, 'text', attachment);
  res.status(201).json({ data: msg });
});

router.get('/:id/files/:mid', (req, res) => {
  const c = load(req);
  const m = db.prepare('SELECT * FROM chat_messages WHERE id = ? AND conversation_id = ?').get(req.params.mid, c.id);
  if (!m || !m.attachment_path) throw new HttpError(404, 'File not found');
  const file = path.join(CHAT_DIR, path.basename(m.attachment_path));
  if (!fs.existsSync(file)) throw new HttpError(404, 'File not found');
  res.setHeader('Content-Type', m.attachment_mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${m.attachment_mime.startsWith('image/') && req.query.inline ? 'inline' : 'attachment'}; filename="${m.attachment_name.replace(/"/g, '')}"`);
  fs.createReadStream(file).pipe(res);
});

router.post('/:id/read', (req, res) => {
  const c = load(req), me = req.user.id;
  const last = db.prepare('SELECT MAX(id) id FROM chat_messages WHERE conversation_id = ?').get(c.id).id || 0;
  db.prepare(`INSERT INTO conversation_reads (conversation_id, user_id, last_read_id) VALUES (?,?,?)
    ON CONFLICT(conversation_id, user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`).run(c.id, me, last);
  // Clear message notifications that point at this thread.
  db.prepare("UPDATE notifications SET read = 1 WHERE user_id = ? AND type = 'message' AND link = ?").run(me, `#inbox/${c.id}`);
  const other = c.client_id === me ? c.talent_id : c.client_id;
  emit(other, 'read', { conversation_id: c.id, last_read_id: last });
  emit(me, 'counts', counts(me));
  res.json({ ok: true, counts: counts(me) });
});

router.post('/:id/typing', (req, res) => {
  const c = load(req), me = req.user.id;
  emit(c.client_id === me ? c.talent_id : c.client_id, 'typing', { conversation_id: c.id, user_id: me });
  res.status(204).end();
});

module.exports = router;
