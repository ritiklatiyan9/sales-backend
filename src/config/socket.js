import { Server } from 'socket.io';
import { currentStaffSession } from '../services/staffSession.js';
import { realtimeRoomAccess, deliverOcrUpdate } from '../services/realtimeAccess.js';
import { originAllowed } from '../security/origins.js';

let io;
export const initSocket = server => {
  io = new Server(server, {
    cors: { origin: (origin, callback) => callback(null, originAllowed(origin)), methods: ['GET', 'POST'] },
    allowRequest: (req, callback) => callback(null, originAllowed(req.headers.origin)),
    maxHttpBufferSize: 16 * 1024,
  });
  io.use(async (socket, next) => {
    try { socket.user = await currentStaffSession(socket.handshake.auth?.token); next(); }
    catch { next(new Error('Authentication error')); }
  });
  io.on('connection', socket => {
    // Keep subscriptions small and recheck account revocation and ownership before
    // every delivery; long-lived connections must not retain revoked access.
    const subscriptions = new Map();
    socket.data.ocrSubscriptions = subscriptions;
    let attempts = 0, windowEnd = Date.now() + 60_000;
    for (const kind of ['booking', 'kyc_case']) {
      socket.on(`join_${kind}`, async (id, acknowledge) => {
        const reply = value => { if (typeof acknowledge === 'function') acknowledge(value); };
        if (Date.now() > windowEnd) { attempts = 0; windowEnd = Date.now() + 60_000; }
        if (++attempts > 40 || subscriptions.size >= 10) return reply({ ok: false });
        try {
          const { room } = await realtimeRoomAccess(socket.handshake.auth?.token, kind, id);
          if (!socket.connected) return;
          subscriptions.set(room, { kind, id: Number(id) });
          reply({ ok: true });
        } catch { reply({ ok: false }); }
      });
      socket.on(`leave_${kind}`, id => subscriptions.delete(`${kind}_${Number(id)}`));
    }
  });
  return io;
};
export const getIo = () => io;

/** No global broadcast: deliver only after live session + record authorization. */
export const emitOcrUpdate = evt => io ? deliverOcrUpdate(io, evt) : Promise.resolve();
