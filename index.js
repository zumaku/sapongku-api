require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path'); 
const app = express();
const port = 3000;

const ESP_RUANG_TAMU_URL = process.env.ESP_RUANG_TAMU_URL; 
const ESP_DAPUR_URL = process.env.ESP_DAPUR_URL;  

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const daftarJadwal = [];

async function kirimPerintahKeEsp(targetBaseUrl, servoName, status) {
    if (status !== 'on' && status !== 'off') throw new Error("Status harus 'on' atau 'off'");
    if (!targetBaseUrl) throw new Error("URL ESP belum diatur di .env");

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

// --- KONTROL MANUAL ---
app.post('/api/ruang_tamu/saklar1', async (req, res) => {
    try { res.json(await kirimPerintahKeEsp(ESP_RUANG_TAMU_URL, 'servo1', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/ruang_tamu/saklar2', async (req, res) => {
    try { res.json(await kirimPerintahKeEsp(ESP_RUANG_TAMU_URL, 'servo2', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/ruang_tamu/saklar3', async (req, res) => {
    try { res.json(await kirimPerintahKeEsp(ESP_RUANG_TAMU_URL, 'servo3', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/dapur/saklar1', async (req, res) => {
    try { res.json(await kirimPerintahKeEsp(ESP_DAPUR_URL, 'servo1', req.body.status)); } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- API CRUD PENJADWALAN ---

// 1. CREATE (Tambah Jadwal)
app.post('/api/jadwal', (req, res) => {
    const { ruangan, saklar, status, waktu } = req.body; 
    if (!ruangan || !saklar || !status || !waktu) return res.status(400).json({ error: "Data jadwal tidak lengkap!" });

    const [jam, menit] = waktu.split(':');
    const task = cron.schedule(`${menit} ${jam} * * *`, async () => {
        console.log(`\n[CRON] Mengeksekusi jadwal otomatis: ${ruangan} -> ${saklar} -> ${status}`);
        try {
            await axios.post(`http://127.0.0.1:${port}/api/${ruangan}/${saklar}`, { status });
        } catch (error) { console.error("[CRON] Gagal mengeksekusi jadwal:", error.message); }
    });

    const idJadwal = Date.now();
    daftarJadwal.push({ id: idJadwal, ruangan, saklar, status, waktu, task });
    res.json({ message: "Jadwal berhasil ditambahkan!" });
});

// 2. READ (Ambil Semua Jadwal)
app.get('/api/jadwal', (req, res) => {
    const jadwalAman = daftarJadwal.map(j => ({ id: j.id, ruangan: j.ruangan, saklar: j.saklar, status: j.status, waktu: j.waktu }));
    res.json(jadwalAman);
});

// 3. UPDATE (Edit Jadwal)
app.put('/api/jadwal/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { ruangan, saklar, status, waktu } = req.body;
    const index = daftarJadwal.findIndex(j => j.id === id);

    if (index === -1) return res.status(404).json({ error: "Jadwal tidak ditemukan!" });
    if (!ruangan || !saklar || !status || !waktu) return res.status(400).json({ error: "Data tidak lengkap!" });

    // Hentikan cron job lama
    daftarJadwal[index].task.stop();

    // Buat cron job baru
    const [jam, menit] = waktu.split(':');
    const newTask = cron.schedule(`${menit} ${jam} * * *`, async () => {
        console.log(`\n[CRON] Mengeksekusi jadwal (Update): ${ruangan} -> ${saklar} -> ${status}`);
        try {
            await axios.post(`http://127.0.0.1:${port}/api/${ruangan}/${saklar}`, { status });
        } catch (error) { console.error("[CRON] Gagal mengeksekusi jadwal:", error.message); }
    });

    // Perbarui data di array
    daftarJadwal[index] = { id, ruangan, saklar, status, waktu, task: newTask };
    res.json({ message: "Jadwal berhasil diperbarui!" });
});

// 4. DELETE (Hapus Jadwal)
app.delete('/api/jadwal/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const index = daftarJadwal.findIndex(j => j.id === id);

    if (index !== -1) {
        // Hentikan cron job agar tidak berjalan lagi
        daftarJadwal[index].task.stop();
        // Hapus dari array
        daftarJadwal.splice(index, 1);
        res.json({ message: "Jadwal berhasil dihapus!" });
    } else {
        res.status(404).json({ error: "Jadwal tidak ditemukan!" });
    }
});

// --- SERVE FRONTEND ---
app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, '0.0.0.0', function () {
    console.log("=====================================");
    console.log("🚀 Sapongku API Berjalan!");
    console.log(`📡 Node Version: ${process.version}`);
    console.log(`🌐 Akses Dashboard: http://localhost:${port}`);
    console.log("=====================================\n");
});