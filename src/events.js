// Live updates for signed-in users (Server-Sent Events over a streaming fetch).
// Each browser tab keeps one /api/me/stream connection open; the server pushes
// notifications, inbox messages and counter changes to it the moment they happen.
const clients = new Map(); // userId -> Set<res>

function subscribe(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  return () => {
    const set = clients.get(userId);
    if (!set) return;
    set.delete(res);
    if (!set.size) clients.delete(userId);
  };
}

function send(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  } catch {
    // connection already closed; it will be unsubscribed on 'close'
  }
}

function emit(userId, event, data) {
  const set = clients.get(Number(userId));
  if (set) for (const res of set) send(res, event, data);
}

const isOnline = (userId) => clients.has(Number(userId));

module.exports = { subscribe, send, emit, isOnline };
