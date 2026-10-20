import express from 'express';
import { createHash } from 'node:crypto';
import authMiddleware from '../middlewares/auth.middleware.js';
import pool from '../config/db.js';
import { createWebsiteBookingService } from '../services/websiteBookings.js';
import { createRazorpayGateway, verifyWebhookSignature } from '../services/websiteRazorpay.js';
import { queueWhatsApp } from '../services/whatsapp.service.js';

export const gateway = createRazorpayGateway();
export const websiteBookingService = createWebsiteBookingService({
  db:pool,gateway,siteId:()=>process.env.WEBSITE_SITE_ID,
  tokenSecret:process.env.WEBSITE_REQUEST_TOKEN_SECRET || process.env.JWT_ACCESS_SECRET || process.env.RAZORPAY_KEY_SECRET,
});

// Low-cardinality, bounded limiter. Do not trust arbitrary forwarding headers;
// deployments may explicitly configure TRUST_PROXY to their known reverse proxy.
export function websiteRateLimit({ limit=120,windowMs=60000,clock=()=>Date.now() }={}) {
  const counters = new Map();
  return (req,res,next) => {
    const now=clock();
    if (counters.size>=10000) for (const [key,value] of counters) if (value.until<=now) counters.delete(key);
    const key=req.ip || req.socket?.remoteAddress || 'unknown';
    let bucket=counters.get(key);
    if (!bucket || bucket.until<=now) {
      if(!bucket && counters.size>=10000)return res.status(429).json({message:'Please wait and try again.',code:'RATE_LIMITED'});
      bucket={count:0,until:now+windowMs}; counters.set(key,bucket);
    }
    if (++bucket.count>limit || counters.size>10000) {
      res.set('Retry-After',String(Math.ceil((bucket.until-now)/1000)));
      return res.status(429).json({message:'Too many requests. Please wait and try again.',code:'RATE_LIMITED'});
    }
    next();
  };
}
function route(handler) {
  return async (req,res) => {
    try { res.set('Cache-Control','no-store'); await handler(req,res); }
    catch(error) {
      // Never surface database internals, buyer information or gateway credentials.
      if (!error.publicMessage) console.error('[website-booking]',error.code || error.name || 'ERROR');
      res.status(error.status || 500).json({message:error.publicMessage || (error.status ? error.message : 'Booking service is unavailable. Please retry or contact the office.'),
        code: /^[A-Z][A-Z0-9_]+$/.test(error.code || '') ? error.code : 'WEBSITE_SERVICE_ERROR'});
    }
  };
}
export const publicWebsiteRoutes=express.Router();
publicWebsiteRoutes.use(websiteRateLimit({limit:3000}));
publicWebsiteRoutes.get('/config',route(async(req,res)=>res.json(await websiteBookingService.config())));
publicWebsiteRoutes.get('/plots',route(async(req,res)=>res.json(await websiteBookingService.plots())));
// The website same-origin proxy applies the tighter visitor limits. This coarse
// upstream cap accommodates many visitors behind its shared socket address.
publicWebsiteRoutes.post('/orders',websiteRateLimit({limit:1000,windowMs:600000}),route(async(req,res)=>res.status(201).json(await websiteBookingService.createOrder(req.body))));
publicWebsiteRoutes.post('/payments/verify',websiteRateLimit({limit:1200}),route(async(req,res)=>res.json(await websiteBookingService.verifyPayment(req.body))));
publicWebsiteRoutes.get('/requests/:token',route(async(req,res)=>res.json(await websiteBookingService.requestStatus(req.params.token))));
publicWebsiteRoutes.post('/requests/:token/reconcile',websiteRateLimit({limit:1200}),route(async(req,res)=>res.json(await websiteBookingService.reconcilePublic(req.params.token))));

export const websiteManagementRoutes=express.Router();
websiteManagementRoutes.use(authMiddleware);
websiteManagementRoutes.get('/settings',route(async(req,res)=>res.json(await websiteBookingService.getSettings(req.user,req.query.site_id))));
websiteManagementRoutes.put('/settings',route(async(req,res)=>res.json(await websiteBookingService.saveSettings(req.user,req.body))));
websiteManagementRoutes.get('/requests',route(async(req,res)=>res.json(await websiteBookingService.listRequests(req.user,req.query.site_id,req.query.status))));
websiteManagementRoutes.post('/requests/:id/reconcile',route(async(req,res)=>res.json(await websiteBookingService.reconcile(req.user,req.params.id,req.body))));
// Hooked here, not in the service: the service is tested against an injected database.
websiteManagementRoutes.post('/requests/:id/approve',route(async(req,res)=>{
  const approved=await websiteBookingService.approve(req.user,req.params.id,req.body.notes);
  if(approved.booking_id)queueWhatsApp('BOOKING_CREATED',approved.booking_id);
  res.json(approved);
}));
websiteManagementRoutes.post('/requests/:id/reject',route(async(req,res)=>res.json(await websiteBookingService.reject(req.user,req.params.id,req.body.notes))));

// Mounted before express.json(): HMAC must authenticate the exact received bytes.
export const websiteWebhookHandler=route(async(req,res)=>{
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return res.status(503).json({message:'Webhook is not configured',code:'WEBHOOK_UNCONFIGURED'});
  if (!verifyWebhookSignature(req.body,req.get('X-Razorpay-Signature'),process.env.RAZORPAY_WEBHOOK_SECRET)) return res.status(400).json({message:'Invalid webhook signature',code:'WEBHOOK_SIGNATURE_INVALID'});
  let payload;
  try { payload=JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({message:'Invalid webhook body'}); }
  const eventId=String(req.get('X-Razorpay-Event-Id') || createHash('sha256').update(req.body).digest('hex'));
  if (eventId.length>150) return res.status(400).json({message:'Invalid webhook event id'});
  res.json(await websiteBookingService.processWebhook(payload,eventId));
});
