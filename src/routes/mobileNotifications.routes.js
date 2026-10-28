import express from 'express';
import pool from '../config/db.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import { mobileMessaging, pushEnabled } from '../services/mobilePush.service.js';

export function createMobileNotificationsRouter({db = pool, authenticate = authMiddleware, enabled = pushEnabled, messaging = mobileMessaging} = {}) {
  const router = express.Router();
  router.use(authenticate);
  router.get('/status', async (req,res) => {
    if (String(req.user?.role || '').toLowerCase() !== 'super_admin') return res.status(403).json({message:'Only the super admin can view notification status.'});
    res.set('Cache-Control','private, no-store');
    const isEnabled=enabled(), firebaseConfigured=Boolean(messaging());
    let schemaReady=true, pendingEvents=null, registeredDevices=null, failedDeliveries=null;
    try {
      const {rows}=await db.query(`SELECT (SELECT count(*)::int FROM booking_mobile_push_devices) AS devices,
        (SELECT count(*)::int FROM booking_mobile_push_events WHERE expanded_at IS NULL) +
        (SELECT count(*)::int FROM booking_mobile_push_deliveries WHERE state='pending') AS pending,
        (SELECT count(*)::int FROM booking_mobile_push_deliveries WHERE state='failed') AS failed`);
      registeredDevices=rows[0].devices; pendingEvents=rows[0].pending; failedDeliveries=rows[0].failed;
    } catch (e) {
      if (e.code !== '42P01') return res.status(503).json({message:'Notification status is temporarily unavailable.'});
      schemaReady=false;
    }
    return res.json({enabled:isEnabled,firebaseConfigured,schemaReady,pendingEvents,registeredDevices,failedDeliveries,
      workerMode: isEnabled && firebaseConfigured ? 'in-process' : 'disabled'});
  });
  return router;
}
export default createMobileNotificationsRouter();
