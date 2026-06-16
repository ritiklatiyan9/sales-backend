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

// CORS — allow the booking-ui SPA origin(s). `*` for dev.
const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: corsOrigin === '*' ? '*' : corsOrigin.split(',').map((s) => s.trim()) }));

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Serve locally-stored KYC docs when S3 isn't configured (dev fallback only).
app.use('/uploads', express.static(path.join(process.cwd(), 'src', 'uploads')));

app.use('/', indexRoutes);
app.use(errorMiddleware);

export default app;
