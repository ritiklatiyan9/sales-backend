import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { originAllowed } from './security/origins.js';
import indexRoutes from './routes/index.js';
import errorMiddleware from './middlewares/error.middleware.js';
import { websiteWebhookHandler } from './routes/websiteBooking.routes.js';

const app = express();

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan((tokens,req,res) => [tokens.method(req,res),
  // Request tokens authorize recovery; keep them out of HTTP access logs.
  tokens.url(req,res).split('?')[0].replace(/(\/public\/website\/requests\/)[a-f0-9]{64}/g,'$1[redacted]'),
  tokens.status(req,res),tokens['response-time'](req,res),'ms'].join(' ')));
if (process.env.TRUST_PROXY) app.set('trust proxy',process.env.TRUST_PROXY.split(',').map(value=>value.trim()));

// CORS — allow the booking frontend origins explicitly and handle preflight. maxAge lets
// the browser reuse a preflight for 2 h instead of sending one before every request.
const corsOptions = {
  origin: (origin, callback) => callback(null, originAllowed(origin)),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Retry-After'], // the client honours a 429's wait instead of retrying blind
  maxAge: 7200,
};
// The Accounts client screen can provision access, but only this endpoint
// accepts its browser origin; every request still needs staff authentication.
app.use('/api/mobile/admin/accounts', cors({
  origin: (origin, callback) => callback(null, origin === 'https://dgdefence.com' || origin === 'https://www.dgdefence.com'),
  methods: ['POST'], allowedHeaders: ['Authorization', 'Content-Type'], maxAge: 600,
}));
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.post('/public/website/webhook',express.raw({type:'application/json',limit:'256kb'}),websiteWebhookHandler);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb', parameterLimit: 100 }));
app.use((req, res, next) => {
  if (req.get('Authorization') || req.path.startsWith('/public/')) res.set('Cache-Control', 'private, no-store');
  next();
});

// Serve locally-stored KYC docs when S3 isn't configured (dev fallback only).
if (process.env.NODE_ENV !== 'production') {
  app.use('/uploads', express.static(path.join(process.cwd(), 'src', 'uploads'), { dotfiles: 'deny', index: false }));
}

// Public app privacy page, available without a customer session.
app.use('/my-real-assets', express.static(path.join(process.cwd(), 'public', 'my-real-assets'), { dotfiles: 'deny', index: false }));

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
