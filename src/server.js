import 'dotenv/config';
import http from 'http';
import app from './app.js';
import { connectDB } from './config/db.js';
import { initSocket } from './config/socket.js';

const PORT = process.env.PORT || 8001;
const server = http.createServer(app);

initSocket(server);   // socket.io (OCR events emitted in-process; no Redis relay)

connectDB()
  .then(() => {
    server.listen(PORT, () => console.log(`[booking-api] running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('[booking-api] Failed to connect to DB', err);
    process.exit(1);
  });
