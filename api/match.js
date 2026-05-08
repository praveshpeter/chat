const Ably = require('ably');

const ABLY_KEY = process.env.ABLY_KEY || '1_XAOw.n_HbIg:pswelOC3iFo9I_ZOocN9l7CMPb3AqwQvzNCu5VKPKFY';
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || 'https://witty-locust-118156.upstash.io';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAc2MAAIgcDE2Njk2MzA3ZjAyYzA0YTI1YTRhMjgzNzJkYTY2NzRiNw';
const MATCH_RADIUS_KM = 10;

// ── Redis helpers ────────────────────────────────────────────────────
async function redis(command, ...args) {
  const body = JSON.stringify([command, ...args]);
  const res = await fetch(`${REDIS_URL}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body
  });
  const data = await res.json();
  return data.result;
}

async function rget(key) {
  const val = await redis('GET', key);
  if (!val) return null;
  try { return JSON.parse(val); } catch { return val; }
}

async function rset(key, value, exSeconds = 60) {
  await redis('SET', key, JSON.stringify(value), 'EX', exSeconds);
}

async function rdel(key) {
  await redis('DEL', key);
}

async function rkeys(pattern) {
  return await redis('KEYS', pattern);
}

async function rincr(key) {
  return await redis('INCR', key);
}

// ── Distance formula ─────────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
    Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Main handler ─────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, clientId, name, lat, lng, partnerId, text, time } = req.body;
  const ably = new Ably.Rest(ABLY_KEY);

  switch (action) {

    case 'search': {
      // Check if already matched
      const existingMatch = await rget(`matched:${clientId}`);
      if (existingMatch) {
        return res.json({ matched: true, alreadyMatched: true });
      }

      // Check if locked
      const isLocked = await rget(`lock:${clientId}`);
      if (isLocked) {
        return res.json({ matched: false });
      }

      // Add/update this user in waiting pool (expires in 20 seconds)
      await rset(`waiting:${clientId}`, { clientId, name, lat, lng }, 20);

      // Get all waiting users
      const waitingKeys = await rkeys('waiting:*');
      let foundMatch = false;

      for (const wkey of waitingKeys) {
        const wUser = await rget(wkey);
        if (!wUser || wUser.clientId === clientId) continue;

        // Check if partner is locked or already matched
        const partnerLocked = await rget(`lock:${wUser.clientId}`);
        const partnerMatched = await rget(`matched:${wUser.clientId}`);
        if (partnerLocked || partnerMatched) continue;

        const dist = haversine(lat, lng, wUser.lat, wUser.lng);
        if (dist <= MATCH_RADIUS_KM) {
          // Lock both immediately (5 second lock)
          await rset(`lock:${clientId}`, 1, 5);
          await rset(`lock:${wUser.clientId}`, 1, 5);

          // Remove from waiting
          await rdel(`waiting:${clientId}`);
          await rdel(`waiting:${wUser.clientId}`);

          // Create room
          const roomId = [clientId, wUser.clientId].sort().join('__');
          const d = dist.toFixed(1);

          // Save match info (expires in 2 hours)
          await rset(`matched:${clientId}`, { partnerId: wUser.clientId, roomId }, 7200);
          await rset(`matched:${wUser.clientId}`, { partnerId: clientId, roomId }, 7200);

          // Increment total chats
          await rincr('stats:totalchats');

          // Notify both via Ably
          await ably.channels.get(`user-${clientId}`).publish('matched', {
            partnerId: wUser.clientId,
            partnerName: wUser.name,
            distance: d,
            roomId
          });
          await ably.channels.get(`user-${wUser.clientId}`).publish('matched', {
            partnerId: clientId,
            partnerName: name,
            distance: d,
            roomId
          });

          foundMatch = true;
          break;
        }
      }

      return res.json({ matched: foundMatch });
    }

    case 'cancel': {
      await rdel(`waiting:${clientId}`);
      await rdel(`lock:${clientId}`);
      await rdel(`matched:${clientId}`);
      await rdel(`active:${clientId}`);
      return res.json({ ok: true });
    }

    case 'leave': {
      await rdel(`waiting:${clientId}`);
      await rdel(`lock:${clientId}`);
      await rdel(`matched:${clientId}`);
      await rdel(`active:${clientId}`);

      if (partnerId) {
        await rdel(`matched:${partnerId}`);
        const roomId = [clientId, partnerId].sort().join('__');
        try {
          await ably.channels.get(`room-${roomId}`).publish('partner-left', { from: clientId });
        } catch(e) {}
      }
      return res.json({ ok: true });
    }

    case 'message': {
      if (!partnerId) return res.json({ ok: false });
      const roomId = [clientId, partnerId].sort().join('__');
      try {
        await ably.channels.get(`room-${roomId}`).publish('message', { from: clientId, text, time });
      } catch(e) { return res.json({ ok: false, error: e.message }); }
      return res.json({ ok: true });
    }

    case 'typing': {
      if (!partnerId) return res.json({ ok: false });
      const roomId = [clientId, partnerId].sort().join('__');
      try {
        await ably.channels.get(`room-${roomId}`).publish('typing', { from: clientId });
      } catch(e) {}
      return res.json({ ok: true });
    }

    case 'stop-typing': {
      if (!partnerId) return res.json({ ok: false });
      const roomId = [clientId, partnerId].sort().join('__');
      try {
        await ably.channels.get(`room-${roomId}`).publish('stop-typing', { from: clientId });
      } catch(e) {}
      return res.json({ ok: true });
    }

    case 'heartbeat': {
      // Keep user alive (expires in 30 seconds)
      await rset(`active:${clientId}`, 1, 30);
      return res.json({ ok: true });
    }

    case 'ping': {
      // Refresh waiting user TTL
      const waitingUser = await rget(`waiting:${clientId}`);
      if (waitingUser) {
        await rset(`waiting:${clientId}`, waitingUser, 20);
      }
      await rset(`active:${clientId}`, 1, 30);
      return res.json({ ok: true });
    }

    case 'stats': {
      const activeKeys = await rkeys('active:*');
      const matchedKeys = await rkeys('matched:*');
      const totalChats = await rget('stats:totalchats') || 0;
      return res.json({
        online: activeKeys.length,
        activeChats: Math.floor(matchedKeys.length / 2),
        totalChats: parseInt(totalChats)
      });
    }

    default:
      return res.status(400).json({ error: 'Unknown action' });
  }
};
