import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import indexRoutes from './routes/index.js';
import errorMiddleware from './middlewares/error.middleware.js';
import { websiteWebhookHandler } from './routes/websiteBooking.routes.js';

const app = express();

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan((tokens,req,res) => [tokens.method(req,res),
  // Request tokens authorize recovery; keep them out of HTTP access logs.
  tokens.url(req,res).replace(/(\/public\/website\/requests\/)[a-f0-9]{64}/g,'$1[redacted]'),
  tokens.status(req,res),tokens['response-time'](req,res),'ms'].join(' ')));
if (process.env.TRUST_PROXY) app.set('trust proxy',process.env.TRUST_PROXY.split(',').map(value=>value.trim()));

const corsOriginValue = String(process.env.CORS_ORIGIN || '').trim();
const configuredCorsOrigins = corsOriginValue && corsOriginValue !== '*'
  ? corsOriginValue.split(',').map((origin) => origin.trim()).filter(Boolean)
  : [];
const allowedCorsOrigins = new Set([
  ...configuredCorsOrigins,
  'https://sales-dg-frontend.vercel.app',
  'https://www.dgbooking.com',
  'https://dgbooking.com',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:3000',
]);

const corsOriginHandler = (origin, callback) => {
  if (!origin) return callback(null, true);
  if (corsOriginValue === '*' || allowedCorsOrigins.has(origin)) {
    return callback(null, true);
  }
  return callback(null, false);
};

// CORS — allow the booking frontend origins explicitly and handle preflight.
app.use(cors({
  origin: corsOriginHandler,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));
app.options('*', cors({
  origin: corsOriginHandler,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

app.post('/public/website/webhook',express.raw({type:'application/json',limit:'256kb'}),websiteWebhookHandler);
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
