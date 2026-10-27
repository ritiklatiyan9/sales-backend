import { createHash } from 'node:crypto';
import express from 'express';
import pool from '../config/db.js';
import { createBrokerMobileService } from '../services/brokerMobile.service.js';
import { normalizeLoginIdentifier } from '../services/staffIdentity.service.js';
import { MOBILE_SESSION_DAYS } from '../services/mobilePortal.service.js';
import { mobilePortalEnabled, sendPortfolioJson } from './mobilePortal.routes.js';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';
import { mailerEnabled } from '../services/mailer.service.js';

export function createBrokerMobileLoginLimiter({ now = Date.now, windowMs = 15*60*1000, maxEntries = 10000 } = {}) {
  const entries = new Map();
  return (req, res, next) => {
    const time = now();
    for (const [key, entry] of entries) if (entry.until<=time) entries.delete(key);
    const identifier = normalizeLoginIdentifier(req.body?.identifier ?? req.body?.mobile)?.value || 'invalid';
    const keys = [
      [createHash('sha256').update(`ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`).digest('hex'),40],
      [createHash('sha256').update(`broker:${identifier}`).digest('hex'),10],
    ];
    for (const [key,max] of keys) {
      const entry=entries.get(key);
      if ((entry?.count||0)>=max || (!entry&&entries.size>=maxEntries)) {
        res.set('Retry-After',String(Math.ceil(((entry?.until||time+windowMs)-time)/1000)));
        return res.status(429).json({ message:'Too many sign-in attempts. Please try again shortly.' });
      }
    }
    for (const [key] of keys) { const entry=entries.get(key)||{count:0,until:time+windowMs}; entry.count++; entries.set(key,entry); }
    next();
  };
}

export function createBrokerMobileRouter(service, {
  loginLimiter=createBrokerMobileLoginLimiter(), isEnabled=()=>mobilePortalEnabled(),
  resetRequestLimiter=createBrokerMobileLoginLimiter(),
  resetConfirmLimiter=rateLimit({limit:30,windowMs:15*60*1000,key:req=>`${req.ip}:${req.body?.challengeId||'invalid'}`}),
  passwordChangeLimiter=rateLimit({limit:10,windowMs:15*60*1000,key:req=>req.brokerSession?.account?.id||req.ip}),
}={}) {
  const router=express.Router();
  const run=handler=>(req,res,next)=>Promise.resolve(handler(req,res,next)).catch(error=>{
    const status=[400,401,403,404,429,503].includes(error.statusCode)?error.statusCode:503;
    res.status(status).json({ message: status===503?'The service is temporarily unavailable. Please try again.':error.message });
  });
  router.use((_req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
  router.get('/status',(_req,res)=>res.json({service:'my-real-assets-broker',apiVersion:1,authVersion:2,portfolioVersion:3,confidentialPresentation:true,commissionLinkedPlots:service.features?.commissionLinkedPlots??true,enabled:Boolean(isEnabled()),sessionDurationDays:MOBILE_SESSION_DAYS,passwordReset:'registered-email-otp',recoveryEmailEnabled:mailerEnabled()}));
  router.use((_req,res,next)=>{
    if(!isEnabled())return res.status(503).json({code:'MOBILE_PORTAL_DISABLED',message:'Partner access is temporarily unavailable.'});
    next();
  });
  router.post('/auth/login',loginLimiter,run(async(req,res)=>res.json(await service.login(req.body))));
  router.post('/auth/password-reset/request',resetRequestLimiter,run(async(req,res)=>res.json(await service.requestPasswordReset(req.body))));
  router.post('/auth/password-reset/confirm',resetConfirmLimiter,run(async(req,res)=>res.json(await service.confirmPasswordReset(req.body))));
  router.use(run(async(req,res,next)=>{
    const authorization=req.get('Authorization');
    if(!/^Bearer [A-Za-z0-9_.-]+$/.test(authorization||'')||authorization.length>4096)return res.status(401).json({message:'Please sign in again.'});
    req.brokerSession=await service.getSession(authorization.slice(7));next();
  }));
  const fresh=req=>/(?:^|,)\s*(?:no-cache|no-store|max-age=0)\s*(?:,|$)/i.test(req.get('Cache-Control')||'');
  router.get('/me',(req,res)=>res.json({user:req.brokerSession.user}));
  router.post('/auth/password/change',passwordChangeLimiter,run(async(req,res)=>res.json(await service.changePassword(req.brokerSession,req.body))));
  router.get('/portfolio',run(async(req,res)=>sendPortfolioJson(req,res,await service.portfolio(req.brokerSession,{forceFresh:fresh(req)}))));
  router.get('/plots/:id',run(async(req,res)=>sendPortfolioJson(req,res,await service.plot(req.brokerSession,req.params.id,{forceFresh:fresh(req)}))));
  return router;
}

export default createBrokerMobileRouter(createBrokerMobileService(pool));
