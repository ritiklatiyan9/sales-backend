import 'dotenv/config';
import http from 'http';
import app from './app.js';
import pool, { connectDB } from './config/db.js';
import { initSocket } from './config/socket.js';
import { recoverOcrQueue } from './queue/ocrQueue.js';

const PORT = process.env.PORT || 8001;
const server = http.createServer(app);

initSocket(server);   // socket.io (OCR events emitted in-process; no Redis relay)

async function start() {
  try {
    await connectDB();
    await recoverOcrQueue(pool);
    server.listen(PORT, () => console.log(`[booking-api] running on port ${PORT}`));
  } catch (err) {
    console.error('[booking-api] Failed to connect to DB:', err.code || 'CONNECTION_ERROR');
    // A temporary network failure must not leave the local integration stopped.
    setTimeout(start, 5000);
  }
}
void start();
