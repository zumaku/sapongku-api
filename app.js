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

// Buat server HTTP dari Express
const server = http.createServer(app);
// Kaitkan WebSocket Server ke HTTP Server untuk melayani browser frontend
const wss = new WebSocket.Server({ server }); 

const ESP_RUANG_TAMU_WS = process.env.ESP_RUANG_TAMU_WS; 
const ESP_DAPUR_WS = process.env.ESP_DAPUR_WS;  
const DB_FILE = path.join(__dirname, 'jadwal.json'); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let daftarJadwal = [];

// --- 1. WEBSOCKET FRONTEND BROADCASTER ---
// Meneruskan data realtime dari ESP ke semua tab browser yang terbuka
function teruskanKeFrontend(idRuangan, payload) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ source: idRuangan, data: payload }));
        }
    });
}

// --- 2. MANAJEMEN KONEKSI WEBSOCKET ESP (DENGAN HEARTBEAT) ---
const espClients = {
    ruang_tamu: null,
    dapur: null
};

function hubungkanKeESP(idRuangan, wsUrl) {
    if (!wsUrl) return;

    console.log(`[WS] Mencoba terhubung ke ESP ${idRuangan} di ${wsUrl}...`);
    const ws = new WebSocket(wsUrl);

    // Variabel state untuk Heartbeat
    ws.isAlive = false;

    ws.on('open', () => {
        console.log(`[WS] 🟢 Terhubung ke ESP ${idRuangan}`);
        espClients[idRuangan] = ws;
        ws.isAlive = true; 
    });

    // Tanggapan saat ESP membalas Ping dari server
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (data) => {
        try {
            const parsedData = JSON.parse(data.toString());
            // Broadcast ke frontend jika itu data sensor
            if (parsedData.type === 'sensor') {
                teruskanKeFrontend(idRuangan, parsedData);
            }
        } catch (err) {
            console.error(`[WS] Gagal memproses data dari ESP ${idRuangan}:`, err.message);
        }
    });

    ws.on('close', () => {
        console.log(`[WS] 🔴 Koneksi ke ESP ${idRuangan} terputus. Mencoba ulang dalam 5 detik...`);
        espClients[idRuangan] = null;
        
        // Bersihkan interval ping agar tidak terjadi memory leak
        if (ws.pingInterval) clearInterval(ws.pingInterval);
        
        // Auto-Reconnect
        setTimeout(() => hubungkanKeESP(idRuangan, wsUrl), 5000); 
    });

    ws.on('error', (err) => {
        console.error(`[WS] Error pada ESP ${idRuangan}:`, err.message);
        ws.terminate(); 
    });

    // Jalankan Heartbeat setiap 10 detik
    ws.pingInterval = setInterval(() => {
        if (ws.isAlive === false) {
            console.log(`[WS] 👻 Hantu terdeteksi (Zombie Connection) di ESP ${idRuangan}. Memutus paksa...`);
            ws.terminate(); // Paksa masuk ke event 'close' untuk memicu auto-reconnect
            return;
        }

        ws.isAlive = false; // Turunkan status, tunggu pong dari ESP untuk menaikkannya lagi
        ws.ping(); 
    }, 10000);
}

// Inisialisasi koneksi ke mikrokontroler
hubungkanKeESP('ruang_tamu', ESP_RUANG_TAMU_WS);
hubungkanKeESP('dapur', ESP_DAPUR_WS);


// --- 3. FUNGSI DATABASE LOKAL ---
function simpanKeDatabase() {
    // Buang object 'task' sebelum di-stringify agar tidak error
    const dataAman = daftarJadwal.map(j => ({ id: j.id, ruangan: j.ruangan, saklar: j.saklar, status: j.status, waktu: j.waktu }));
    fs.writeFileSync(DB_FILE, JSON.stringify(dataAman, null, 4));
}

