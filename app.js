require('dotenv').config();

const packageJson = require('./package.json');
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path'); 
const fs = require('fs'); // <-- Memuat modul File System bawaan Node.js
const app = express();
const port = 3000;

const ESP_RUANG_TAMU_URL = process.env.ESP_RUANG_TAMU_URL; 
const ESP_DAPUR_URL = process.env.ESP_DAPUR_URL;  
const DB_FILE = path.join(__dirname, 'jadwal.json'); // <-- Path file database JSON kita

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let daftarJadwal = [];

// --- FUNGSI DATABASE LOKAL ---

// Fungsi menyimpan data ke file JSON
function simpanKeDatabase() {
    // Kita hapus object 'task' (cron) karena tidak bisa dan tidak perlu di-save ke JSON
    const dataAman = daftarJadwal.map(j => ({ 
        id: j.id, ruangan: j.ruangan, saklar: j.saklar, status: j.status, waktu: j.waktu 
    }));
    fs.writeFileSync(DB_FILE, JSON.stringify(dataAman, null, 4));
}

// Fungsi memuat data dari JSON saat server pertama kali menyala
function muatDariDatabase() {
    if (fs.existsSync(DB_FILE)) {
        const rawData = fs.readFileSync(DB_FILE, 'utf8');

        // PENGAMAN 1: Jika file ada tapi isinya kosong
        if (!rawData || rawData.trim() === '') {
            console.log(`[DATABASE] File jadwal.json kosong. Menginisialisasi ulang...`);
            simpanKeDatabase(); // Ini akan menuliskan "[]" ke dalam file
            return;
        }

        // PENGAMAN 2: Tangkap error jika format JSON rusak
        try {
            const dataTersimpan = JSON.parse(rawData);

            dataTersimpan.forEach(j => {
                const [jam, menit] = j.waktu.split(':');
                const task = cron.schedule(`${menit} ${jam} * * *`, async () => {
                    console.log(`\n[CRON] Mengeksekusi jadwal otomatis: ${j.ruangan} -> ${j.saklar} -> ${j.status}`);
                    try {
                        await axios.post(`http://127.0.0.1:${port}/api/${j.ruangan}/${j.saklar}`, { status: j.status });
                    } catch (error) { console.error("[CRON] Gagal:", error.message); }
                });

                daftarJadwal.push({ ...j, task });
            });
            console.log(`[DATABASE] Berhasil memuat ${daftarJadwal.length} jadwal aktif.`);
        } catch (error) {
            console.error(`[DATABASE] Error membaca JSON (File rusak). Mereset ulang data...`);
            daftarJadwal = []; // Kosongkan jadwal di memori
            simpanKeDatabase(); // Timpa file yang rusak dengan format JSON yang benar
        }

    } else {
        console.log(`[DATABASE] File jadwal.json belum ada. Membuat baru...`);
        simpanKeDatabase();
    }
}


// --- HELPER FUNCTION IOT ---
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

app.post('/api/jadwal', (req, res) => {
    const { ruangan, saklar, status, waktu } = req.body; 
    if (!ruangan || !saklar || !status || !waktu) return res.status(400).json({ error: "Data jadwal tidak lengkap!" });

    const [jam, menit] = waktu.split(':');
    const task = cron.schedule(`${menit} ${jam} * * *`, async () => {
        console.log(`\n[CRON] Mengeksekusi jadwal otomatis: ${ruangan} -> ${saklar} -> ${status}`);
        try { await axios.post(`http://127.0.0.1:${port}/api/${ruangan}/${saklar}`, { status }); } 
        catch (error) { console.error("[CRON] Gagal:", error.message); }
    });

    const idJadwal = Date.now();
    daftarJadwal.push({ id: idJadwal, ruangan, saklar, status, waktu, task });
    
    simpanKeDatabase(); // <-- Simpan ke JSON

    res.json({ message: "Jadwal berhasil ditambahkan!" });
});

app.get('/api/jadwal', (req, res) => {
    const jadwalAman = daftarJadwal.map(j => ({ id: j.id, ruangan: j.ruangan, saklar: j.saklar, status: j.status, waktu: j.waktu }));
    res.json(jadwalAman);
});

app.put('/api/jadwal/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { ruangan, saklar, status, waktu } = req.body;
    const index = daftarJadwal.findIndex(j => j.id === id);

    if (index === -1) return res.status(404).json({ error: "Jadwal tidak ditemukan!" });
    if (!ruangan || !saklar || !status || !waktu) return res.status(400).json({ error: "Data tidak lengkap!" });

    daftarJadwal[index].task.stop();

    const [jam, menit] = waktu.split(':');
    const newTask = cron.schedule(`${menit} ${jam} * * *`, async () => {
        console.log(`\n[CRON] Mengeksekusi jadwal (Update): ${ruangan} -> ${saklar} -> ${status}`);
        try { await axios.post(`http://127.0.0.1:${port}/api/${ruangan}/${saklar}`, { status }); } 
        catch (error) { console.error("[CRON] Gagal:", error.message); }
    });

    daftarJadwal[index] = { id, ruangan, saklar, status, waktu, task: newTask };
    
    simpanKeDatabase(); // <-- Simpan ke JSON

    res.json({ message: "Jadwal berhasil diperbarui!" });
});

app.delete('/api/jadwal/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const index = daftarJadwal.findIndex(j => j.id === id);

    if (index !== -1) {
        daftarJadwal[index].task.stop();
        daftarJadwal.splice(index, 1);
        
        simpanKeDatabase(); // <-- Simpan ke JSON
        
        res.json({ message: "Jadwal berhasil dihapus!" });
    } else {
        res.status(404).json({ error: "Jadwal tidak ditemukan!" });
    }
});

// --- SERVE FRONTEND ---
app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint untuk mengirim versi ke frontend
app.get('/api/version', (req, res) => {
    res.json({ version: packageJson.version });
});

// --- INISIALISASI & MENJALANKAN SERVER ---
muatDariDatabase(); // <-- Panggil fungsi pemuatan data sebelum server menyala

app.listen(port, '0.0.0.0', function () {
    console.log("=====================================");
    console.log(`🚀 Sapongku API v.${packageJson.version} Berjalan!`);
    console.log(`📡 Node Version: ${process.version}`);
    console.log(`🌐 Akses Dashboard: http://localhost:${port}`);
    console.log("=====================================\n");
});