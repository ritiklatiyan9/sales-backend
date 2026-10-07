import { readFile } from 'node:fs/promises';
import pool from '../config/db.js';
import { validateApplicationTemplate, requirePublishableTemplate } from '../services/applicationFormTemplate.js';
import { DEFAULT_DRAW_TERMS } from '../services/drawWorkflow.js';

try {
  const {rows} = await pool.query(`SELECT s.id,s.name,p.draw_terms,p.company_brand_name,p.company_legal_name,p.logo_url FROM sites s LEFT JOIN project_settings p ON p.site_id=s.id WHERE s.name='Mount Valley Residency'`);
  if (rows.length !== 1) throw new Error('Expected exactly one Mount Valley Residency site; no template was changed.');
  const site=rows[0];
  const seed=JSON.parse(await readFile(new URL('../seeds/mount-valley-application.json',import.meta.url),'utf8'));
  const template=validateApplicationTemplate({...seed,terms:site.draw_terms||DEFAULT_DRAW_TERMS,brand_name:site.company_brand_name||seed.brand_name,legal_name:site.company_legal_name||'',logo_url:site.logo_url||''});
  requirePublishableTemplate(template);
  const saved=await pool.query(`INSERT INTO application_form_templates(site_id,draft,published,published_revision,published_at) VALUES($1,$2,$2,1,now()) ON CONFLICT(site_id) DO NOTHING RETURNING site_id`,[site.id,JSON.stringify(template)]);
  console.log(saved.rows.length ? `Mount Valley form published for site ${site.id}. Existing issued terms preserved.` : 'This site already has a template; existing work preserved.');
} catch(error) { console.error(error.message);process.exitCode=1; }
finally { await pool.end(); }
