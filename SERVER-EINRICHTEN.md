# Server einrichten (einmalig)

**Server:** 178.104.46.6
**SSH:** `ssh root@178.104.46.6`

---

## Schritt 1: PostgreSQL-Datenbank anlegen

```bash
ssh root@178.104.46.6

# Als postgres-User
sudo -u postgres psql

# Datenbank und User anlegen
CREATE DATABASE ressourcenpool;
CREATE USER rp_user WITH PASSWORD 'SICHERES_PASSWORT_HIER';
GRANT ALL PRIVILEGES ON DATABASE ressourcenpool TO rp_user;
\q
```

---

## Schritt 2: Ordner anlegen

```bash
mkdir -p /var/www/ressourcenpool/public/uploads
```

---

## Schritt 3: .env Datei anlegen

```bash
nano /var/www/ressourcenpool/.env
```

Inhalt:
```
DATABASE_URL=postgresql://rp_user:SICHERES_PASSWORT_HIER@localhost:5432/ressourcenpool
JWT_SECRET=LANGER_ZUFAELLIGER_STRING_MINDESTENS_32_ZEICHEN
PORT=3001
```

Zufälligen JWT-Secret generieren:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## Schritt 4: Nginx konfigurieren (neben Schwarm-App)

```bash
nano /etc/nginx/sites-available/ressourcenpool
```

Inhalt:
```nginx
server {
    listen 80;
    server_name _;  # Oder eigene Domain wenn vorhanden

    location /ressourcenpool/ {
        proxy_pass http://localhost:3001/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 10M;
    }
}
```

**Oder:** Eigener Port ohne Nginx (einfacher für den Anfang):
```
http://178.104.46.6:3001
```

Nginx aktivieren (falls eigene Domain):
```bash
ln -s /etc/nginx/sites-available/ressourcenpool /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

---

## Schritt 5: Ersten Deploy ausführen

Lokal auf dem Rechner:
```bash
cd ".../Claude Apps/6-RessourcenPool/online"
chmod +x deploy.sh
./deploy.sh
```

---

## Schritt 6: App testen

```bash
# Auf dem Server
pm2 logs ressourcenpool

# Im Browser
http://178.104.46.6:3001
# Login: admin / admin123
# SOFORT Passwort ändern!
```

---

## PM2-Befehle

```bash
pm2 status                      # Alle Prozesse anzeigen
pm2 logs ressourcenpool         # Logs anzeigen
pm2 restart ressourcenpool      # Neustarten
pm2 stop ressourcenpool         # Stoppen
```

---

## Uploads-Ordner Backup

Bilder liegen unter `/var/www/ressourcenpool/public/uploads/`.
Beim Deploy werden sie **nicht überschrieben** (rsync excludet den Ordner).
Für Backups:
```bash
rsync -avz root@178.104.46.6:/var/www/ressourcenpool/public/uploads/ ./uploads-backup/
```
