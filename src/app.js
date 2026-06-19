import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import indexRoutes from './routes/index.js';
import errorMiddleware from './middlewares/error.middleware.js';

const app = express();

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan('dev'));

// CORS — allow ALL origins. `origin: true` reflects the request's origin (so it
// also works when requests send credentials/Authorization), and handles preflight.
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors({ origin: true, credentials: true }));

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Serve locally-stored KYC docs when S3 isn't configured (dev fallback only).
app.use('/uploads', express.static(path.join(process.cwd(), 'src', 'uploads')));

// API routes
app.use('/', indexRoutes);

// Serve frontend static files
const publicPath = path.join(process.cwd(), 'public');
app.use(express.static(publicPath));

// SPA fallback — serve index.html for any route not matched by API
app.get('*', (req, res) => {
  const indexPath = path.join(publicPath, 'index.html');
  res.sendFile(indexPath);
});

app.use(errorMiddleware);

export default app;
