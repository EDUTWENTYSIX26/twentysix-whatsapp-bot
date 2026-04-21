/**
 * TWENTYSIX AGENCY — WhatsApp Bot
 * Conecta con tu WhatsApp personal via QR
 * Analiza mensajes con Claude y crea tareas en el CRM
 */

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode    = require('qrcode-terminal');
const fetch     = require('node-fetch');
const pino      = require('pino');
const fs        = require('fs');
const http      = require('http');

// ── Configuración ────────────────────────────────────────
const CONFIG = {
    CRM_URL:       'https://crm.twentysix-agency.com/api.php',
    ANTHROPIC_KEY: process.env.ANTHROPIC_KEY || '',
    PORT:          process.env.PORT || 3000,
    // Números que NUNCA se procesan como leads (tú mismo, grupos internos)
    IGNORE_NUMBERS: [],
    // Palabras clave que indican mensaje importante
    KEYWORDS: ['booking', 'fecha', 'caché', 'cache', 'gig', 'evento', 'dj', 'precio', 'disponible', 
                'disponibilidad', 'artista', 'concierto', 'festival', 'bolo', 'oferta', 'presupuesto',
                'contrato', 'rider', 'techno', 'electrónica', 'club', 'promotor', 'promotora'],
};

// ── Estado del bot ────────────────────────────────────────
let botStatus = 'iniciando';
let qrCodeData = '';
let messagesProcessed = 0;
let tasksCreated = 0;
let startTime = new Date();

// ── Log ───────────────────────────────────────────────────
function log(msg) {
    const ts = new Date().toLocaleTimeString('es-ES');
    console.log(`[${ts}] ${msg}`);
}

