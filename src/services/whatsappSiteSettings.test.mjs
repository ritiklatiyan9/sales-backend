import test from 'node:test';
import assert from 'node:assert/strict';
import { drawFixture } from '../test/drawFixture.mjs';
import { migrateWhatsAppMessages } from '../migrations/039_whatsapp_messages.js';
import { migrateWhatsAppStudio } from '../migrations/040_whatsapp_studio.js';
import { migrateWhatsAppMarketing } from '../migrations/041_whatsapp_marketing.js';
import { migrateWhatsAppTemplateManagement } from '../migrations/042_whatsapp_template_management.js';
import { activateRequestedSiteTemplates, compileBody, drainWhatsApp, saveStage, studioState, updateTemplate } from './whatsapp.service.js';

test('project overrides route only that project to its professional template, with explicit pause and unapply', async () => {
  const f = await drawFixture();
  const savedPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const sent = [];
  const send = async (phone, template) => { sent.push({ phone, template }); return `scope-${sent.length}`; };
  try {
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    for (const migrate of [migrateWhatsAppMessages, migrateWhatsAppStudio, migrateWhatsAppMarketing]) await migrate(f.pool);
    await f.db.exec(`ALTER TABLE members ADD COLUMN whatsapp TEXT;
      UPDATE whatsapp_templates SET status='APPROVED';
      INSERT INTO members(id,site_id,member_type,full_name,phone) VALUES
        (101,1,'CLIENT','First Buyer','9811111111'),(102,2,'CLIENT','Second Buyer','9822222222');
      INSERT INTO kyc_cases(id,client_member_id,site_id,status) VALUES(201,101,1,'VERIFIED'),(202,102,2,'VERIFIED');`);
    await migrateWhatsAppTemplateManagement(f.pool);
    const body = 'Dear {customer_name}, your verification at {project} is complete. Member ID: {member_id}. Defence Garden Group';
    await f.query(`INSERT INTO whatsapp_templates(event,version,name,body,fields,status)
      VALUES('KYC_VERIFIED',2,'professional_site_1',$1,$2,'APPROVED')`, [body, compileBody('KYC_VERIFIED', body).fields]);
    const sharedBefore = (await f.query('SELECT * FROM whatsapp_stage_settings ORDER BY event')).rows;
    await saveStage('KYC_VERIFIED', { site_id: 1, template_name: 'professional_site_1' }, 1, f.pool);
    assert.deepEqual((await f.query('SELECT * FROM whatsapp_stage_settings ORDER BY event')).rows, sharedBefore);
    assert.equal((await studioState(f.pool, { siteId: 1 })).stages.find(s => s.key === 'KYC_VERIFIED').active_template.name, 'professional_site_1');
    assert.equal((await studioState(f.pool, { siteId: 2 })).stages.find(s => s.key === 'KYC_VERIFIED').active_template.name, 'dgg_kyc_verified');
    await f.query(`INSERT INTO whatsapp_messages(dedupe_key,event,ref_id) VALUES('scope:1','KYC_VERIFIED',201),('scope:2','KYC_VERIFIED',202)`);
    await drainWhatsApp({ db: f.pool, send });
    assert.deepEqual(sent.map(s => s.template), ['professional_site_1', 'dgg_kyc_verified']);
    await assert.rejects(updateTemplate('professional_site_1', { archived: true }, f.pool), /applied to a project/);
    await assert.rejects(saveStage('KYC_VERIFIED', { site_id: 1, template_name: 'dgg_booking_confirmed' }, 1, f.pool), /created for this module/);
    await saveStage('KYC_VERIFIED', { site_id: 1, enabled: false }, 1, f.pool);
    await f.query(`INSERT INTO whatsapp_messages(dedupe_key,event,ref_id) VALUES('scope:1:paused','KYC_VERIFIED',201),('scope:2:still-on','KYC_VERIFIED',202)`);
    await drainWhatsApp({ db: f.pool, send });
    assert.deepEqual(sent.map(s => s.template), ['professional_site_1', 'dgg_kyc_verified', 'dgg_kyc_verified']);
    await saveStage('KYC_VERIFIED', { site_id: 1, enabled: true, template_name: null }, 1, f.pool);
    await f.query(`INSERT INTO whatsapp_messages(dedupe_key,event,ref_id) VALUES('scope:1:unapplied','KYC_VERIFIED',201)`);
    await drainWhatsApp({ db: f.pool, send });
    assert.equal(sent.length, 3, 'explicit unapply never falls back to the shared template');
    const studio = await studioState(f.pool, { siteId: 1 });
    assert.equal(studio.stages.find(s => s.key === 'KYC_VERIFIED').active_template, null);
    assert.ok(studio.recent.every(m => m.ref_id === 201), 'project activity excludes other sites');
    assert.deepEqual((await f.query('SELECT * FROM whatsapp_stage_settings ORDER BY event')).rows, sharedBefore);
    await assert.rejects(saveStage('KYC_VERIFIED', { site_id: '1x' }, 1, f.pool), /valid project/);
    await assert.rejects(saveStage('KYC_VERIFIED', { site_id: 999 }, 1, f.pool), /Project not found/);
    await f.query(`INSERT INTO whatsapp_templates(event,version,name,body,fields,status)
      VALUES('KYC_VERIFIED',3,'professional_pending',$1,$2,'PENDING')`, [body, compileBody('KYC_VERIFIED', body).fields]);
    await saveStage('KYC_VERIFIED', { site_id: 1, template_name: 'dgg_kyc_verified', requested_template_name: 'professional_pending' }, 1, f.pool);
    assert.equal(await activateRequestedSiteTemplates(f.pool), 0, 'a pending template must never send');
    assert.equal((await studioState(f.pool, { siteId: 1 })).stages.find(s => s.key === 'KYC_VERIFIED').requested_template.name, 'professional_pending');
    await assert.rejects(updateTemplate('professional_pending', { archived: true }, f.pool), /applied to a project/);
    await f.query("UPDATE whatsapp_templates SET status='APPROVED' WHERE name='professional_pending'");
    assert.equal(await activateRequestedSiteTemplates(f.pool), 1);
    assert.equal((await studioState(f.pool, { siteId: 1 })).stages.find(s => s.key === 'KYC_VERIFIED').active_template.name, 'professional_pending');
    assert.equal(await activateRequestedSiteTemplates(f.pool), 0, 'activation is idempotent');
    await saveStage('KYC_VERIFIED', { site_id: 1, requested_template_name: 'professional_site_1' }, 1, f.pool);
    await saveStage('KYC_VERIFIED', { site_id: 1, enabled: false }, 1, f.pool);
    assert.equal(await activateRequestedSiteTemplates(f.pool), 0, 'pausing cancels a pending replacement');
    assert.deepEqual((await f.query('SELECT * FROM whatsapp_stage_settings ORDER BY event')).rows, sharedBefore);
  } finally {
    if (savedPhone === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID; else process.env.WHATSAPP_PHONE_NUMBER_ID = savedPhone;
    await f.close();
  }
});
