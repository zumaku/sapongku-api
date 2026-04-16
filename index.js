require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path'); 
const app = express();
const port = 3000;

// --- MENGAMBIL KONFIGURASI DARI .ENV ---
const ESP_RUANG_TAMU_URL = process.env.ESP_RUANG_TAMU_URL; 
const ESP_DAPUR_URL = process.env.ESP_DAPUR_URL;  

// Middleware parsing body
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- DATABASE JADWAL (Disimpan di memori sementara) ---
const daftarJadwal = [];

// --- HELPER FUNCTION ---
async function kirimPerintahKeEsp(targetBaseUrl, servoName, status) {
    if (status !== 'on' && status !== 'off') {
        throw new Error("Status harus 'on' atau 'off'");
    }
    if (!targetBaseUrl) {
        throw new Error("URL ESP belum diatur di .env");
    }

    const targetUrl = targetBaseUrl + "/" + servoName + "/" + status;
    console.log("Mengirim request ke: " + targetUrl);

    try {
        const response = await axios.get(targetUrl, { timeout: 3000 });
        return { message: "Sukses", target: targetUrl, esp_response: response.data };
    } catch (error) {
        console.error("Gagal menghubungi ESP:", error.message);
        return { message: "Gagal", error: error.message };
    }
}

// --- ENDPOINT API KONTROL MANUAL ---
app.post('/api/ruang_tamu/saklar1', async (req, res) => {
    try { res.json(await kirimPerintahKeEsp(ESP_RUANG_TAMU_URL, 'servo1', req.body.status)); } 
    catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/ruang_tamu/saklar2', async (req, res) => {
    try { res.json(await kirimPerintahKeEsp(ESP_RUANG_TAMU_URL, 'servo2', req.body.status)); } 
    catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/ruang_tamu/saklar3', async (req, res) => {
    try { res.json(await kirimPerintahKeEsp(ESP_RUANG_TAMU_URL, 'servo3', req.body.status)); } 
    catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/dapur/saklar1', async (req, res) => {
    try { res.json(await kirimPerintahKeEsp(ESP_DAPUR_URL, 'servo1', req.body.status)); } 
    catch (error) { res.status(400).json({ error: error.message }); }
});

// --- ENDPOINT API PENJADWALAN ---
app.post('/api/jadwal', (req, res) => {
    const { ruangan, saklar, status, waktu } = req.body; 
    
    if (!ruangan || !saklar || !status || !waktu) {
        return res.status(400).json({ error: "Data jadwal tidak lengkap!" });
    }

    const [jam, menit] = waktu.split(':');
    const cronString = `${menit} ${jam} * * *`;

    const task = cron.schedule(cronString, async () => {
        console.log(`\n[CRON] Mengeksekusi jadwal otomatis: ${ruangan} -> ${saklar} -> ${status}`);
        try {
            // Memanggil endpoint API kita sendiri agar logika routing (saklar1 -> servo1) berjalan dengan benar
            const localApiUrl = `http://127.0.0.1:${port}/api/${ruangan}/${saklar}`;
            await axios.post(localApiUrl, { status: status });
        } catch (error) {
            console.error("[CRON] Gagal mengeksekusi jadwal:", error.message);
        }
    });

    const idJadwal = Date.now();
    daftarJadwal.push({ id: idJadwal, ruangan, saklar, status, waktu, task });

    res.json({ message: "Jadwal berhasil ditambahkan!", data: { id: idJadwal, ruangan, saklar, status, waktu } });
});

app.get('/api/jadwal', (req, res) => {
    const jadwalAman = daftarJadwal.map(j => ({ id: j.id, ruangan: j.ruangan, saklar: j.saklar, status: j.status, waktu: j.waktu }));
    res.json(jadwalAman);
});

// --- FRONTEND (DIHUBUNGKAN KE INDEX.HTML) ---
app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- MENJALANKAN SERVER ---
app.listen(port, '0.0.0.0', function () {
    console.log("=====================================");
    console.log("🚀 Sapongku API Berjalan!");
    console.log(`📡 Node Version: ${process.version}`);
    console.log(`🌐 Akses Dashboard: http://localhost:${port}`);
    console.log("=====================================\n");
});