// ── Servidor HTTP (QR + status para Railway) ──────────────
const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    
    if (req.url === '/status') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            status: botStatus,
            messagesProcessed,
            tasksCreated,
            uptime: Math.round((new Date() - startTime) / 60000) + ' min',
            qrReady: botStatus === 'esperando_qr',
        }));
        return;
    }

    // Página principal con QR y estado
    const qrHtml = qrCodeData 
        ? `<div style="background:#000;display:inline-block;padding:20px;border-radius:8px;margin:20px 0;">
               <img src="https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(qrCodeData)}" style="display:block;">
           </div>
           <p style="color:#ef4444;font-weight:bold;">⚡ Escanea este QR con WhatsApp en tu móvil ahora</p>
           <p style="color:#666;font-size:14px;">WhatsApp → Dispositivos vinculados → Vincular dispositivo → Escanear QR</p>`
        : '';

    const statusColor = {
        'conectado': '#10b981',
        'esperando_qr': '#f59e0b', 
        'iniciando': '#6b7280',
        'desconectado': '#ef4444',
    }[botStatus] || '#6b7280';

    res.end(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>TWENTYSIX — WhatsApp Bot</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, sans-serif; background: #0a0a0a; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: #111; border: 1px solid #222; border-radius: 16px; padding: 40px; max-width: 500px; width: 90%; text-align: center; }
  .logo { font-size: 11px; font-weight: 900; letter-spacing: 3px; color: #555; margin-bottom: 8px; }
  h1 { font-size: 24px; font-weight: 800; margin-bottom: 24px; }
  .status { display: inline-flex; align-items: center; gap: 8px; background: #1a1a1a; border-radius: 20px; padding: 8px 16px; margin-bottom: 24px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: ${statusColor}; }
  .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 24px; }
  .stat { background: #1a1a1a; border-radius: 10px; padding: 16px; }
  .stat-n { font-size: 28px; font-weight: 900; color: #e8ff47; }
  .stat-l { font-size: 11px; color: #555; margin-top: 4px; }
  .refresh { margin-top: 16px; font-size: 11px; color: #333; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">TWENTYSIX AGENCY</div>
  <h1>WhatsApp Bot</h1>
  <div class="status">
    <div class="dot"></div>
    <span style="font-size:13px;font-weight:600;">${botStatus.replace('_',' ').toUpperCase()}</span>
  </div>
  ${qrHtml}
  <div class="stats">
    <div class="stat"><div class="stat-n">${messagesProcessed}</div><div class="stat-l">Mensajes analizados</div></div>
    <div class="stat"><div class="stat-n">${tasksCreated}</div><div class="stat-l">Tareas creadas en CRM</div></div>
  </div>
  <div class="refresh">Actualización automática cada 10 segundos</div>
</div>
</body>
</html>`);
});

server.listen(CONFIG.PORT, () => log(`Servidor HTTP en puerto ${CONFIG.PORT}`));

// ── Analizar mensaje con Claude ───────────────────────────
async function analyzeMessage(from, name, text) {
    const prompt = `Eres el analizador de WhatsApp de TWENTYSIX Agency, agencia de booking de música electrónica.

Mensaje recibido de: ${name} (${from})
Texto: "${text}"

Analiza si este mensaje es relevante para la agencia (propuesta de booking, solicitud de info sobre artistas, consulta de disponibilidad, oferta de trabajo, lead comercial) o es spam/irrelevante.

Responde SOLO con este JSON exacto:
{
  "importante": true/false,
  "tipo": "booking_request|disponibilidad|presupuesto|info_artista|lead|spam|otro",
  "prioridad": "alta|media|baja",
  "titulo_tarea": "título corto de la tarea a crear (máx 60 chars)",
  "resumen": "resumen del mensaje en 1-2 frases",
  "artista_mencionado": "nombre del artista si lo hay, o null",
  "requiere_respuesta": true/false
}`;

    try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key':         CONFIG.ANTHROPIC_KEY,
                'anthropic-version': '2023-06-01',
                'Content-Type':      'application/json',
            },
            body: JSON.stringify({
                model:      'claude-haiku-4-5-20251001',
                max_tokens: 300,
                system:     'Analizas mensajes de WhatsApp para una agencia de booking de música electrónica. Responde SOLO con JSON válido, sin texto adicional.',
                messages:   [{ role: 'user', content: prompt }],
            }),
        });

        const data = await res.json();
        const raw  = data?.content?.[0]?.text || '{}';
        const clean = raw.replace(/```json|```/g, '').trim();
        return JSON.parse(clean);

    } catch (e) {
        log(`Error Claude: ${e.message}`);
        // Fallback: detectar keywords manualmente
        const lc = text.toLowerCase();
        const hasKeyword = CONFIG.KEYWORDS.some(k => lc.includes(k));
        return {
            importante:        hasKeyword,
            tipo:              'lead',
            prioridad:         hasKeyword ? 'media' : 'baja',
            titulo_tarea:      `WhatsApp de ${name}: ${text.substring(0, 40)}`,
            resumen:           text.substring(0, 200),
            artista_mencionado:null,
            requiere_respuesta:hasKeyword,
        };
    }
}

// ── Crear tarea en el CRM ─────────────────────────────────
async function createCRMTask(from, name, text, analysis) {
    const phone   = from.replace('@s.whatsapp.net', '').replace('@g.us', '');
    const emoji   = { alta: '🔴', media: '🟡', baja: '🟢' }[analysis.prioridad] || '⚪';
    const tipo    = analysis.tipo.replace('_', ' ').toUpperCase();

    const titulo = `${emoji} WA ${tipo} — ${analysis.titulo_tarea || name}`;
    const desc   = `📱 WhatsApp de: ${name} (+${phone})
💬 Mensaje: "${text}"

🤖 Análisis IA: ${analysis.resumen}
${analysis.artista_mencionado ? `🎵 Artista mencionado: ${analysis.artista_mencionado}` : ''}
${analysis.requiere_respuesta ? '⚡ Requiere respuesta' : ''}

📅 Recibido: ${new Date().toLocaleString('es-ES')}`;

    try {
        const res = await fetch(`${CONFIG.CRM_URL}?action=add_history`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                contacto_id:  null,
                tipo:         'Tarea',
                titulo,
                descripcion:  desc,
                tags:         `WhatsApp, ${analysis.tipo}, Prio:${analysis.prioridad}${analysis.artista_mencionado ? ', ' + analysis.artista_mencionado : ''}`,
                estado:       'Pendiente',
                fecha:        new Date().toISOString().replace('T', ' ').substring(0, 19),
            }),
        });
        const data = await res.json();
        if (data.success) {
            tasksCreated++;
            log(`✅ Tarea creada en CRM: "${titulo}"`);
        } else {
            log(`⚠ CRM error: ${data.error}`);
        }
    } catch (e) {
        log(`❌ Error CRM: ${e.message}`);
    }
}

// ── Notificación en CRM ───────────────────────────────────
async function notifyCRM(titulo, mensaje) {
    try {
        await fetch(`${CONFIG.CRM_URL}?action=add_notification`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ tipo: 'whatsapp', titulo, mensaje }),
        });
    } catch (e) {}
}

// ── Iniciar WhatsApp ──────────────────────────────────────
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth');
    
    const sock = makeWASocket({
        auth:   state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['TWENTYSIX CRM', 'Chrome', '120.0.0'],
    });

    // QR Code
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            botStatus  = 'esperando_qr';
            qrCodeData = qr;
            qrcode.generate(qr, { small: true });
            log('📱 QR generado — abre http://localhost:' + CONFIG.PORT + ' para escanearlo');
        }

        if (connection === 'open') {
            botStatus  = 'conectado';
            qrCodeData = '';
            log('✅ WhatsApp conectado — TWENTYSIX Bot activo');
            notifyCRM('✅ WhatsApp Bot conectado', 'El bot de WhatsApp está activo y analizando mensajes.');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            log(`⚠ Desconectado. Reconectar: ${shouldReconnect}`);
            botStatus = 'desconectado';
            if (shouldReconnect) {
                setTimeout(startBot, 5000);
            } else {
                log('❌ Sesión cerrada — vuelve a escanear el QR');
                botStatus  = 'esperando_qr';
                qrCodeData = '';
                // Borrar auth para forzar nuevo QR
                try { fs.rmSync('auth', { recursive: true }); } catch(e) {}
                setTimeout(startBot, 3000);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ── Procesar mensajes entrantes ───────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            // Ignorar mensajes propios, grupos y mensajes de estado
            if (msg.key.fromMe) continue;
            if (msg.key.remoteJid === 'status@broadcast') continue;

            const from    = msg.key.remoteJid || '';
            const isGroup = from.endsWith('@g.us');

            // Por ahora solo mensajes directos (no grupos)
            if (isGroup) continue;

            // Extraer texto
            const text = msg.message?.conversation
                || msg.message?.extendedTextMessage?.text
                || msg.message?.imageMessage?.caption
                || msg.message?.videoMessage?.caption
                || '';

            if (!text || text.length < 5) continue;

            // Ignorar números en lista negra
            if (CONFIG.IGNORE_NUMBERS.some(n => from.includes(n))) continue;

            const phone = from.replace('@s.whatsapp.net', '');
            const name  = msg.pushName || phone;

            log(`📨 WhatsApp de ${name} (+${phone}): "${text.substring(0, 60)}..."`);
            messagesProcessed++;

            // Analizar con Claude
            const analysis = await analyzeMessage(phone, name, text);
            log(`   → Importante: ${analysis.importante} | Tipo: ${analysis.tipo} | Prio: ${analysis.prioridad}`);

            // Solo crear tarea si es importante
            if (analysis.importante) {
                await createCRMTask(from, name, text, analysis);
                
                // Notificación inmediata en el CRM
                await notifyCRM(
                    `📱 WhatsApp importante de ${name}`,
                    `${analysis.resumen} — Prio: ${analysis.prioridad}`
                );
            }
        }
    });
}

// ── Arrancar ──────────────────────────────────────────────
log('🚀 TWENTYSIX WhatsApp Bot iniciando...');
startBot().catch(e => {
    log(`Error fatal: ${e.message}`);
    process.exit(1);
});
