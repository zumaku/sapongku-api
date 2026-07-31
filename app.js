require('dotenv').config();

const packageJson = require('./package.json');
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path'); 
const fs = require('fs'); 
const WebSocket = require('ws'); 
const http = require('http'); 

const app = express();
const port = 3000;

const server = http.createServer(app);
const wss = new WebSocket.Server({ server }); 

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'check_speed') {
                ws.send(JSON.stringify({ type: 'speed_result', clientTime: data.time }));
            }
        } catch (err) {
            console.error('[WS] Error memproses pesan dari frontend:', err.message);
        }
    });
});

const ESP_RUANG_TAMU_WS = process.env.ESP_RUANG_TAMU_WS; 
const ESP_DAPUR_WS = process.env.ESP_DAPUR_WS;  
const ESP_MEJA_KERJA_WS = process.env.ESP_MEJA_KERJA_WS; 

const DB_FILE = path.join(__dirname, 'jadwal.json'); 
const EVENTS_FILE = path.join(__dirname, 'events.json'); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let daftarJadwal = [];
let daftarEvent = [];

// --- 1. WEBSOCKET FRONTEND BROADCASTER ---
function teruskanKeFrontend(idRuangan, payload) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ source: idRuangan, data: payload }));
        }
    });
}

// --- 2. EVALUATOR EVENT (RULES ENGINE MULTI-ACTION) ---
function evaluasiEvent(source, data) {
    if (!data) return;
    const now = Date.now();

    daftarEvent.forEach(ev => {
        let isTriggered = false;

        // Tipe A: Evaluasi Data Sensor Analog (Suhu/Kelembaban)
        if (data.type === 'sensor' && data.dht22_1) {
            let val = null;
            if (ev.trigger_source === `${source}|temperature`) val = data.dht22_1.temperature;
            if (ev.trigger_source === `${source}|humidity`) val = data.dht22_1.humidity;

            if (val !== null) {
                const targetVal = parseFloat(ev.trigger_value);
                if (ev.operator === '>' && val > targetVal) isTriggered = true;
                if (ev.operator === '<' && val < targetVal) isTriggered = true;
                if (ev.operator === '==' && val == targetVal) isTriggered = true;
            }
        }
        
        // Tipe B: Evaluasi Event Eksternal (Tepukan)
        if (data.type === 'event') {
            if (ev.trigger_source === `${source}|${data.action}`) {
                isTriggered = true; 
            }
        }

        if (isTriggered) {
            // Anti-Spam: 60 detik untuk suhu, 3 detik untuk event instan (tepukan)
            const cooldown = ev.trigger_source.includes('clap') ? 3000 : 60000;

            if (!ev.last_triggered || (now - ev.last_triggered > cooldown)) {
                ev.last_triggered = now;
                console.log(`\n[EVENT] Kondisi Terpenuhi: ${ev.trigger_source} -> Mengeksekusi ${ev.actions.length} aksi`);
                
                // Eksekusi semua aksi yang terdaftar pada event ini secara berurutan
                ev.actions.forEach(act => {
                    const [ruangan, saklar] = act.target.split('|');
                    axios.post(`http://127.0.0.1:${port}/api/${ruangan}/${saklar}`, { status: act.state }).catch(()=>{});
                });
            }
        }
    });
}

// --- 3. MANAJEMEN KONEKSI WEBSOCKET ESP ---
const espClients = { ruang_tamu: null, dapur: null, meja_kerja: null };

function hubungkanKeESP(idRuangan, wsUrl) {
    if (!wsUrl) return;

    console.log(`[WS] Mencoba terhubung ke ESP ${idRuangan} di ${wsUrl}...`);
    const ws = new WebSocket(wsUrl);
    ws.isAlive = false;

    ws.on('open', () => {
        console.log(`[WS] 🟢 Terhubung ke ESP ${idRuangan}`);
        espClients[idRuangan] = ws;
        ws.isAlive = true; 
    });

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        try {
            const parsedData = JSON.parse(data.toString());
            if (parsedData.type === 'sensor' || parsedData.type === 'state' || parsedData.type === 'event') {
                teruskanKeFrontend(idRuangan, parsedData);
            }
            evaluasiEvent(idRuangan, parsedData);
        } catch (err) {
            console.error(`[WS] Gagal memproses data dari ESP ${idRuangan}:`, err.message);
        }
    });

    ws.on('close', () => {
        console.log(`[WS] 🔴 Koneksi ke ESP ${idRuangan} terputus. Mencoba ulang dalam 5 detik...`);
        espClients[idRuangan] = null;
        if (ws.pingInterval) clearInterval(ws.pingInterval);
        setTimeout(() => hubungkanKeESP(idRuangan, wsUrl), 5000); 
    });

    ws.on('error', (err) => {
        console.error(`[WS] Error pada ESP ${idRuangan}:`, err.message);
        ws.terminate(); 
    });

    ws.pingInterval = setInterval(() => {
        if (ws.isAlive === false) {
            console.log(`[WS] 👻 Zombie Connection di ESP ${idRuangan}. Memutus paksa...`);
            ws.terminate(); 
            return;
        }
        ws.isAlive = false; 
        ws.ping(); 
    }, 10000);
}

hubungkanKeESP('ruang_tamu', ESP_RUANG_TAMU_WS);
hubungkanKeESP('dapur', ESP_DAPUR_WS);
hubungkanKeESP('meja_kerja', ESP_MEJA_KERJA_WS); 

// --- 4. FUNGSI DATABASE LOKAL ---
function simpanKeDatabase() {
    const dataAman = daftarJadwal.map(j => ({ id: j.id, ruangan: j.ruangan, saklar: j.saklar, status: j.status, waktu: j.waktu }));
    fs.writeFileSync(DB_FILE, JSON.stringify(dataAman, null, 4));
}

