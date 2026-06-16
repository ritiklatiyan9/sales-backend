import { Server } from 'socket.io';
import { verifyToken } from './jwt.js';

let io;

export const initSocket = (server) => {
  io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  // JWT auth on the socket handshake (same token as REST).
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication error'));
    try {
      socket.user = verifyToken(token);
      next();
    } catch {
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket) => {
    // Clients join a per-booking room to receive KYC/OCR updates for that booking.
    socket.on('join_booking', (bookingId) => socket.join(`booking_${bookingId}`));
    socket.on('leave_booking', (bookingId) => socket.leave(`booking_${bookingId}`));
  });

  return io;
};

export const getIo = () => io;

/**
 * Emit an OCR/KYC status change to the SPA. OCR now runs in-process (see
 * services/ocrProcessor.js), so the processor calls this directly — there is no longer a
 * Redis pub/sub relay from a separate worker. We emit globally and to the booking room.
 */
export const emitOcrUpdate = (evt) => {
  if (!io) return;
  io.emit('ocr_update', evt);
  if (evt.bookingId) io.to(`booking_${evt.bookingId}`).emit('ocr_update', evt);
};
