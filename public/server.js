'use strict';

require('./env');

const express       = require('express');
const { Pool }      = require('pg');
const bcrypt        = require('bcryptjs');
const jwt           = require('jsonwebtoken');
const multer        = require('multer');
const path          = require('path');
const fs            = require('fs');
const { randomBytes } = require('crypto');
const nodemailer    = require('nodemailer');
const { plzDistanzKm } = require('./plz-data');

const app        = express();
const PORT       = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-bitte-aendern';

// ===== MAIL =====
const mailer = nodemailer.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    auth: {
        user: process.env.BREVO_SMTP_USER,
        pass: process.env.BREVO_SMTP_PASS
    }
});

async function sendMail(to, subject, html) {
    if (!to || !process.env.BREVO_SMTP_PASS) return;
    try {
        await mailer.sendMail({
            from: `RessourcenPool <${process.env.MAIL_FROM || process.env.BREVO_SMTP_USER}>`,
            to, subject, html
        });
    } catch (err) {
        console.warn('Mail nicht gesendet:', err.message);
    }
}
const MAX_BILDER = 5;

// ===== DATENBANK =====
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ===== BILD-UPLOAD =====
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename:    (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Nur Bilddateien erlaubt'));
    }
});

// ===== MIDDLEWARE =====
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===== AUTH =====
function authenticate(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Nicht authentifiziert' });
    }
    try {
        req.user = jwt.verify(header.slice(7), JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Token ungültig oder abgelaufen' });
    }
}

function requireAdmin(req, res, next) {
    if (req.user.role !== 'betreiber') {
        return res.status(403).json({ error: 'Nur für Betreiber' });
    }
    next();
}

// ===== SERVER-SENT EVENTS =====
const sseClients = new Set();

app.get('/api/events', authenticate, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(':connected\n\n');

    sseClients.add(res);

    const heartbeat = setInterval(() => {
        try { res.write(':heartbeat\n\n'); } catch { clearInterval(heartbeat); }
    }, 25000);

    req.on('close', () => {
        sseClients.delete(res);
        clearInterval(heartbeat);
    });
});

function broadcast(event = 'update') {
    const msg = `event: ${event}\ndata: {}\n\n`;
    for (const res of sseClients) {
        try { res.write(msg); } catch { sseClients.delete(res); }
    }
}

// ===== AUTH ROUTES =====

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Fehlende Felder' });

    try {
        const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = rows[0];
        if (!user) return res.status(401).json({ error: 'Falscher Benutzername oder Passwort' });

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Falscher Benutzername oder Passwort' });

        const token = jwt.sign(
            { userId: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '30d' }
        );
        res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
    } catch (err) {
        console.error('Login-Fehler:', err);
        res.status(500).json({ error: 'Serverfehler' });
    }
});

app.get('/api/auth/me', authenticate, (req, res) => res.json(req.user));

// ===== TAGS =====

app.get('/api/tags', authenticate, async (req, res) => {
    const { rows } = await pool.query('SELECT name FROM tags ORDER BY name');
    res.json(rows.map(r => r.name));
});

app.post('/api/tags', authenticate, requireAdmin, async (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name fehlt' });
    try {
        await pool.query('INSERT INTO tags (name) VALUES ($1) ON CONFLICT DO NOTHING', [name.trim()]);
        broadcast();
        res.json({ ok: true });
    } catch {
        res.status(500).json({ error: 'Fehler' });
    }
});

app.delete('/api/tags/:name', authenticate, requireAdmin, async (req, res) => {
    const name = decodeURIComponent(req.params.name);
    await pool.query('DELETE FROM ressource_tags WHERE tag_name = $1', [name]);
    await pool.query('DELETE FROM tags WHERE name = $1', [name]);
    broadcast();
    res.json({ ok: true });
});

app.post('/api/tags/:name/merge', authenticate, requireAdmin, async (req, res) => {
    const source = decodeURIComponent(req.params.name);
    const { target } = req.body;
    if (!target || !target.trim()) return res.status(400).json({ error: 'Ziel-Tag fehlt' });
    if (source === target.trim()) return res.status(400).json({ error: 'Quelle und Ziel sind identisch' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('INSERT INTO tags (name) VALUES ($1) ON CONFLICT DO NOTHING', [target.trim()]);
        await client.query(
            `INSERT INTO ressource_tags (ressource_id, tag_name)
             SELECT ressource_id, $1 FROM ressource_tags WHERE tag_name = $2
             ON CONFLICT DO NOTHING`,
            [target.trim(), source]
        );
        await client.query('DELETE FROM ressource_tags WHERE tag_name = $1', [source]);
        await client.query('DELETE FROM tags WHERE name = $1', [source]);
        await client.query('COMMIT');
        broadcast();
        res.json({ ok: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Tag merge:', err);
        res.status(500).json({ error: 'Fehler beim Zusammenführen' });
    } finally {
        client.release();
    }
});

// ===== RESSOURCEN =====

app.get('/api/ressourcen', authenticate, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT
                r.*,
                array_agg(DISTINCT rt.tag_name)
                    FILTER (WHERE rt.tag_name IS NOT NULL) AS tags,
                json_agg(
                    json_build_object(
                        'id',        b.id,
                        'pfad',      b.bild_pfad,
                        'position',  b.position
                    ) ORDER BY b.position
                ) FILTER (WHERE b.id IS NOT NULL) AS bilder,
                json_agg(
                    json_build_object(
                        'id',              a.id,
                        'mitgliedId',      a.mitglied_id,
                        'mitgliedName',    m.name,
                        'mitgliedPlz',     m.plz,
                        'nachricht',       a.nachricht,
                        'status',          a.status,
                        'erstelltAm',      a.erstellt_am,
                        'kontaktEntleiher',a.kontakt_entleiher,
                        'versandGewuenscht',a.versand_gewuenscht,
                        'versandAdresse',  a.versand_adresse,
                        'kontaktVerleiher',a.kontakt_verleiher
                    )
                ) FILTER (WHERE a.id IS NOT NULL) AS anfragen
            FROM ressourcen r
            LEFT JOIN ressource_tags  rt ON rt.ressource_id = r.id
            LEFT JOIN ressource_bilder b ON b.ressource_id  = r.id
            LEFT JOIN anfragen a          ON a.ressource_id  = r.id
            LEFT JOIN mitglieder m        ON m.id = a.mitglied_id
            GROUP BY r.id
            ORDER BY r.erstellt_am DESC
        `);

        res.json(rows.map(r => ({
            id:             r.id,
            name:           r.name,
            beschreibung:   r.beschreibung,
            bilder:         (r.bilder || []).map(b => ({ id: b.id, url: `/uploads/${b.pfad}`, position: b.position })),
            plz:            r.plz,
            typ:            r.typ,
            status:         r.status,
            anfragen:       r.anfragen || [],
            ausgeliehenAn:  r.ausgeliehen_an,
            bestaetigtFuer: r.bestaetigt_fuer,
            kontakt:        r.kontakt,
            erstelltVon:    r.erstellt_von,
            erstelltAm:     r.erstellt_am,
            tags:           r.tags || []
        })));
    } catch (err) {
        console.error('Ressourcen laden:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

app.post('/api/ressourcen', authenticate, upload.array('bilder', MAX_BILDER), async (req, res) => {
    const { name, typ, beschreibung, plz, tags } = req.body;
    if (!name || !plz) return res.status(400).json({ error: 'Name und PLZ erforderlich' });

    let tagList = [];
    if (tags) {
        try { tagList = JSON.parse(tags); } catch { tagList = Array.isArray(tags) ? tags : [tags]; }
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows } = await client.query(
            `INSERT INTO ressourcen (name, beschreibung, plz, typ, erstellt_von)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [name, beschreibung || null, plz, typ || 'verleihen', req.user.userId]
        );
        const id = rows[0].id;

        // Bilder speichern
        for (let i = 0; i < (req.files || []).length; i++) {
            await client.query(
                'INSERT INTO ressource_bilder (ressource_id, bild_pfad, position) VALUES ($1, $2, $3)',
                [id, req.files[i].filename, i]
            );
        }

        // Tags
        for (const tag of tagList) {
            await client.query('INSERT INTO tags (name) VALUES ($1) ON CONFLICT DO NOTHING', [tag]);
            await client.query(
                'INSERT INTO ressource_tags (ressource_id, tag_name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [id, tag]
            );
        }

        await client.query('COMMIT');
        broadcast();
        res.json({ id });

        // Suchagenten prüfen und Mails senden (async, blockiert nicht)
        pruefeUndMaileSuchagenten({ id, name, beschreibung: beschreibung || '', typ: typ || 'verleihen', tags: tagList });
    } catch (err) {
        await client.query('ROLLBACK');
        (req.files || []).forEach(f => deleteUpload(f.filename));
        console.error('Ressource anlegen:', err);
        res.status(500).json({ error: 'Fehler beim Speichern' });
    } finally {
        client.release();
    }
});

