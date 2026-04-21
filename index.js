const http = require('http');
const PORT = process.env.PORT || 3000;

console.log('Arrancando TWENTYSIX WhatsApp Bot...');

// Servidor simple para probar que Railway funciona
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>TWENTYSIX Bot</title>
<style>body{font-family:sans-serif;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
.c{text-align:center;}.logo{font-size:11px;letter-spacing:3px;color:#555;margin-bottom:16px;}
h1{font-size:28px;font-weight:900;margin-bottom:8px;}p{color:#10b981;font-size:18px;}</style>
</head><body><div class="c">
<div class="logo">TWENTYSIX AGENCY</div>
<h1>WhatsApp Bot</h1>
<p>✅ Railway funcionando</p>
<p style="color:#666;font-size:14px;margin-top:16px;">Instalando WhatsApp... esto tarda 2-3 min la primera vez</p>
</div></body></html>`);
}).listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));

// Cargar Baileys después de que el servidor HTTP esté arriba
setTimeout(async () => {
    try {
        console.log('Cargando Baileys...');
        const baileys = require('@whiskeysockets/baileys');
        const { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = baileys;
        const pino    = require('pino');
        const fs      = require('fs');
        const path    = require('path');
        const fetch   = require('node-fetch');

        const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || '';
        const CRM_URL       = 'https://crm.twentysix-agency.com/api.php';
        const AUTH_DIR      = '/tmp/wa_auth';

        if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

        let tasksCreated = 0;
        let messagesAnalyzed = 0;
        let botStatus  = 'iniciando';
        let qrCodeData = '';

        const KEYWORDS = ['booking','fecha','caché','cache','gig','evento','dj','precio',
            'disponible','artista','concierto','festival','bolo','oferta',
            'presupuesto','contrato','rider','techno','electrónica','club','promotor'];

        async function analyzeMsg(name, phone, text) {
            if (!ANTHROPIC_KEY) {
                const lc = text.toLowerCase();
                const hit = KEYWORDS.some(k => lc.includes(k));
                return { importante: hit, tipo:'lead', prioridad:'media',
                    titulo_tarea:`WA de ${name}: ${text.substring(0,50)}`,
                    resumen: text.substring(0,200) };
            }
            try {
                const r = await fetch('https://api.anthropic.com/v1/messages', {
                    method:'POST',
                    headers:{'x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'},
                    body: JSON.stringify({
                        model:'claude-haiku-4-5-20251001', max_tokens:300,
                        system:'Analizas WhatsApps para agencia de booking música electrónica. Solo JSON.',
                        messages:[{role:'user',content:`De ${name}(+${phone}): "${text}"\nJSON: {"importante":bool,"tipo":"booking_request|lead|spam|otro","prioridad":"alta|media|baja","titulo_tarea":"<60chars","resumen":"1 frase"}`}]
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
                        contacto_id:null, tipo:'Tarea',
                        titulo:`${emoji} WA ${(a.tipo||'lead').toUpperCase()} — ${a.titulo_tarea||name}`,
                        descripcion:`📱 De: ${name} (+${phone})\n💬 "${text}"\n🤖 ${a.resumen||''}\n📅 ${new Date().toLocaleString('es-ES')}`,
                        tags:`WhatsApp,${a.tipo},Prio:${a.prioridad}`,
                        estado:'Pendiente',
                        fecha:new Date().toISOString().replace('T',' ').substring(0,19)
                    })
                });
                const d = await r.json();
                if (d.success) { tasksCreated++; console.log(`✅ Tarea creada: ${a.titulo_tarea}`); }
            } catch(e) { console.log('CRM error:',e.message); }
        }

        async function startWA() {
            try {
                const { version } = await fetchLatestBaileysVersion();
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
                    if (qr) { botStatus='esperando_qr'; qrCodeData=qr; console.log('📱 QR generado'); }
                    if (connection==='open') { botStatus='conectado'; qrCodeData=''; console.log('✅ WhatsApp conectado'); }
                    if (connection==='close') {
                        const code = lastDisconnect?.error?.output?.statusCode;
                        if (code===DisconnectReason.loggedOut) {
                            try { fs.rmSync(AUTH_DIR,{recursive:true}); fs.mkdirSync(AUTH_DIR,{recursive:true}); } catch(e){}
                        }
                        setTimeout(startWA, 5000);
                    }
                });

                sock.ev.on('messages.upsert', async ({ messages, type }) => {
                    if (type!=='notify') return;
                    for (const msg of messages) {
                        if (msg.key.fromMe || !msg.key.remoteJid || msg.key.remoteJid==='status@broadcast' || msg.key.remoteJid.endsWith('@g.us')) continue;
                        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                        if (!text || text.length<4) continue;
                        const phone = msg.key.remoteJid.replace('@s.whatsapp.net','');
                        const name  = msg.pushName || phone;
                        console.log(`📨 ${name}: "${text.substring(0,60)}"`);
                        messagesAnalyzed++;
                        const a = await analyzeMsg(name, phone, text);
                        if (a.importante) await createTask(name, phone, text, a);
                    }
                });
            } catch(e) {
                console.log('WA error:',e.message);
                setTimeout(startWA, 8000);
            }
        }

        console.log('Baileys cargado ✅ Iniciando WhatsApp...');
        startWA();

    } catch(e) {
        console.error('Error cargando módulos:', e.message);
    }
}, 3000);
