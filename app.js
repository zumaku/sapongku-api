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
        } catch (err) {}
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

function teruskanKeFrontend(idRuangan, payload) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ source: idRuangan, data: payload }));
        }
    });
}

function isTimeInRange(startStr, endStr) {
    if (!startStr || !endStr) return true; 
    
    const now = new Date();
    const currentMins = now.getHours() * 60 + now.getMinutes();
    
    const [sH, sM] = startStr.split(':').map(Number);
    const [eH, eM] = endStr.split(':').map(Number);
    
    const startMins = sH * 60 + sM;
    const endMins = eH * 60 + eM;

    if (startMins <= endMins) {
        return currentMins >= startMins && currentMins <= endMins;
    } else {
        return currentMins >= startMins || currentMins <= endMins;
    }
}

const espClients = {};
const motionTimers = {}; 
const motionStates = {}; 
const blindTimers = {}; 

// --- EVALUATOR EVENT (RULES ENGINE) ---
function evaluasiEvent(source, data) {
    if (!data) return;
    const now = Date.now();

    daftarEvent.forEach(ev => {
        if (data.type === 'sensor' && data.dht22_1) {
            let val = null;
            if (ev.trigger_source === `${source}|temperature`) val = data.dht22_1.temperature;
            if (ev.trigger_source === `${source}|humidity`) val = data.dht22_1.humidity;

            if (val !== null) {
                const targetVal = parseFloat(ev.trigger_value);
                if ((ev.operator === '>' && val > targetVal) || 
                    (ev.operator === '<' && val < targetVal) || 
                    (ev.operator === '==' && val == targetVal)) {
                    
                    if (!ev.last_triggered || (now - ev.last_triggered > 60000)) {
                        ev.last_triggered = now;
                        console.log(`\n[EVENT] Kondisi Terpenuhi: ${ev.trigger_source}`);
                        ev.actions.forEach(act => {
                            const [r, s] = act.target.split('|');
                            axios.post(`http://127.0.0.1:${port}/api/${r}/${s}`, { status: act.state }).catch(()=>{});
                        });
                    }
                }
            }
        }
        
        if (data.type === 'event' && ev.trigger_source === `${source}|${data.action}`) {
            if (!ev.last_triggered || (now - ev.last_triggered > 5000)) {
                ev.last_triggered = now;
                console.log(`\n[EVENT] Kondisi Terpenuhi: ${ev.trigger_source}`);
                ev.actions.forEach(act => {
                    const [r, s] = act.target.split('|');
                    axios.post(`http://127.0.0.1:${port}/api/${r}/${s}`, { status: act.state }).catch(()=>{});
                });
            }
        }

        if (data.type === 'event' && ev.trigger_source === `${source}|motion_auto`) {
            const inRange = isTimeInRange(ev.start_time, ev.end_time);

            if (!inRange) {
                if (motionTimers[ev.id]) {
                    clearTimeout(motionTimers[ev.id]);
                    motionTimers[ev.id] = null;
                }
                motionStates[ev.id] = false;
                return; 
            }

            if (data.action === 'motion') {
                if (motionTimers[ev.id]) {
                    clearTimeout(motionTimers[ev.id]);
                    motionTimers[ev.id] = null;
                }

                if (!motionStates[ev.id]) {
                    motionStates[ev.id] = true;
                    console.log(`[EVENT] Gerakan di dalam rentang waktu. Menyalakan...`);
                    ev.actions.forEach(act => {
                        const [r, s] = act.target.split('|');
                        axios.post(`http://127.0.0.1:${port}/api/${r}/${s}`, { status: 'on' }).catch(()=>{});
                    });
                }
            } 
            else if (data.action === 'motion_idle') {
                if (motionStates[ev.id]) {
                    const delaySecs = ev.duration || 10;
                    console.log(`[TIMER] Sensor idle. Mulai hitung mundur ${delaySecs} detik...`);
                    
                    motionTimers[ev.id] = setTimeout(() => {
                        console.log(`\n[EVENT] Waktu tunda habis. Mematikan otomatis.`);
                        motionStates[ev.id] = false;
                        
                        ev.actions.forEach(act => {
                            const [r, s] = act.target.split('|');
                            axios.post(`http://127.0.0.1:${port}/api/${r}/${s}`, { status: 'off' }).catch(()=>{});
                        });
                        motionTimers[ev.id] = null;
                    }, delaySecs * 1000);
                }
            }
        }
    });
}