function simpanEventKeDatabase() {
    // Menyimpan array actions alih-alih aksi tunggal
    const dataAman = daftarEvent.map(e => ({
        id: e.id, trigger_source: e.trigger_source, operator: e.operator, 
        trigger_value: e.trigger_value, actions: e.actions
    }));
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(dataAman, null, 4));
}

function muatDariDatabase() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const dataTersimpan = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            dataTersimpan.forEach(j => {
                const [jam, menit] = j.waktu.split(':');
                const task = cron.schedule(`${menit} ${jam} * * *`, async () => {
                    console.log(`\n[CRON] Mengeksekusi jadwal: ${j.ruangan} -> ${j.saklar} -> ${j.status}`);
                    try { await axios.post(`http://127.0.0.1:${port}/api/${j.ruangan}/${j.saklar}`, { status: j.status }); } catch (error) {}
                });
                daftarJadwal.push({ ...j, task });
            });
            console.log(`[DATABASE] Berhasil memuat ${daftarJadwal.length} jadwal aktif.`);
        } catch (error) { simpanKeDatabase(); }
    } else { simpanKeDatabase(); }

    if (fs.existsSync(EVENTS_FILE)) {
        try {
            daftarEvent = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
            console.log(`[DATABASE] Berhasil memuat ${daftarEvent.length} rules automasi event.`);
        } catch(e) { simpanEventKeDatabase(); }
    } else { simpanEventKeDatabase(); }
}

// --- 5. HELPER FUNCTION IOT ---
async function kirimPerintahKeEsp(idRuangan, servoName, status) {
    if (status !== 'on' && status !== 'off') throw new Error("Status harus 'on' atau 'off'");
    const ws = espClients[idRuangan];
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error(`Koneksi ke ESP ${idRuangan} offline atau belum siap.`);
    
    const payload = JSON.stringify({ target: servoName, state: status });
    console.log(`[WS] Mengirim perintah: ${payload}`);
    ws.send(payload);
    return { message: "Perintah terkirim", target: servoName, status: status };
}

// --- 6. ROUTING API ---
app.post('/api/ruang_tamu/saklar1', async (req, res) => { try { res.json(await kirimPerintahKeEsp('ruang_tamu', 'servo1', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/ruang_tamu/saklar2', async (req, res) => { try { res.json(await kirimPerintahKeEsp('ruang_tamu', 'servo2', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/ruang_tamu/saklar3', async (req, res) => { try { res.json(await kirimPerintahKeEsp('ruang_tamu', 'servo3', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/dapur/saklar1', async (req, res) => { try { res.json(await kirimPerintahKeEsp('dapur', 'servo1', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/meja_kerja/relay1', async (req, res) => { try { res.json(await kirimPerintahKeEsp('meja_kerja', 'relay1', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/meja_kerja/relay2', async (req, res) => { try { res.json(await kirimPerintahKeEsp('meja_kerja', 'relay2', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/meja_kerja/clap_sensor', async (req, res) => { try { res.json(await kirimPerintahKeEsp('meja_kerja', 'clap_sensor', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); } });

app.post('/api/jadwal', (req, res) => {
    const { ruangan, saklar, status, waktu } = req.body; 
    const [jam, menit] = waktu.split(':');
    const task = cron.schedule(`${menit} ${jam} * * *`, async () => { try { await axios.post(`http://127.0.0.1:${port}/api/${ruangan}/${saklar}`, { status }); } catch (e) {} });
    daftarJadwal.push({ id: Date.now(), ruangan, saklar, status, waktu, task });
    simpanKeDatabase(); res.json({ message: "Jadwal berhasil ditambahkan!" });
});
app.get('/api/jadwal', (req, res) => { res.json(daftarJadwal.map(j => ({ id: j.id, ruangan: j.ruangan, saklar: j.saklar, status: j.status, waktu: j.waktu }))); });
app.delete('/api/jadwal/:id', (req, res) => {
    const index = daftarJadwal.findIndex(j => j.id === parseInt(req.params.id));
    if (index !== -1) { daftarJadwal[index].task.stop(); daftarJadwal.splice(index, 1); simpanKeDatabase(); res.json({ message: "Jadwal berhasil dihapus!" }); }
});

// API CRUD EVENT BERSYARAT (DIPERBARUI UNTUK MULTI-ACTION)
app.post('/api/events', (req, res) => {
    // Menerima actions sebagai array
    const { trigger_source, operator, trigger_value, actions } = req.body;
    daftarEvent.push({ id: Date.now(), trigger_source, operator, trigger_value, actions });
    simpanEventKeDatabase(); res.json({ message: "Aturan event berhasil ditambahkan!" });
});
app.get('/api/events', (req, res) => { res.json(daftarEvent); });
app.delete('/api/events/:id', (req, res) => {
    const index = daftarEvent.findIndex(e => e.id === parseInt(req.params.id));
    if (index !== -1) { daftarEvent.splice(index, 1); simpanEventKeDatabase(); res.json({ message: "Event berhasil dihapus!" }); }
});

// --- 7. SERVE FRONTEND ---
app.get('/', function (req, res) { res.sendFile(path.join(__dirname, 'index.html')); });

// --- 8. INISIALISASI & JALANKAN SERVER ---
muatDariDatabase(); 
server.listen(port, '0.0.0.0', function () {
    console.log("=====================================");
    console.log(`🚀 Sapongku API v.${packageJson.version || 'v1.2.0'} Berjalan!`);
    console.log(`🌐 Akses Dashboard: http://localhost:${port}`);
    console.log("=====================================\n");
});