const http  = require('http');
const fs    = require('fs');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const PORT     = process.env.PORT || 3000;
const AUTH_DIR = '/tmp/wa_auth';
const CRM_URL  = 'https://crm.twentysix-agency.com/api.php';
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || '';

const KEYWORDS = ['booking','fecha','caché','cache','gig','evento','dj','precio',
    'disponible','artista','concierto','festival','bolo','oferta',
    'presupuesto','contrato','rider','techno','electrónica','club','promotor'];

let botStatus = 'iniciando';
let qrCode    = '';
let analyzed  = 0;
let created   = 0;
const t0      = Date.now();

console.log('🚀 TWENTYSIX WhatsApp Bot arrancando...');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// HTTP server — arranca primero para que Railway no lo mate
http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok:true, status:botStatus }));
        return;
    }
    const up  = Math.round((Date.now()-t0)/60000);
    const col = {conectado:'#10b981',esperando_qr:'#f59e0b',iniciando:'#6b7280'}[botStatus]||'#6b7280';
    const qrSection = qrCode
        ? `<img src="https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(qrCode)}" style="border-radius:8px;margin:20px 0;display:block;">
           <p style="color:#f59e0b;font-weight:700;">📱 Escanea con WhatsApp ahora</p>
           <p style="color:#555;font-size:13px;margin-top:6px;">WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>`
        : `<p style="color:${col};font-size:20px;font-weight:700;margin:28px 0;">${botStatus==='conectado'?'✅ Conectado y escuchando':'⏳ '+botStatus}</p>`;
    res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
    res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="8"><title>TWENTYSIX WA Bot</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center}
.c{background:#111;border:1px solid #222;border-radius:16px;padding:40px 32px;max-width:440px;width:90%}
.logo{font-size:10px;font-weight:900;letter-spacing:3px;color:#444;margin-bottom:12px}h1{font-size:22px;font-weight:800;margin-bottom:16px}
.badge{display:inline-flex;align-items:center;gap:8px;background:#1a1a1a;border-radius:20px;padding:6px 16px;margin-bottom:20px}
.dot{width:8px;height:8px;border-radius:50%;background:${col}}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:24px}
.s{background:#1a1a1a;border-radius:10px;padding:14px}.sn{font-size:22px;font-weight:900;color:#e8ff47}.sl{font-size:10px;color:#555;margin-top:4px}
</style></head><body><div class="c">
<div class="logo">TWENTYSIX AGENCY</div><h1>WhatsApp Bot</h1>
<div class="badge"><div class="dot"></div><span style="font-size:12px;font-weight:700;">${botStatus.replace(/_/g,' ').toUpperCase()}</span></div>
${qrSection}
<div class="stats">
<div class="s"><div class="sn">${analyzed}</div><div class="sl">Analizados</div></div>
<div class="s"><div class="sn">${created}</div><div class="sl">Tareas CRM</div></div>
<div class="s"><div class="sn">${up}m</div><div class="sl">Uptime</div></div>
</div></div></body></html>`);
}).listen(PORT, () => console.log(`✅ HTTP en puerto ${PORT}`));

// Baileys con import() dinámico (ES Module)
async function startBot() {
    try {
        console.log('Cargando Baileys (ESM)...');
        const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } =
            await import('@whiskeysockets/baileys');
        const { default: pino } = await import('pino');
        console.log('✅ Baileys cargado');

        const { version }       = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        const sock = makeWASocket({
            version, auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            browser: ['TWENTYSIX CRM','Chrome','120.0'],
            connectTimeoutMs: 60000,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
            if (qr) { botStatus='esperando_qr'; qrCode=qr; console.log('📱 QR listo — abre la URL de Railway'); }
            if (connection==='open') { botStatus='conectado'; qrCode=''; console.log('✅ WhatsApp conectado'); }
            if (connection==='close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                botStatus = 'reconectando';
                if (code===DisconnectReason.loggedOut) {
                    console.log('Sesión cerrada — generando nuevo QR');
                    try { fs.rmSync(AUTH_DIR,{recursive:true}); fs.mkdirSync(AUTH_DIR,{recursive:true}); } catch(e){}
                }
                setTimeout(startBot, 6000);
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type!=='notify') return;
            for (const msg of messages) {
                if (msg.key.fromMe || !msg.key.remoteJid) continue;
                if (msg.key.remoteJid==='status@broadcast') continue;
                if (msg.key.remoteJid.endsWith('@g.us')) continue;

                const text = msg.message?.conversation
                    || msg.message?.extendedTextMessage?.text || '';
                if (!text || text.length<4) continue;

                const phone = msg.key.remoteJid.replace('@s.whatsapp.net','');
                const name  = msg.pushName || phone;
                console.log(`📨 ${name}: "${text.substring(0,60)}"`);
                analyzed++;

                const a = await analyze(name, phone, text);
                if (a.importante) await createTask(name, phone, text, a);
            }
        });

    } catch(e) {
        console.error('Error en bot:', e.message);
        setTimeout(startBot, 8000);
    }
}

async function analyze(name, phone, text) {
    if (!ANTHROPIC_KEY) {
        const hit = KEYWORDS.some(k => text.toLowerCase().includes(k));
        return { importante: hit, tipo:'lead', prioridad:'media',
            titulo_tarea: `WA de ${name}: ${text.substring(0,50)}`,
            resumen: text.substring(0,200) };
    }
    try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
            method:'POST',
            headers:{'x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'},
            body: JSON.stringify({
                model:'claude-haiku-4-5-20251001', max_tokens:300,
                system:'Analizas WhatsApps de una agencia de booking de música electrónica. Responde SOLO con JSON.',
                messages:[{role:'user',content:`De ${name}(+${phone}): "${text}"\nJSON: {"importante":bool,"tipo":"booking_request|disponibilidad|presupuesto|info_artista|lead|spam","prioridad":"alta|media|baja","titulo_tarea":"máx 60 chars","resumen":"1 frase"}`}]
            })
        });
        const d = await r.json();
        return JSON.parse((d?.content?.[0]?.text||'{"importante":false}').replace(/```json|```/g,'').trim());
    } catch(e) { return {importante:false}; }
}

async function createTask(name, phone, text, a) {
    const emoji = {alta:'🔴',media:'🟡',baja:'🟢'}[a.prioridad]||'⚪';
    try {
        const r = await fetch(`${CRM_URL}?action=add_history`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({
                contacto_id: null, tipo:'Tarea',
                titulo:`${emoji} WA ${(a.tipo||'lead').toUpperCase()} — ${a.titulo_tarea||name}`,
                descripcion:`📱 De: ${name} (+${phone})\n💬 "${text}"\n🤖 ${a.resumen||''}\n📅 ${new Date().toLocaleString('es-ES')}`,
                tags:`WhatsApp,${a.tipo||'lead'},Prio:${a.prioridad||'media'}`,
                estado:'Pendiente',
                fecha: new Date().toISOString().replace('T',' ').substring(0,19)
            })
        });
        const d = await r.json();
        if (d.success) { created++; console.log(`✅ Tarea CRM: "${a.titulo_tarea}"`); }
        else console.log('CRM error:', d.error);
    } catch(e) { console.log('CRM error:', e.message); }
}

// Arrancar WhatsApp 2s después del HTTP
setTimeout(startBot, 2000);