// --- MANAJEMEN KONEKSI WEBSOCKET ESP ---
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

            if (parsedData.type === 'event' && (parsedData.action === 'motion' || parsedData.action === 'motion_idle')) {
                if (blindTimers[idRuangan] && (Date.now() - blindTimers[idRuangan] < 4500)) return; 
            }

            evaluasiEvent(idRuangan, parsedData);
        } catch (err) {}
    });

    ws.on('close', () => {
        console.log(`[WS] 🔴 Koneksi ke ESP ${idRuangan} terputus. Mencoba ulang dalam 5 detik...`);
        espClients[idRuangan] = null;
        if (ws.pingInterval) clearInterval(ws.pingInterval);
        setTimeout(() => hubungkanKeESP(idRuangan, wsUrl), 5000); 
    });

    ws.on('error', (err) => { ws.terminate(); });

    ws.pingInterval = setInterval(() => {
        if (ws.isAlive === false) { ws.terminate(); return; }
        ws.isAlive = false; 
        ws.ping(); 
    }, 10000);
}

hubungkanKeESP('ruang_tamu', ESP_RUANG_TAMU_WS);
hubungkanKeESP('dapur', ESP_DAPUR_WS);
hubungkanKeESP('meja_kerja', ESP_MEJA_KERJA_WS); 

// --- FUNGSI DATABASE LOKAL ---
function simpanKeDatabase() {
    const dataAman = daftarJadwal.map(j => ({ id: j.id, ruangan: j.ruangan, saklar: j.saklar, status: j.status, waktu: j.waktu }));
    fs.writeFileSync(DB_FILE, JSON.stringify(dataAman, null, 4));
}

function simpanEventKeDatabase() {
    const dataAman = daftarEvent.map(e => ({
        id: e.id, trigger_source: e.trigger_source, operator: e.operator, 
        trigger_value: e.trigger_value, actions: e.actions, 
        start_time: e.start_time, end_time: e.end_time, duration: e.duration
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
                    try { await axios.post(`http://127.0.0.1:${port}/api/${j.ruangan}/${j.saklar}`, { status: j.status }); } catch (error) {}
                });
                daftarJadwal.push({ ...j, task });
            });
        } catch (error) { simpanKeDatabase(); }
    } else { simpanKeDatabase(); }

    if (fs.existsSync(EVENTS_FILE)) {
        try {
            daftarEvent = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
            console.log(`[DATABASE] Berhasil memuat ${daftarEvent.length} rules automasi event.`);
        } catch(e) { simpanEventKeDatabase(); }
    } else { simpanEventKeDatabase(); }
}

// --- HELPER FUNCTION IOT ---
async function kirimPerintahKeEsp(idRuangan, servoName, status) {
    if (status !== 'on' && status !== 'off') throw new Error("Status harus 'on' atau 'off'");
    const ws = espClients[idRuangan];
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error(`Koneksi ke ESP ${idRuangan} offline atau belum siap.`);
    
    const payload = JSON.stringify({ target: servoName, state: status });
    ws.send(payload);

    if (servoName.includes('servo')) {
        blindTimers[idRuangan] = Date.now();
    }

    return { message: "Perintah terkirim", target: servoName, status: status };
}