function muatDariDatabase() {
    if (fs.existsSync(DB_FILE)) {
        const rawData = fs.readFileSync(DB_FILE, 'utf8');
        if (!rawData || rawData.trim() === '') {
            console.log(`[DATABASE] File kosong. Menginisialisasi ulang...`);
            simpanKeDatabase();
            return;
        }
        try {
            const dataTersimpan = JSON.parse(rawData);
            dataTersimpan.forEach(j => {
                const [jam, menit] = j.waktu.split(':');
                const task = cron.schedule(`${menit} ${jam} * * *`, async () => {
                    console.log(`\n[CRON] Mengeksekusi jadwal: ${j.ruangan} -> ${j.saklar} -> ${j.status}`);
                    try {
                        await axios.post(`http://127.0.0.1:${port}/api/${j.ruangan}/${j.saklar}`, { status: j.status });
                    } catch (error) {
                        console.error("[CRON] Gagal eksekusi:", error.message);
                    }
                });
                daftarJadwal.push({ ...j, task });
            });
            console.log(`[DATABASE] Berhasil memuat ${daftarJadwal.length} jadwal aktif.`);
        } catch (error) {
            console.error(`[DATABASE] JSON Rusak. Mereset ulang...`);
            daftarJadwal = [];
            simpanKeDatabase();
        }
    } else {
        console.log(`[DATABASE] Membuat file jadwal.json baru...`);
        simpanKeDatabase();
    }
}


// --- 4. HELPER FUNCTION IOT ---
async function kirimPerintahKeEsp(idRuangan, servoName, status) {
    if (status !== 'on' && status !== 'off') throw new Error("Status harus 'on' atau 'off'");
    
    const ws = espClients[idRuangan];
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error(`Koneksi ke ESP ${idRuangan} offline atau belum siap.`);
    }

    const payload = JSON.stringify({ target: servoName, state: status });
    console.log(`[WS] Mengirim perintah: ${payload}`);
    ws.send(payload);
    
    return { message: "Perintah terkirim", target: servoName, status: status };
}


// --- 5. ROUTING API (KONTROL MANUAL) ---
app.post('/api/ruang_tamu/saklar1', async (req, res) => { try { res.json(await kirimPerintahKeEsp('ruang_tamu', 'servo1', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/ruang_tamu/saklar2', async (req, res) => { try { res.json(await kirimPerintahKeEsp('ruang_tamu', 'servo2', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/ruang_tamu/saklar3', async (req, res) => { try { res.json(await kirimPerintahKeEsp('ruang_tamu', 'servo3', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/dapur/saklar1', async (req, res) => { try { res.json(await kirimPerintahKeEsp('dapur', 'servo1', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); } });


// --- 6. ROUTING API (CRUD PENJADWALAN) ---
app.post('/api/jadwal', (req, res) => {
    const { ruangan, saklar, status, waktu } = req.body; 
    if (!ruangan || !saklar || !status || !waktu) return res.status(400).json({ error: "Data tidak lengkap!" });

    const [jam, menit] = waktu.split(':');
    const task = cron.schedule(`${menit} ${jam} * * *`, async () => {
        try { await axios.post(`http://127.0.0.1:${port}/api/${ruangan}/${saklar}`, { status }); } catch (error) {}
    });

    const idJadwal = Date.now();
    daftarJadwal.push({ id: idJadwal, ruangan, saklar, status, waktu, task });
    simpanKeDatabase(); 
    res.json({ message: "Jadwal berhasil ditambahkan!" });
});

app.get('/api/jadwal', (req, res) => { 
    res.json(daftarJadwal.map(j => ({ id: j.id, ruangan: j.ruangan, saklar: j.saklar, status: j.status, waktu: j.waktu }))); 
});

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
    const id = parseInt(req.params.id);
    const index = daftarJadwal.findIndex(j => j.id === id);
    
    if (index !== -1) {
        daftarJadwal[index].task.stop(); // Hentikan cron
        daftarJadwal.splice(index, 1);
        simpanKeDatabase(); 
        res.json({ message: "Jadwal berhasil dihapus!" });
    } else {
        res.status(404).json({ error: "Jadwal tidak ditemukan!" });
    }
});


// --- 7. SERVE FRONTEND ---
app.get('/', function (req, res) { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/api/version', (req, res) => { res.json({ version: packageJson.version }); });


// --- 8. INISIALISASI & JALANKAN SERVER ---
muatDariDatabase(); 

// PENTING: Gunakan server.listen agar Express dan WebSocket Frontend berjalan di port yang sama
server.listen(port, '0.0.0.0', function () {
    console.log("=====================================");
    console.log(`🚀 Sapongku API v.${packageJson.version || '1.1.5'} Berjalan!`);
    console.log(`📡 Node Version: ${process.version}`);
    console.log(`🌐 Akses Dashboard: http://localhost:${port}`);
    console.log("=====================================\n");
});