// Zusätzliche Bilder zu bestehender Ressource hinzufügen
app.post('/api/ressourcen/:id/bilder', authenticate, upload.array('bilder', MAX_BILDER), async (req, res) => {
    const { id } = req.params;
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Keine Bilder' });

    try {
        const r = await pool.query('SELECT erstellt_von FROM ressourcen WHERE id = $1', [id]);
        if (!r.rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
        if (r.rows[0].erstellt_von !== req.user.userId && req.user.role !== 'betreiber') {
            (req.files || []).forEach(f => deleteUpload(f.filename));
            return res.status(403).json({ error: 'Keine Berechtigung' });
        }

        // Aktuelle Anzahl prüfen
        const countRes = await pool.query('SELECT COUNT(*) FROM ressource_bilder WHERE ressource_id = $1', [id]);
        const current = parseInt(countRes.rows[0].count);
        const canAdd = MAX_BILDER - current;
        if (canAdd <= 0) return res.status(400).json({ error: `Maximal ${MAX_BILDER} Bilder erlaubt` });

        const posRes = await pool.query('SELECT COALESCE(MAX(position), -1) AS maxpos FROM ressource_bilder WHERE ressource_id = $1', [id]);
        let nextPos = posRes.rows[0].maxpos + 1;

        for (let i = 0; i < Math.min(req.files.length, canAdd); i++) {
            await pool.query(
                'INSERT INTO ressource_bilder (ressource_id, bild_pfad, position) VALUES ($1, $2, $3)',
                [id, req.files[i].filename, nextPos++]
            );
        }

        broadcast();
        res.json({ ok: true });
    } catch (err) {
        (req.files || []).forEach(f => deleteUpload(f.filename));
        console.error('Bild hinzufügen:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

// Einzelnes Bild löschen
app.delete('/api/ressourcen/:id/bilder/:bid', authenticate, async (req, res) => {
    const { id, bid } = req.params;
    try {
        const r = await pool.query('SELECT erstellt_von FROM ressourcen WHERE id = $1', [id]);
        if (!r.rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
        if (r.rows[0].erstellt_von !== req.user.userId && req.user.role !== 'betreiber') {
            return res.status(403).json({ error: 'Keine Berechtigung' });
        }

        const b = await pool.query('SELECT bild_pfad FROM ressource_bilder WHERE id = $1 AND ressource_id = $2', [bid, id]);
        if (!b.rows[0]) return res.status(404).json({ error: 'Bild nicht gefunden' });

        deleteUpload(b.rows[0].bild_pfad);
        await pool.query('DELETE FROM ressource_bilder WHERE id = $1', [bid]);

        // Positionen neu nummerieren
        const remaining = await pool.query('SELECT id FROM ressource_bilder WHERE ressource_id = $1 ORDER BY position', [id]);
        for (let i = 0; i < remaining.rows.length; i++) {
            await pool.query('UPDATE ressource_bilder SET position = $1 WHERE id = $2', [i, remaining.rows[i].id]);
        }

        broadcast();
        res.json({ ok: true });
    } catch (err) {
        console.error('Bild löschen:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

app.delete('/api/ressourcen/:id', authenticate, async (req, res) => {
    const { id } = req.params;
    try {
        const { rows } = await pool.query('SELECT * FROM ressourcen WHERE id = $1', [id]);
        if (!rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });

        if (rows[0].erstellt_von !== req.user.userId && req.user.role !== 'betreiber') {
            return res.status(403).json({ error: 'Keine Berechtigung' });
        }

        const bilder = await pool.query('SELECT bild_pfad FROM ressource_bilder WHERE ressource_id = $1', [id]);
        bilder.rows.forEach(b => deleteUpload(b.bild_pfad));

        await pool.query('DELETE FROM ressourcen WHERE id = $1', [id]);
        broadcast();
        res.json({ ok: true });
    } catch (err) {
        console.error('Ressource löschen:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

// ===== ANFRAGEN =====

app.post('/api/ressourcen/:id/anfragen', authenticate, async (req, res) => {
    const { id } = req.params;
    const { nachricht } = req.body;

    try {
        const mRes = await pool.query('SELECT * FROM mitglieder WHERE user_id = $1', [req.user.userId]);
        if (!mRes.rows[0]) return res.status(400).json({ error: 'Kein Mitglied-Profil vorhanden. Bitte Admin kontaktieren.' });
        const mitglied = mRes.rows[0];

        const rRes = await pool.query('SELECT * FROM ressourcen WHERE id = $1', [id]);
        if (!rRes.rows[0]) return res.status(404).json({ error: 'Ressource nicht gefunden' });
        const r = rRes.rows[0];

        if (r.status !== 'verfuegbar' && r.status !== 'angefragt') {
            return res.status(400).json({ error: 'Ressource ist gerade nicht anfragbar' });
        }

        const existing = await pool.query(
            "SELECT id FROM anfragen WHERE ressource_id = $1 AND mitglied_id = $2 AND status = 'offen'",
            [id, mitglied.id]
        );
        if (existing.rows.length > 0) return res.status(400).json({ error: 'Du hast bereits eine offene Anfrage' });

        const { kontaktEntleiher, versandGewuenscht, versandAdresse } = req.body;
        if (!kontaktEntleiher || !kontaktEntleiher.trim()) {
            return res.status(400).json({ error: 'Bitte gib deine Kontaktmöglichkeit an' });
        }

        await pool.query(
            'INSERT INTO anfragen (ressource_id, mitglied_id, nachricht, kontakt_entleiher, versand_gewuenscht, versand_adresse) VALUES ($1, $2, $3, $4, $5, $6)',
            [id, mitglied.id, nachricht || null, kontaktEntleiher.trim(), !!versandGewuenscht, versandAdresse || null]
        );

        if (r.status === 'verfuegbar') {
            await pool.query("UPDATE ressourcen SET status = 'angefragt' WHERE id = $1", [id]);
        }

        broadcast();
        res.json({ ok: true });

        // E-Mail an Ressourcen-Besitzer
        if (r.erstellt_von) {
            const ownerRes = await pool.query('SELECT email FROM users WHERE id = $1', [r.erstellt_von]);
            const ownerEmail = ownerRes.rows[0]?.email;
            if (ownerEmail) {
                sendMail(ownerEmail,
                    `Neue Anfrage für "${r.name}"`,
                    `<p>Hallo,</p>
                    <p><strong>${mitglied.name}</strong> (PLZ ${mitglied.plz}) hat eine Anfrage für deine Ressource <strong>"${r.name}"</strong> gestellt.</p>
                    ${nachricht ? `<p>Nachricht: <em>${nachricht}</em></p>` : ''}
                    <p>Melde dich im RessourcenPool an, um die Anfrage zu bearbeiten.</p>`
                );
            }
        }
    } catch (err) {
        console.error('Anfrage erstellen:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

app.get('/api/ressourcen/:id/anfragen', authenticate, async (req, res) => {
    const { id } = req.params;
    const rRes = await pool.query('SELECT erstellt_von FROM ressourcen WHERE id = $1', [id]);
    if (!rRes.rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
    if (rRes.rows[0].erstellt_von !== req.user.userId && req.user.role !== 'betreiber') {
        return res.status(403).json({ error: 'Keine Berechtigung' });
    }

    const { rows } = await pool.query(`
        SELECT a.*, m.name AS mitglied_name, m.plz AS mitglied_plz
        FROM anfragen a
        JOIN mitglieder m ON m.id = a.mitglied_id
        WHERE a.ressource_id = $1 AND a.status = 'offen'
        ORDER BY a.erstellt_am
    `, [id]);
    res.json(rows);
});

app.post('/api/ressourcen/:id/anfragen/:aid/bestaetigen', authenticate, async (req, res) => {
    const { id, aid } = req.params;
    try {
        const rRes = await pool.query('SELECT * FROM ressourcen WHERE id = $1', [id]);
        if (!rRes.rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
        if (rRes.rows[0].erstellt_von !== req.user.userId && req.user.role !== 'betreiber') {
            return res.status(403).json({ error: 'Keine Berechtigung' });
        }

        const aRes = await pool.query('SELECT * FROM anfragen WHERE id = $1', [aid]);
        if (!aRes.rows[0]) return res.status(404).json({ error: 'Anfrage nicht gefunden' });

        const { kontaktVerleiher } = req.body;
        if (!kontaktVerleiher || !kontaktVerleiher.trim()) {
            return res.status(400).json({ error: 'Bitte gib deine Kontaktmöglichkeit für die Übergabe an' });
        }

        await pool.query("UPDATE anfragen SET status = 'bestaetigt', kontakt_verleiher = $1 WHERE id = $2", [kontaktVerleiher.trim(), aid]);
        await pool.query(
            "UPDATE anfragen SET status = 'abgelehnt' WHERE ressource_id = $1 AND id != $2 AND status = 'offen'",
            [id, aid]
        );
        await pool.query(
            "UPDATE ressourcen SET status = 'uebergabe_ausstehend', bestaetigt_fuer = $1 WHERE id = $2",
            [aRes.rows[0].mitglied_id, id]
        );

        const mRes = await pool.query('SELECT name FROM mitglieder WHERE id = $1', [aRes.rows[0].mitglied_id]);
        broadcast();
        res.json({ ok: true, mitgliedName: mRes.rows[0]?.name });
    } catch (err) {
        console.error('Anfrage bestätigen:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

app.post('/api/ressourcen/:id/anfragen/:aid/ablehnen', authenticate, async (req, res) => {
    const { id, aid } = req.params;
    try {
        await pool.query("UPDATE anfragen SET status = 'abgelehnt' WHERE id = $1", [aid]);
        const { rows } = await pool.query(
            "SELECT COUNT(*) FROM anfragen WHERE ressource_id = $1 AND status = 'offen'", [id]
        );
        const nochOffen = parseInt(rows[0].count);
        if (nochOffen === 0) {
            await pool.query("UPDATE ressourcen SET status = 'verfuegbar' WHERE id = $1", [id]);
        }
        broadcast();
        res.json({ ok: true, nochOffen });
    } catch {
        res.status(500).json({ error: 'Fehler' });
    }
});

app.post('/api/ressourcen/:id/uebergabe-bestaetigen', authenticate, async (req, res) => {
    const { id } = req.params;
    try {
        const { rows } = await pool.query('SELECT * FROM ressourcen WHERE id = $1', [id]);
        if (!rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
        if (rows[0].erstellt_von !== req.user.userId && req.user.role !== 'betreiber') {
            return res.status(403).json({ error: 'Keine Berechtigung' });
        }

        if (rows[0].typ === 'verschenken' || rows[0].typ === 'tauschen' || rows[0].typ === 'verkaufen') {
            const bilder = await pool.query('SELECT bild_pfad FROM ressource_bilder WHERE ressource_id = $1', [id]);
            bilder.rows.forEach(b => deleteUpload(b.bild_pfad));
            await pool.query('DELETE FROM ressourcen WHERE id = $1', [id]);
        } else {
            await pool.query(
                "UPDATE ressourcen SET status = 'ausgeliehen', ausgeliehen_an = bestaetigt_fuer WHERE id = $1", [id]
            );
        }
        broadcast();
        res.json({ ok: true });
    } catch (err) {
        console.error('Übergabe bestätigen:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

app.post('/api/ressourcen/:id/rueckgabe-bestaetigen', authenticate, async (req, res) => {
    const { id } = req.params;
    try {
        const { rows } = await pool.query('SELECT erstellt_von FROM ressourcen WHERE id = $1', [id]);
        if (!rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
        if (rows[0].erstellt_von !== req.user.userId && req.user.role !== 'betreiber') {
            return res.status(403).json({ error: 'Keine Berechtigung' });
        }

        await pool.query(
            "UPDATE ressourcen SET status = 'verfuegbar', ausgeliehen_an = NULL, bestaetigt_fuer = NULL WHERE id = $1", [id]
        );
        await pool.query('DELETE FROM anfragen WHERE ressource_id = $1', [id]);
        broadcast();
        res.json({ ok: true });
    } catch {
        res.status(500).json({ error: 'Fehler' });
    }
});

app.post('/api/ressourcen/:id/rueckgabe-melden', authenticate, async (req, res) => {
    const { id } = req.params;
    try {
        const { rows } = await pool.query('SELECT * FROM ressourcen WHERE id = $1', [id]);
        if (!rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
        if (rows[0].status !== 'ausgeliehen') return res.status(400).json({ error: 'Ressource ist nicht ausgeliehen' });

        const mRes = await pool.query('SELECT id FROM mitglieder WHERE user_id = $1', [req.user.userId]);
        if (!mRes.rows[0] || mRes.rows[0].id !== rows[0].ausgeliehen_an) {
            return res.status(403).json({ error: 'Nur der Entleiher kann die Rückgabe melden' });
        }

        await pool.query("UPDATE ressourcen SET status = 'rueckgabe_ausstehend' WHERE id = $1", [id]);
        broadcast();
        res.json({ ok: true });
    } catch (err) {
        console.error('Rückgabe melden:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

app.post('/api/ressourcen/:id/nicht-zurueck', authenticate, async (req, res) => {
    const { id } = req.params;
    try {
        const { rows } = await pool.query('SELECT erstellt_von FROM ressourcen WHERE id = $1', [id]);
        if (!rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
        if (rows[0].erstellt_von !== req.user.userId && req.user.role !== 'betreiber') {
            return res.status(403).json({ error: 'Keine Berechtigung' });
        }

        await pool.query("UPDATE ressourcen SET status = 'nicht_zurueck' WHERE id = $1", [id]);
        broadcast();
        res.json({ ok: true });
    } catch {
        res.status(500).json({ error: 'Fehler' });
    }
});

// ===== MITGLIEDER =====

app.get('/api/mitglieder', authenticate, async (req, res) => {
    const { rows } = await pool.query(`
        SELECT m.*, u.username AS user_username, u.role AS user_role
        FROM mitglieder m
        LEFT JOIN users u ON u.id = m.user_id
        ORDER BY m.name
    `);
    res.json(rows.map(m => ({
        id: m.id, name: m.name, plz: m.plz,
        userId: m.user_id, erstelltAm: m.erstellt_am
    })));
});

app.post('/api/mitglieder', authenticate, requireAdmin, async (req, res) => {
    const { name, plz, mitUsername, mitPasswort, mitEmail, rolle } = req.body;
    if (!name || !plz) return res.status(400).json({ error: 'Name und PLZ erforderlich' });
    if (mitUsername && mitPasswort && (!mitEmail || !mitEmail.includes('@'))) {
        return res.status(400).json({ error: 'Gültige E-Mail-Adresse für Login-Zugang erforderlich' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        let userId = null;
        if (mitUsername && mitPasswort) {
            const existing = await client.query('SELECT id FROM users WHERE username = $1', [mitUsername]);
            if (existing.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Benutzername bereits vergeben' });
            }
            const hash = await bcrypt.hash(mitPasswort, 12);
            const uRes = await client.query(
                'INSERT INTO users (username, password_hash, email, role) VALUES ($1, $2, $3, $4) RETURNING id',
                [mitUsername, hash, mitEmail.trim(), rolle || 'user']
            );
            userId = uRes.rows[0].id;
        }

        const mRes = await client.query(
            'INSERT INTO mitglieder (name, plz, user_id) VALUES ($1, $2, $3) RETURNING id',
            [name, plz, userId]
        );
        const mitgliedId = mRes.rows[0].id;

        if (userId) {
            await client.query('UPDATE users SET mitglied_id = $1 WHERE id = $2', [mitgliedId, userId]);
        }

        await client.query('COMMIT');
        broadcast();
        res.json({ id: mitgliedId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Mitglied anlegen:', err);
        res.status(500).json({ error: 'Fehler' });
    } finally {
        client.release();
    }
});

app.delete('/api/mitglieder/:id', authenticate, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const borrowed = await pool.query(
        "SELECT id FROM ressourcen WHERE ausgeliehen_an = $1 AND status = 'ausgeliehen'", [id]
    );
    if (borrowed.rows.length > 0) {
        return res.status(400).json({ error: 'Mitglied hat noch ausgeliehene Ressourcen' });
    }
    await pool.query('DELETE FROM mitglieder WHERE id = $1', [id]);
    broadcast();
    res.json({ ok: true });
});

// ===== USERS =====

app.get('/api/users', authenticate, requireAdmin, async (req, res) => {
    const { rows } = await pool.query(
        'SELECT id, username, email, role, mitglied_id, erstellt_am FROM users ORDER BY username'
    );
    res.json(rows.map(u => ({
        id: u.id, username: u.username, email: u.email, role: u.role,
        mitgliedId: u.mitglied_id, erstelltAm: u.erstellt_am
    })));
});

app.post('/api/users', authenticate, requireAdmin, async (req, res) => {
    const { username, password, email, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Gültige E-Mail-Adresse erforderlich' });

    try {
        const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'Benutzername bereits vergeben' });

        const hash = await bcrypt.hash(password, 12);
        const { rows } = await pool.query(
            'INSERT INTO users (username, password_hash, email, role) VALUES ($1, $2, $3, $4) RETURNING id',
            [username, hash, email.trim(), role || 'user']
        );
        res.json({ id: rows[0].id });
    } catch {
        res.status(500).json({ error: 'Fehler' });
    }
});

app.delete('/api/users/:id', authenticate, requireAdmin, async (req, res) => {
    const { id } = req.params;
    if (id === req.user.userId) return res.status(400).json({ error: 'Eigenen Account nicht löschbar' });
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ ok: true });
});

app.patch('/api/users/:id/passwort', authenticate, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Passwort zu kurz (min. 6 Zeichen)' });
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);
    res.json({ ok: true });
});

// ===== PLZ DISTANZ (Client-seitig via plz-data.js, aber auch als API nutzbar) =====
app.get('/api/plz/distanz', authenticate, (req, res) => {
    const { plz1, plz2 } = req.query;
    const km = plzDistanzKm(plz1, plz2);
    res.json({ km });
});

// ===== EXPORT / IMPORT =====

app.get('/api/export', authenticate, requireAdmin, async (req, res) => {
    try {
        const ressRes = await pool.query(`
            SELECT r.*, array_agg(DISTINCT rt.tag_name) FILTER (WHERE rt.tag_name IS NOT NULL) AS tags
            FROM ressourcen r
            LEFT JOIN ressource_tags rt ON rt.ressource_id = r.id
            GROUP BY r.id
        `);
        const mitRes = await pool.query('SELECT * FROM mitglieder');
        const tagRes = await pool.query('SELECT name FROM tags');

        res.json({
            version: '1.1', exportedAt: new Date().toISOString(),
            ressourcen: ressRes.rows, mitglieder: mitRes.rows,
            tags: tagRes.rows.map(t => t.name)
        });
    } catch {
        res.status(500).json({ error: 'Export-Fehler' });
    }
});

app.post('/api/import', authenticate, requireAdmin, async (req, res) => {
    const { ressourcen, mitglieder, tags } = req.body;
    if (!ressourcen) return res.status(400).json({ error: 'Ungültiges Format' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        if (tags) {
            for (const t of tags) {
                await client.query('INSERT INTO tags (name) VALUES ($1) ON CONFLICT DO NOTHING', [t]);
            }
        }

        let mitgliedMap = {};
        if (mitglieder) {
            for (const m of mitglieder) {
                const ex = await client.query('SELECT id FROM mitglieder WHERE name = $1 AND plz = $2', [m.name, m.plz]);
                if (ex.rows.length > 0) {
                    mitgliedMap[m.id] = ex.rows[0].id;
                } else {
                    const ins = await client.query(
                        'INSERT INTO mitglieder (name, plz) VALUES ($1, $2) RETURNING id', [m.name, m.plz]
                    );
                    mitgliedMap[m.id] = ins.rows[0].id;
                }
            }
        }

        let imported = 0;
        for (const r of ressourcen) {
            const ex = await client.query('SELECT id FROM ressourcen WHERE name = $1 AND plz = $2', [r.name, r.plz]);
            if (ex.rows.length > 0) continue;

            const ins = await client.query(
                `INSERT INTO ressourcen (name, beschreibung, plz, typ, status)
                 VALUES ($1, $2, $3, $4, 'verfuegbar') RETURNING id`,
                [r.name, r.beschreibung || null, r.plz, r.typ || 'verleihen']
            );
            const newId = ins.rows[0].id;

            if (r.tags) {
                for (const tag of r.tags) {
                    if (!tag) continue;
                    await client.query('INSERT INTO tags (name) VALUES ($1) ON CONFLICT DO NOTHING', [tag]);
                    await client.query(
                        'INSERT INTO ressource_tags (ressource_id, tag_name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                        [newId, tag]
                    );
                }
            }
            imported++;
        }

        await client.query('COMMIT');
        broadcast();
        res.json({ ok: true, importedRessourcen: imported });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Import-Fehler:', err);
        res.status(500).json({ error: 'Import-Fehler' });
    } finally {
        client.release();
    }
});

// ===== SUCHAGENTEN =====

app.get('/api/suchagenten', authenticate, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT * FROM suchagenten WHERE user_id = $1 ORDER BY erstellt_am',
            [req.user.userId]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Fehler' }); }
});

app.post('/api/suchagenten', authenticate, async (req, res) => {
    const { name, suchbegriff, typ, tags } = req.body;
    if (!name) return res.status(400).json({ error: 'Name erforderlich' });
    try {
        const { rows } = await pool.query(
            `INSERT INTO suchagenten (user_id, name, suchbegriff, typ, tags)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [req.user.userId, name, suchbegriff || null, typ || null, tags || null]
        );
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: 'Fehler' }); }
});

app.delete('/api/suchagenten/:id', authenticate, async (req, res) => {
    try {
        await pool.query('DELETE FROM suchagenten WHERE id = $1 AND user_id = $2', [req.params.id, req.user.userId]);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Fehler' }); }
});

// Treffer abrufen: neue Ressourcen seit letzte_pruefung für alle eigenen Agenten
app.get('/api/suchagenten/treffer', authenticate, async (req, res) => {
    try {
        const agenten = await pool.query(
            'SELECT * FROM suchagenten WHERE user_id = $1',
            [req.user.userId]
        );
        const ressourcen = await pool.query(
            `SELECT r.id, r.name, r.beschreibung, r.plz, r.typ, r.erstellt_am,
                    COALESCE(array_agg(rt.tag_name) FILTER (WHERE rt.tag_name IS NOT NULL), '{}') AS tags
             FROM ressourcen r
             LEFT JOIN ressource_tags rt ON rt.ressource_id = r.id
             GROUP BY r.id`
        );

        const treffer = [];
        for (const agent of agenten.rows) {
            const matches = ressourcen.rows.filter(r => {
                if (new Date(r.erstellt_am) <= new Date(agent.letzte_pruefung)) return false;
                if (agent.typ && r.typ !== agent.typ) return false;
                if (agent.tags && agent.tags.length > 0) {
                    if (!agent.tags.some(t => r.tags.includes(t))) return false;
                }
                if (agent.suchbegriff) {
                    const q = agent.suchbegriff.toLowerCase();
                    if (!r.name.toLowerCase().includes(q) && !(r.beschreibung || '').toLowerCase().includes(q)) return false;
                }
                return true;
            });
            if (matches.length > 0) {
                treffer.push({ agent: { id: agent.id, name: agent.name }, treffer: matches });
            }
        }

        // letzte_pruefung für alle eigenen Agenten aktualisieren
        if (agenten.rows.length > 0) {
            await pool.query(
                'UPDATE suchagenten SET letzte_pruefung = NOW() WHERE user_id = $1',
                [req.user.userId]
            );
        }

        res.json(treffer);
    } catch (err) { res.status(500).json({ error: 'Fehler' }); }
});

// Anzahl ungelesener Treffer (ohne letzte_pruefung zu aktualisieren)
app.get('/api/suchagenten/treffer/anzahl', authenticate, async (req, res) => {
    try {
        const agenten = await pool.query(
            'SELECT * FROM suchagenten WHERE user_id = $1',
            [req.user.userId]
        );
        const ressourcen = await pool.query('SELECT id, name, beschreibung, typ, erstellt_am FROM ressourcen');
        let count = 0;
        for (const agent of agenten.rows) {
            count += ressourcen.rows.filter(r => {
                if (new Date(r.erstellt_am) <= new Date(agent.letzte_pruefung)) return false;
                if (agent.typ && r.typ !== agent.typ) return false;
                if (agent.suchbegriff) {
                    const q = agent.suchbegriff.toLowerCase();
                    if (!r.name.toLowerCase().includes(q) && !(r.beschreibung || '').toLowerCase().includes(q)) return false;
                }
                return true;
            }).length;
        }
        res.json({ count });
    } catch (err) { res.status(500).json({ error: 'Fehler' }); }
});

// ===== TIERNAMEN: öffentliche Namensliste für Duplikat-Check =====
app.get('/api/mitglieder/namen', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT name FROM mitglieder ORDER BY name');
        res.json(rows.map(r => r.name));
    } catch {
        res.json([]);
    }
});

// ===== EINLADUNGSLINKS =====

app.post('/api/einladungen', authenticate, requireAdmin, async (req, res) => {
    const token = randomBytes(32).toString('hex');
    const gueltigBis = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    try {
        await pool.query(
            'INSERT INTO einladungen (token, erstellt_von, gueltig_bis) VALUES ($1, $2, $3)',
            [token, req.user.userId, gueltigBis]
        );
        res.json({ token });
    } catch (err) {
        console.error('Einladung erstellen:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

app.get('/api/einladungen', authenticate, requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT e.*, u.username AS erstellt_von_name
            FROM einladungen e
            LEFT JOIN users u ON u.id = e.erstellt_von
            ORDER BY e.erstellt_am DESC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Fehler' });
    }
});

app.delete('/api/einladungen/:token', authenticate, requireAdmin, async (req, res) => {
    await pool.query('DELETE FROM einladungen WHERE token = $1', [req.params.token]);
    res.json({ ok: true });
});

app.get('/api/einladungen/pruefen/:token', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM einladungen WHERE token = $1', [req.params.token]);
        const inv = rows[0];
        if (!inv) return res.status(404).json({ error: 'Einladungslink ungültig' });
        if (inv.benutzt_am) return res.status(400).json({ error: 'Dieser Einladungslink wurde bereits verwendet' });
        if (new Date(inv.gueltig_bis) < new Date()) return res.status(400).json({ error: 'Dieser Einladungslink ist abgelaufen' });
        res.json({ ok: true, gueltigBis: inv.gueltig_bis });
    } catch (err) {
        res.status(500).json({ error: 'Fehler' });
    }
});

app.post('/api/einladungen/:token/registrieren', async (req, res) => {
    const { token } = req.params;
    const { username, password, name, plz, email } = req.body;

    if (!username || !password || !name || !plz) {
        return res.status(400).json({ error: 'Benutzername, Passwort, Name und PLZ sind erforderlich' });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const invRes = await client.query('SELECT * FROM einladungen WHERE token = $1', [token]);
        const inv = invRes.rows[0];
        if (!inv) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Einladungslink ungültig' }); }
        if (inv.benutzt_am) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Einladungslink bereits verwendet' }); }
        if (new Date(inv.gueltig_bis) < new Date()) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Einladungslink abgelaufen' }); }

        const existing = await client.query('SELECT id FROM users WHERE username = $1', [username]);
        if (existing.rows.length > 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Benutzername bereits vergeben' }); }

        const hash = await bcrypt.hash(password, 12);
        const uRes = await client.query(
            'INSERT INTO users (username, password_hash, email, role) VALUES ($1, $2, $3, $4) RETURNING id',
            [username, hash, email ? email.trim() : null, 'user']
        );
        const userId = uRes.rows[0].id;

        const mRes = await client.query(
            'INSERT INTO mitglieder (name, plz, user_id) VALUES ($1, $2, $3) RETURNING id',
            [name, plz, userId]
        );
        const mitgliedId = mRes.rows[0].id;

        await client.query('UPDATE users SET mitglied_id = $1 WHERE id = $2', [mitgliedId, userId]);
        await client.query(
            'UPDATE einladungen SET benutzt_am = NOW(), benutzt_von = $1 WHERE token = $2',
            [userId, token]
        );

        await client.query('COMMIT');
        broadcast();

        const jwtToken = jwt.sign(
            { userId, username, role: 'user' },
            JWT_SECRET,
            { expiresIn: '30d' }
        );
        res.json({ token: jwtToken, user: { id: userId, username, role: 'user' } });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Registrierung fehlgeschlagen:', err);
        res.status(500).json({ error: 'Fehler bei der Registrierung' });
    } finally {
        client.release();
    }
});

// ===== POOL-PROFIL =====

app.get('/api/config', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT app_name, app_untertitel, gemeinschaftskompass, admin_kontakt FROM pool_profil WHERE id = 1'
        );
        const r = rows[0] || {};
        res.json({
            app_name:            r.app_name            || 'RessourcenPool',
            app_untertitel:      r.app_untertitel      || 'Gemeinsam Ressourcen teilen',
            gemeinschaftskompass: r.gemeinschaftskompass || '',
            admin_kontakt:       r.admin_kontakt        || ''
        });
    } catch (err) {
        console.error('config GET:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

app.get('/api/pool-profil', authenticate, requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT name, admin_kontakt, plz, app_name, app_untertitel, gemeinschaftskompass FROM pool_profil WHERE id = 1'
        );
        res.json(rows[0] || { name: '', admin_kontakt: '', plz: '', app_name: '', app_untertitel: '', gemeinschaftskompass: '' });
    } catch (err) {
        console.error('pool-profil GET:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

app.put('/api/pool-profil', authenticate, requireAdmin, async (req, res) => {
    const { name, admin_kontakt, plz, app_name, app_untertitel, gemeinschaftskompass } = req.body;
    try {
        await pool.query(
            `INSERT INTO pool_profil (id, name, admin_kontakt, plz, app_name, app_untertitel, gemeinschaftskompass)
             VALUES (1, $1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO UPDATE SET name=$1, admin_kontakt=$2, plz=$3, app_name=$4, app_untertitel=$5, gemeinschaftskompass=$6`,
            [name || '', admin_kontakt || '', plz || '', app_name || '', app_untertitel || '', gemeinschaftskompass || '']
        );
        broadcast('update');
        res.json({ ok: true });
    } catch (err) {
        console.error('pool-profil PUT:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

// ===== PUBLIC ENDPOINT (kein Auth) =====

app.get('/api/public', async (req, res) => {
    try {
        const { rows: profilRows } = await pool.query(
            'SELECT name, admin_kontakt, plz FROM pool_profil WHERE id = 1'
        );
        const profil = profilRows[0] || { name: '', admin_kontakt: '', plz: '' };

        const { rows: ressourcen } = await pool.query(`
            SELECT r.name, r.beschreibung, r.plz, r.typ,
                   COALESCE(array_agg(t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags,
                   (SELECT rb.dateiname FROM ressource_bilder rb WHERE rb.ressource_id = r.id LIMIT 1) AS bild
            FROM ressourcen r
            LEFT JOIN ressource_tags rt ON rt.ressource_id = r.id
            LEFT JOIN tags t ON t.id = rt.tag_id
            WHERE r.status = 'verfuegbar'
            GROUP BY r.id
            ORDER BY r.erstellt_am DESC
        `);

        res.json({
            poolFormat: '1.0',
            exportedAt: new Date().toISOString(),
            pool: profil,
            ressourcen: ressourcen.map(r => ({
                name: r.name,
                beschreibung: r.beschreibung || '',
                plz: r.plz || '',
                typ: r.typ,
                tags: r.tags,
                ...(r.bild ? { bild: `/uploads/${r.bild}` } : {})
            }))
        });
    } catch (err) {
        console.error('public GET:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

// ===== PARTNER-POOLS =====

app.get('/api/partner-pools', authenticate, requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, name, kontakt, plz, quelle, url, importiert_am,
                    jsonb_array_length(snapshot->'ressourcen') AS ressourcen_anzahl
             FROM partner_pools ORDER BY importiert_am DESC`
        );
        res.json(rows);
    } catch (err) {
        console.error('partner-pools GET:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

app.post('/api/partner-pools/import', authenticate, requireAdmin, async (req, res) => {
    const data = req.body;
    if (!data || data.poolFormat !== '1.0') {
        return res.status(400).json({ error: 'Ungültiges Pool-Snapshot-Format (erwartet poolFormat: "1.0")' });
    }
    if (!data.pool || !data.pool.name) {
        return res.status(400).json({ error: 'Pool-Name fehlt im Snapshot' });
    }
    try {
        const { rows } = await pool.query(
            `INSERT INTO partner_pools (name, kontakt, plz, quelle, snapshot)
             VALUES ($1, $2, $3, 'json', $4)
             RETURNING id`,
            [data.pool.name, data.pool.kontakt || '', data.pool.plz || '', JSON.stringify(data)]
        );
        res.json({ ok: true, id: rows[0].id });
    } catch (err) {
        console.error('partner-pools import:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

app.post('/api/partner-pools/url', authenticate, requireAdmin, async (req, res) => {
    const { url } = req.body;
    if (!url || !url.startsWith('http')) {
        return res.status(400).json({ error: 'Ungültige URL' });
    }
    try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!resp.ok) return res.status(400).json({ error: `Partner-Pool nicht erreichbar (HTTP ${resp.status})` });
        const data = await resp.json();
        if (!data || data.poolFormat !== '1.0') {
            return res.status(400).json({ error: 'Kein gültiger Pool-Snapshot-Endpunkt (poolFormat "1.0" erwartet)' });
        }
        if (!data.pool || !data.pool.name) {
            return res.status(400).json({ error: 'Pool-Name fehlt im Snapshot' });
        }
        const { rows } = await pool.query(
            `INSERT INTO partner_pools (name, kontakt, plz, quelle, url, snapshot)
             VALUES ($1, $2, $3, 'url', $4, $5)
             RETURNING id`,
            [data.pool.name, data.pool.admin_kontakt || '', data.pool.plz || '', url, JSON.stringify(data)]
        );
        res.json({ ok: true, id: rows[0].id });
    } catch (err) {
        console.error('partner-pools url:', err);
        res.status(400).json({ error: 'Partner-Pool nicht erreichbar: ' + err.message });
    }
});

app.get('/api/partner-pools/live', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, name, kontakt, plz, url FROM partner_pools WHERE quelle = 'url' ORDER BY importiert_am DESC`
        );
        if (rows.length === 0) return res.json([]);

        const results = await Promise.allSettled(
            rows.map(async (p) => {
                const origin = new URL(p.url).origin;
                const resp = await fetch(p.url, { signal: AbortSignal.timeout(5000) });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                return {
                    id: p.id,
                    name: data.pool.name || p.name,
                    kontakt: data.pool.admin_kontakt || p.kontakt,
                    plz: data.pool.plz || p.plz,
                    ressourcen: (data.ressourcen || []).map(r => ({
                        ...r,
                        bild: r.bild ? (r.bild.startsWith('http') ? r.bild : origin + r.bild) : undefined
                    }))
                };
            })
        );

        res.json(
            results.filter(r => r.status === 'fulfilled').map(r => r.value)
        );
    } catch (err) {
        console.error('partner-pools live:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

app.delete('/api/partner-pools/:id', authenticate, requireAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM partner_pools WHERE id = $1', [req.params.id]);
        res.json({ ok: true });
    } catch (err) {
        console.error('partner-pools DELETE:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

// ===== HILFSFUNKTIONEN =====

async function pruefeUndMaileSuchagenten(ressource) {
    try {
        const { rows: agenten } = await pool.query(
            `SELECT s.*, u.email FROM suchagenten s JOIN users u ON u.id = s.user_id WHERE u.email IS NOT NULL`
        );
        for (const agent of agenten) {
            if (agent.typ && ressource.typ !== agent.typ) continue;
            if (agent.tags && agent.tags.length > 0) {
                if (!agent.tags.some(t => ressource.tags.includes(t))) continue;
            }
            if (agent.suchbegriff) {
                const q = agent.suchbegriff.toLowerCase();
                if (!ressource.name.toLowerCase().includes(q) && !ressource.beschreibung.toLowerCase().includes(q)) continue;
            }
            sendMail(agent.email,
                `Suchagent "${agent.name}" hat einen Treffer`,
                `<p>Hallo,</p>
                <p>Dein Suchagent <strong>"${agent.name}"</strong> hat einen neuen Treffer gefunden:</p>
                <p><strong>${ressource.name}</strong>${ressource.beschreibung ? ` – ${ressource.beschreibung}` : ''}</p>
                <p>Melde dich im RessourcenPool an, um die Ressource anzusehen.</p>`
            );
        }
    } catch (err) {
        console.warn('Suchagenten-Mail Fehler:', err.message);
    }
}

function deleteUpload(filename) {
    try {
        const f = path.join(UPLOAD_DIR, filename);
        if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (err) {
        console.warn('Bild konnte nicht gelöscht werden:', filename, err.message);
    }
}

// ===== DB INITIALISIERUNG =====

async function initDB() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                username      VARCHAR(100) UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role          VARCHAR(20) NOT NULL DEFAULT 'user',
                mitglied_id   UUID,
                erstellt_am   TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS mitglieder (
                id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name        VARCHAR(200) NOT NULL,
                plz         VARCHAR(5) NOT NULL,
                user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
                erstellt_am TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS tags (
                name VARCHAR(100) PRIMARY KEY
            );

            CREATE TABLE IF NOT EXISTS ressourcen (
                id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name            VARCHAR(200) NOT NULL,
                beschreibung    TEXT,
                kontakt         VARCHAR(200),
                plz             VARCHAR(5) NOT NULL,
                typ             VARCHAR(20) NOT NULL DEFAULT 'verleihen',
                status          VARCHAR(30) NOT NULL DEFAULT 'verfuegbar',
                ausgeliehen_an  UUID REFERENCES mitglieder(id) ON DELETE SET NULL,
                bestaetigt_fuer UUID REFERENCES mitglieder(id) ON DELETE SET NULL,
                erstellt_von    UUID REFERENCES users(id) ON DELETE SET NULL,
                erstellt_am     TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS suchagenten (
                id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
                name            VARCHAR(100) NOT NULL,
                suchbegriff     VARCHAR(200),
                typ             VARCHAR(20),
                tags            TEXT[],
                letzte_pruefung TIMESTAMPTZ DEFAULT NOW(),
                erstellt_am     TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS ressource_bilder (
                id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                ressource_id UUID REFERENCES ressourcen(id) ON DELETE CASCADE,
                bild_pfad    VARCHAR(500) NOT NULL,
                position     INT NOT NULL DEFAULT 0,
                erstellt_am  TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS ressource_tags (
                ressource_id UUID REFERENCES ressourcen(id) ON DELETE CASCADE,
                tag_name     VARCHAR(100) REFERENCES tags(name) ON DELETE CASCADE,
                PRIMARY KEY (ressource_id, tag_name)
            );

            CREATE TABLE IF NOT EXISTS anfragen (
                id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                ressource_id UUID REFERENCES ressourcen(id) ON DELETE CASCADE,
                mitglied_id  UUID REFERENCES mitglieder(id) ON DELETE CASCADE,
                nachricht    TEXT,
                status       VARCHAR(20) NOT NULL DEFAULT 'offen',
                erstellt_am  TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS einladungen (
                id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                token        VARCHAR(64) UNIQUE NOT NULL,
                erstellt_von UUID REFERENCES users(id) ON DELETE CASCADE,
                gueltig_bis  TIMESTAMPTZ NOT NULL,
                erstellt_am  TIMESTAMPTZ DEFAULT NOW(),
                benutzt_am   TIMESTAMPTZ,
                benutzt_von  UUID REFERENCES users(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS pool_profil (
                id           INT PRIMARY KEY DEFAULT 1,
                name         VARCHAR(200) DEFAULT '',
                admin_kontakt VARCHAR(200) DEFAULT '',
                plz          VARCHAR(5) DEFAULT '',
                CHECK (id = 1)
            );

            CREATE TABLE IF NOT EXISTS partner_pools (
                id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name         VARCHAR(200) NOT NULL,
                kontakt      VARCHAR(200),
                plz          VARCHAR(5),
                quelle       VARCHAR(20) NOT NULL DEFAULT 'json',
                url          TEXT,
                snapshot     JSONB NOT NULL,
                importiert_am TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS joker_profile (
                id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id      UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
                aktiv        BOOLEAN DEFAULT FALSE,
                verfuegbarkeit TEXT[] DEFAULT '{}',
                erstellt_am  TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS joker_anfragen (
                id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                erstellt_von       UUID REFERENCES users(id) ON DELETE CASCADE,
                beschreibung       TEXT NOT NULL,
                zeitraum           VARCHAR(20),
                status             VARCHAR(20) DEFAULT 'offen',
                aktueller_joker_id UUID REFERENCES users(id) ON DELETE SET NULL,
                gefragt_seit       TIMESTAMPTZ,
                laeuft_ab          TIMESTAMPTZ,
                erstellt_am        TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS joker_antworten (
                id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                anfrage_id     UUID REFERENCES joker_anfragen(id) ON DELETE CASCADE,
                joker_user_id  UUID REFERENCES users(id) ON DELETE CASCADE,
                status         VARCHAR(20) DEFAULT 'ausstehend',
                runde          INT DEFAULT 1,
                gefragt_am     TIMESTAMPTZ DEFAULT NOW(),
                geantwortet_am TIMESTAMPTZ,
                UNIQUE(anfrage_id, joker_user_id, runde)
            );
        `);


        // Spalten-Migrationen für bestehende Installationen
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(200)`);
        await client.query(`ALTER TABLE ressourcen ADD COLUMN IF NOT EXISTS kontakt VARCHAR(200)`);
        await client.query(`ALTER TABLE anfragen ADD COLUMN IF NOT EXISTS kontakt_entleiher TEXT`);
        await client.query(`ALTER TABLE anfragen ADD COLUMN IF NOT EXISTS versand_gewuenscht BOOLEAN DEFAULT FALSE`);
        await client.query(`ALTER TABLE anfragen ADD COLUMN IF NOT EXISTS versand_adresse TEXT`);
        await client.query(`ALTER TABLE anfragen ADD COLUMN IF NOT EXISTS kontakt_verleiher TEXT`);
        await client.query(`ALTER TABLE pool_profil ADD COLUMN IF NOT EXISTS app_name VARCHAR(200) DEFAULT ''`);
        await client.query(`ALTER TABLE pool_profil ADD COLUMN IF NOT EXISTS app_untertitel VARCHAR(200) DEFAULT ''`);
        await client.query(`ALTER TABLE pool_profil ADD COLUMN IF NOT EXISTS gemeinschaftskompass TEXT DEFAULT ''`);
        await client.query(`INSERT INTO pool_profil (id) VALUES (1) ON CONFLICT DO NOTHING`);

        const adminCheck = await client.query("SELECT id FROM users WHERE username = 'admin'");
        if (adminCheck.rows.length === 0) {
            const hash = await bcrypt.hash('admin123', 12);
            await client.query(
                "INSERT INTO users (username, password_hash, role) VALUES ('admin', $1, 'betreiber')",
                [hash]
            );
            console.log('Default-Admin angelegt: admin / admin123 — Passwort sofort ändern!');
        }

        console.log('Datenbank initialisiert ✓');
    } finally {
        client.release();
    }
}

// ===== JOKER =====

async function naechstenJokerFragen(anfrage_id) {
    const { rows: [anfrage] } = await pool.query(
        'SELECT * FROM joker_anfragen WHERE id = $1', [anfrage_id]
    );
    if (!anfrage || anfrage.status !== 'offen') return;

    // Bereits gefragte Joker in Runde 1
    const { rows: bereitsR1 } = await pool.query(
        'SELECT joker_user_id FROM joker_antworten WHERE anfrage_id = $1 AND runde = 1',
        [anfrage_id]
    );
    const bereitsR1Ids = bereitsR1.map(r => r.joker_user_id);

    // Verfügbare Joker für Runde 1
    let params = [anfrage.erstellt_von];
    let verfQuery = `
        SELECT jp.user_id FROM joker_profile jp
        WHERE jp.aktiv = true AND jp.user_id != $1`;

    if (anfrage.zeitraum) {
        params.push(anfrage.zeitraum);
        verfQuery += ` AND $${params.length} = ANY(jp.verfuegbarkeit)`;
    }
    if (bereitsR1Ids.length > 0) {
        params.push(bereitsR1Ids);
        verfQuery += ` AND jp.user_id != ALL($${params.length}::uuid[])`;
    }

    const { rows: verfuegbare } = await pool.query(verfQuery, params);

    if (verfuegbare.length > 0) {
        const joker = verfuegbare[Math.floor(Math.random() * verfuegbare.length)];
        await pool.query(
            'INSERT INTO joker_antworten (anfrage_id, joker_user_id, runde) VALUES ($1, $2, 1) ON CONFLICT DO NOTHING',
            [anfrage_id, joker.user_id]
        );
        await pool.query(
            'UPDATE joker_anfragen SET aktueller_joker_id = $1, gefragt_seit = NOW() WHERE id = $2',
            [joker.user_id, anfrage_id]
        );
        broadcast('joker_update');
        return;
    }

    // Runde 1 erschöpft → Runde 2: Letzte Chance + Timeout
    const { rows: bereitsR2 } = await pool.query(
        'SELECT joker_user_id FROM joker_antworten WHERE anfrage_id = $1 AND runde = 2',
        [anfrage_id]
    );
    const bereitsR2Ids = bereitsR2.map(r => r.joker_user_id);

    const { rows: zweiteChance } = await pool.query(
        `SELECT joker_user_id FROM joker_antworten
         WHERE anfrage_id = $1 AND runde = 1 AND status IN ('letzte_chance', 'timeout')
         AND joker_user_id != ALL($2::uuid[])`,
        [anfrage_id, bereitsR2Ids.length > 0 ? bereitsR2Ids : [null]]
    );

    if (zweiteChance.length > 0) {
        const joker = zweiteChance[Math.floor(Math.random() * zweiteChance.length)];
        await pool.query(
            'INSERT INTO joker_antworten (anfrage_id, joker_user_id, runde) VALUES ($1, $2, 2) ON CONFLICT DO NOTHING',
            [anfrage_id, joker.joker_user_id]
        );
        await pool.query(
            'UPDATE joker_anfragen SET aktueller_joker_id = $1, gefragt_seit = NOW() WHERE id = $2',
            [joker.joker_user_id, anfrage_id]
        );
        broadcast('joker_update');
        return;
    }

    // Niemand hat geholfen
    await pool.query(
        "UPDATE joker_anfragen SET status = 'abgelaufen', aktueller_joker_id = NULL WHERE id = $1",
        [anfrage_id]
    );
    broadcast('joker_update');
}

function startJokerHintergrundjob() {
    setInterval(async () => {
        try {
            // Timeouts prüfen (3 Stunden keine Antwort)
            const { rows: timedOut } = await pool.query(`
                SELECT id FROM joker_anfragen
                WHERE status = 'offen'
                AND aktueller_joker_id IS NOT NULL
                AND gefragt_seit < NOW() - INTERVAL '3 hours'
            `);
            for (const a of timedOut) {
                await pool.query(
                    "UPDATE joker_antworten SET status = 'timeout', geantwortet_am = NOW() WHERE anfrage_id = $1 AND status = 'ausstehend'",
                    [a.id]
                );
                await pool.query(
                    'UPDATE joker_anfragen SET aktueller_joker_id = NULL WHERE id = $1', [a.id]
                );
                await naechstenJokerFragen(a.id);
            }

            // Abgelaufene Anfragen (72h)
            const { rows: abgelaufen } = await pool.query(`
                UPDATE joker_anfragen SET status = 'abgelaufen', aktueller_joker_id = NULL
                WHERE status = 'offen' AND laeuft_ab < NOW()
                RETURNING id
            `);
            if (abgelaufen.length > 0) broadcast('joker_update');
        } catch (err) {
            console.error('Joker-Hintergrundjob Fehler:', err);
        }
    }, 5 * 60 * 1000);
}

// Joker-Profil abrufen
app.get('/api/joker/profil', authenticate, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT aktiv, verfuegbarkeit FROM joker_profile WHERE user_id = $1',
            [req.user.userId]
        );
        res.json(rows[0] || { aktiv: false, verfuegbarkeit: [] });
    } catch (err) {
        console.error('joker profil GET:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

// Joker-Profil speichern
app.put('/api/joker/profil', authenticate, async (req, res) => {
    const { aktiv, verfuegbarkeit } = req.body;
    try {
        await pool.query(`
            INSERT INTO joker_profile (user_id, aktiv, verfuegbarkeit)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id) DO UPDATE SET aktiv = $2, verfuegbarkeit = $3
        `, [req.user.userId, !!aktiv, verfuegbarkeit || []]);
        res.json({ ok: true });
    } catch (err) {
        console.error('joker profil PUT:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

// Meine aktuelle Joker-Frage (als Joker)
app.get('/api/joker/frage', authenticate, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT ja.id, ja.beschreibung, ja.zeitraum, ja.erstellt_am, ja.laeuft_ab,
                   m.name AS anfragender_name,
                   ant.runde
            FROM joker_anfragen ja
            JOIN joker_antworten ant ON ant.anfrage_id = ja.id AND ant.joker_user_id = $1 AND ant.status = 'ausstehend'
            LEFT JOIN mitglieder m ON m.user_id = ja.erstellt_von
            WHERE ja.aktueller_joker_id = $1 AND ja.status = 'offen'
            LIMIT 1
        `, [req.user.userId]);
        res.json(rows[0] || null);
    } catch (err) {
        console.error('joker frage GET:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

// Neue Joker-Anfrage stellen
app.post('/api/joker/anfragen', authenticate, async (req, res) => {
    const { beschreibung, zeitraum } = req.body;
    if (!beschreibung || !beschreibung.trim()) return res.status(400).json({ error: 'Beschreibung fehlt' });

    try {
        const { rows: existing } = await pool.query(
            "SELECT id FROM joker_anfragen WHERE erstellt_von = $1 AND status = 'offen'",
            [req.user.userId]
        );
        if (existing.length > 0) return res.status(400).json({ error: 'Du hast bereits eine offene Joker-Anfrage' });

        const { rows: [neu] } = await pool.query(`
            INSERT INTO joker_anfragen (erstellt_von, beschreibung, zeitraum, laeuft_ab)
            VALUES ($1, $2, $3, NOW() + INTERVAL '72 hours')
            RETURNING id
        `, [req.user.userId, beschreibung.trim(), zeitraum || null]);

        await naechstenJokerFragen(neu.id);
        res.json({ ok: true, id: neu.id });
    } catch (err) {
        console.error('joker anfrage POST:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

// Meine Joker-Anfragen (als Anfragender)
app.get('/api/joker/anfragen/meine', authenticate, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT ja.*,
                   m.name AS aktueller_joker_name,
                   (SELECT COUNT(*) FROM joker_antworten WHERE anfrage_id = ja.id AND status = 'nein') AS ablehnungen,
                   (SELECT COUNT(*) FROM joker_antworten WHERE anfrage_id = ja.id AND status = 'timeout') AS timeouts,
                   (SELECT COUNT(*) FROM joker_antworten WHERE anfrage_id = ja.id) AS gesamt_gefragt
            FROM joker_anfragen ja
            LEFT JOIN mitglieder m ON m.user_id = ja.aktueller_joker_id
            WHERE ja.erstellt_von = $1
            ORDER BY ja.erstellt_am DESC
            LIMIT 20
        `, [req.user.userId]);
        res.json(rows);
    } catch (err) {
        console.error('joker anfragen meine GET:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

// Als Joker antworten
app.post('/api/joker/anfragen/:id/antworten', authenticate, async (req, res) => {
    const { antwort } = req.body;
    if (!['ja', 'nein', 'letzte_chance'].includes(antwort)) {
        return res.status(400).json({ error: 'Ungültige Antwort' });
    }
    try {
        const { rows: [anfrage] } = await pool.query(
            "SELECT * FROM joker_anfragen WHERE id = $1 AND aktueller_joker_id = $2 AND status = 'offen'",
            [req.params.id, req.user.userId]
        );
        if (!anfrage) return res.status(404).json({ error: 'Anfrage nicht gefunden oder nicht für dich' });

        await pool.query(
            "UPDATE joker_antworten SET status = $1, geantwortet_am = NOW() WHERE anfrage_id = $2 AND joker_user_id = $3 AND status = 'ausstehend'",
            [antwort, req.params.id, req.user.userId]
        );

        if (antwort === 'ja') {
            await pool.query(
                "UPDATE joker_anfragen SET status = 'vermittelt' WHERE id = $1",
                [req.params.id]
            );
            broadcast('joker_update');
            res.json({ ok: true, vermittelt: true });
        } else {
            await pool.query(
                'UPDATE joker_anfragen SET aktueller_joker_id = NULL WHERE id = $1',
                [req.params.id]
            );
            await naechstenJokerFragen(req.params.id);
            res.json({ ok: true });
        }
    } catch (err) {
        console.error('joker antworten POST:', err);
        res.status(500).json({ error: 'Fehler' });
    }
});

// Joker-Anfrage zurückziehen
app.delete('/api/joker/anfragen/:id', authenticate, async (req, res) => {
    try {
        await pool.query(
            "UPDATE joker_anfragen SET status = 'abgelaufen', aktueller_joker_id = NULL WHERE id = $1 AND erstellt_von = $2",
            [req.params.id, req.user.userId]
        );
        broadcast('joker_update');
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Fehler' });
    }
});

// ===== START =====
initDB()
    .then(() => {
        startJokerHintergrundjob();
        app.listen(PORT, () => console.log(`RessourcenPool v1.8 läuft auf Port ${PORT}`));
    })
    .catch(err => { console.error('Startfehler:', err); process.exit(1); });