// --- ROUTING API ---
app.post('/api/ruang_tamu/saklar1', async (req, res) => { try { res.json(await kirimPerintahKeEsp('ruang_tamu', 'servo1', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/ruang_tamu/saklar2', async (req, res) => { try { res.json(await kirimPerintahKeEsp('ruang_tamu', 'servo2', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/ruang_tamu/saklar3', async (req, res) => { try { res.json(await kirimPerintahKeEsp('ruang_tamu', 'servo3', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/dapur/pir_sensor', async (req, res) => { try { res.json(await kirimPerintahKeEsp('dapur', 'pir_sensor', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/meja_kerja/relay1', async (req, res) => { try { res.json(await kirimPerintahKeEsp('meja_kerja', 'relay1', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/meja_kerja/relay2', async (req, res) => { try { res.json(await kirimPerintahKeEsp('meja_kerja', 'relay2', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/meja_kerja/clap_sensor', async (req, res) => { try { res.json(await kirimPerintahKeEsp('meja_kerja', 'clap_sensor', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); } });

app.post('/api/dapur/saklar1', async (req, res) => { 
    console.log(`[API] 🍽️ Request manual masuk ke Dapur -> Perintah: ${req.body.status.toUpperCase()}`);
    try { res.json(await kirimPerintahKeEsp('dapur', 'servo1', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); } 
});

// ROUTING CRUD JADWAL
app.post('/api/jadwal', (req, res) => {
    const { ruangan, saklar, status, waktu } = req.body; 
    const [jam, menit] = waktu.split(':');
    const task = cron.schedule(`${menit} ${jam} * * *`, async () => { try { await axios.post(`http://127.0.0.1:${port}/api/${ruangan}/${saklar}`, { status }); } catch (e) {} });
    daftarJadwal.push({ id: Date.now(), ruangan, saklar, status, waktu, task });
    simpanKeDatabase(); res.json({ message: "Jadwal berhasil ditambahkan!" });
});
app.get('/api/jadwal', (req, res) => { res.json(daftarJadwal.map(j => ({ id: j.id, ruangan: j.ruangan, saklar: j.saklar, status: j.status, waktu: j.waktu }))); });

// UPDATE JADWAL
app.put('/api/jadwal/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { ruangan, saklar, status, waktu } = req.body;
    const index = daftarJadwal.findIndex(j => j.id === id);

    if (index === -1) return res.status(404).json({ error: "Jadwal tidak ditemukan!" });
    daftarJadwal[index].task.stop(); // Hentikan cron lama

    const [jam, menit] = waktu.split(':');
    const newTask = cron.schedule(`${menit} ${jam} * * *`, async () => {
        try { await axios.post(`http://127.0.0.1:${port}/api/${ruangan}/${saklar}`, { status }); } catch (error) {}
    });

    daftarJadwal[index] = { id, ruangan, saklar, status, waktu, task: newTask };
    simpanKeDatabase(); 
    res.json({ message: "Jadwal berhasil diperbarui!" });
});

app.delete('/api/jadwal/:id', (req, res) => {
    const index = daftarJadwal.findIndex(j => j.id === parseInt(req.params.id));
    if (index !== -1) { daftarJadwal[index].task.stop(); daftarJadwal.splice(index, 1); simpanKeDatabase(); res.json({ message: "Jadwal berhasil dihapus!" }); }
});

// ROUTING CRUD EVENT
app.post('/api/events', (req, res) => {
    const { trigger_source, operator, trigger_value, actions, start_time, end_time, duration } = req.body;
    daftarEvent.push({ id: Date.now(), trigger_source, operator, trigger_value, actions, start_time, end_time, duration });
    simpanEventKeDatabase(); res.json({ message: "Aturan event berhasil ditambahkan!" });
});
app.get('/api/events', (req, res) => { res.json(daftarEvent); });

// UPDATE EVENT
app.put('/api/events/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { trigger_source, operator, trigger_value, actions, start_time, end_time, duration } = req.body;
    const index = daftarEvent.findIndex(e => e.id === id);
    
    if (index === -1) return res.status(404).json({ error: "Event tidak ditemukan!" });
    
    daftarEvent[index] = { id, trigger_source, operator, trigger_value, actions, start_time, end_time, duration };
    simpanEventKeDatabase();
    res.json({ message: "Aturan event berhasil diperbarui!" });
});

app.delete('/api/events/:id', (req, res) => {
    const index = daftarEvent.findIndex(e => e.id === parseInt(req.params.id));
    if (index !== -1) { daftarEvent.splice(index, 1); simpanEventKeDatabase(); res.json({ message: "Event berhasil dihapus!" }); }
});

app.get('/', function (req, res) { res.sendFile(path.join(__dirname, 'index.html')); });

muatDariDatabase(); 
server.listen(port, '0.0.0.0', function () {
    console.log("=====================================");
    console.log(`🚀 Sapongku API v.${packageJson.version || '1.3.0'} Berjalan!`);
    console.log(`🌐 Akses Dashboard: http://localhost:${port}`);
    console.log("=====================================\n");
});