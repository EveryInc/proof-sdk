/**
 * InnoTM: gedeelde afspraken tussen consultants.
 *
 * Uitbreiding voor de Proof-server (innomd-proof). Bewaart per ERP-aanvraag
 * alleen de afspraakstatus en de meetingdatum, met wie het als laatste
 * wijzigde. Geen klantnamen, geen documenten.
 *
 * Koppelen in server/index.ts (direct onder `const app = express();`):
 *
 *   import { innotmRouter } from './innotm-afspraken.js';
 *   app.use('/api/innotm', express.json({ limit: '256kb' }), innotmRouter());
 *
 * Opslag: een eigen SQLite-bestand, standaard /home/data/innotm.sqlite (of
 * INNOTM_DB). Los van de Proof-database, zodat InnoTM en de documenten elkaar
 * niet raken. Gebruikt better-sqlite3, dat Proof al als dependency heeft.
 */
import express, { type Request, type Router } from 'express';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

type Db = Database.Database;

const MAX_PER_VERZOEK = 500;
const GELDIGE_STATUSSEN = new Set(['maken', 'optie', 'gemaakt', '']);
const ERP_ID = /^[0-9a-fA-F-]{36}(#vragenbrief)?$/;
const DATUM = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

export interface Afspraak {
  erp_id: string;
  afspraak_status: string;
  datum_meeting: string | null;
  gewijzigd_op: string;
  gewijzigd_door: string | null;
}

export function openDatabase(pad: string = process.env.INNOTM_DB || '/home/data/innotm.sqlite'): Db {
  if (pad !== ':memory:') fs.mkdirSync(path.dirname(pad), { recursive: true });
  const db = new Database(pad);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS afspraken (
      erp_id          TEXT PRIMARY KEY,
      afspraak_status TEXT NOT NULL,
      datum_meeting   TEXT,
      gewijzigd_op    TEXT NOT NULL,
      gewijzigd_door  TEXT
    );
    -- Volledige historie: wie zette wat wanneer. Nooit bijgewerkt, alleen aangevuld.
    CREATE TABLE IF NOT EXISTS afspraken_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      erp_id          TEXT NOT NULL,
      afspraak_status TEXT NOT NULL,
      datum_meeting   TEXT,
      gewijzigd_op    TEXT NOT NULL,
      gewijzigd_door  TEXT
    );
  `);
  return db;
}

export class Fout extends Error {
  constructor(public status: number, bericht: string) {
    super(bericht);
  }
}

/** Wie is er ingelogd? Easy Auth zet deze header na een geldige Entra-login. */
function gebruikerUit(req: Request): string | null {
  return req.get('x-ms-client-principal-name') || null;
}

/**
 * Een versie die per record altijd oploopt, ook bij twee schrijfacties in
 * dezelfde milliseconde. InnoTM vergelijkt versies op gelijkheid; een gelijke
 * versie bij een andere waarde zou een wijziging verbergen.
 */
export function volgendeVersie(vorige: string | undefined, nu: Date = new Date()): string {
  let t = nu.getTime();
  if (vorige) {
    const v = Date.parse(vorige);
    if (!Number.isNaN(v) && t <= v) t = v + 1;
  }
  return new Date(t).toISOString();
}

export function zoek(db: Db, body: any): { afspraken: Afspraak[] } {
  const ids = body?.erp_ids;
  if (!Array.isArray(ids)) throw new Fout(400, 'Verwacht { erp_ids: [...] }');
  if (ids.length > MAX_PER_VERZOEK) throw new Fout(400, `Maximaal ${MAX_PER_VERZOEK} erp_ids per verzoek`);
  for (const id of ids) {
    if (typeof id !== 'string' || !ERP_ID.test(id)) throw new Fout(400, `Ongeldige erp_id: ${String(id).slice(0, 60)}`);
  }
  const stmt = db.prepare(
    'SELECT erp_id, afspraak_status, datum_meeting, gewijzigd_op, gewijzigd_door FROM afspraken WHERE erp_id = ?',
  );
  const afspraken: Afspraak[] = [];
  for (const id of new Set<string>(ids)) {
    const rij = stmt.get(id) as Afspraak | undefined;
    if (rij) afspraken.push({ ...rij, datum_meeting: rij.datum_meeting ?? null });
  }
  return { afspraken };
}

export function bewaar(db: Db, body: any, gebruiker: string, nu: Date = new Date()): { afspraken: Afspraak[] } {
  const lijst = body?.afspraken;
  if (!Array.isArray(lijst)) throw new Fout(400, 'Verwacht { afspraken: [...] }');
  if (lijst.length > MAX_PER_VERZOEK) throw new Fout(400, `Maximaal ${MAX_PER_VERZOEK} afspraken per verzoek`);
  for (const a of lijst) {
    if (!a || typeof a.erp_id !== 'string' || !ERP_ID.test(a.erp_id)) throw new Fout(400, 'Ongeldige erp_id');
    if (typeof a.afspraak_status !== 'string' || !GELDIGE_STATUSSEN.has(a.afspraak_status)) {
      throw new Fout(400, `Ongeldige afspraak_status voor ${a.erp_id}`);
    }
    const d = a.datum_meeting;
    if (d !== undefined && d !== null && (typeof d !== 'string' || d.length > 40 || !DATUM.test(d))) {
      throw new Fout(400, `Ongeldige datum_meeting voor ${a.erp_id}`);
    }
  }

  const huidig = db.prepare('SELECT gewijzigd_op FROM afspraken WHERE erp_id = ?');
  const schrijf = db.prepare(`
    INSERT INTO afspraken (erp_id, afspraak_status, datum_meeting, gewijzigd_op, gewijzigd_door)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(erp_id) DO UPDATE SET
      afspraak_status = excluded.afspraak_status,
      datum_meeting   = excluded.datum_meeting,
      gewijzigd_op    = excluded.gewijzigd_op,
      gewijzigd_door  = excluded.gewijzigd_door`);
  const log = db.prepare(`INSERT INTO afspraken_log (erp_id, afspraak_status, datum_meeting, gewijzigd_op, gewijzigd_door)
                          VALUES (?, ?, ?, ?, ?)`);

  // Alles of niets: één transactie voor de hele lijst.
  const alles = db.transaction((items: any[]): Afspraak[] =>
    items.map((a) => {
      const vorige = (huidig.get(a.erp_id) as { gewijzigd_op: string } | undefined)?.gewijzigd_op;
      const versie = volgendeVersie(vorige, nu);
      const datum: string | null = a.datum_meeting ?? null;
      schrijf.run(a.erp_id, a.afspraak_status, datum, versie, gebruiker);
      log.run(a.erp_id, a.afspraak_status, datum, versie, gebruiker);
      return { erp_id: a.erp_id, afspraak_status: a.afspraak_status, datum_meeting: datum,
               gewijzigd_op: versie, gewijzigd_door: gebruiker };
    }),
  );
  return { afspraken: alles(lijst) };
}

/** Express-router voor /api/innotm. */
export function innotmRouter(db: Db = openDatabase()): Router {
  const r = express.Router();

  // Alleen ingelogde gebruikers (Easy Auth). Zonder deze header is de
  // aanvraag niet langs Entra gegaan: weigeren, ook als Easy Auth per
  // ongeluk op "anoniem toestaan" staat.
  r.use((req, res, next) => {
    const gebruiker = gebruikerUit(req);
    if (!gebruiker) {
      res.status(401).json({ fout: 'Niet ingelogd' });
      return;
    }
    res.locals.innotmGebruiker = gebruiker;
    next();
  });

  const afhandelen = (fn: (req: Request, gebruiker: string) => unknown) =>
    (req: Request, res: express.Response) => {
      try {
        res.json(fn(req, res.locals.innotmGebruiker as string));
      } catch (e) {
        const status = e instanceof Fout ? e.status : 500;
        if (status === 500) console.error('innotm-afspraken', e);
        res.status(status).json({ fout: status === 500 ? 'Interne fout' : (e as Error).message });
      }
    };

  r.post('/afspraken/zoek', afhandelen((req) => zoek(db, req.body)));
  r.put('/afspraken', afhandelen((req, gebruiker) => bewaar(db, req.body, gebruiker)));
  return r;
}
