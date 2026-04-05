const express = require('express');
const axios = require('axios');
const app = express();
const port = 3000;

// --- KONFIGURASI IP IOT ---
// Ganti dengan IP ESP8266/Arduino kamu
const ESP_BASE_URL = "http://192.168.43.12";

// Middleware parsing body (Express 4.16+ sudah support ini)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- HELPER FUNCTION ---
async function kirimPerintahKeEsp(servoName, status) {
    // Validasi input
    if (status !== 'on' && status !== 'off') {
        throw new Error("Status harus 'on' atau 'off'");
    }

    const targetUrl = ESP_BASE_URL + "/" + servoName + "/" + status;
    console.log("Mengirim request ke: " + targetUrl);

    try {
        // Timeout 3 detik
        const response = await axios.get(targetUrl, { timeout: 3000 });
        return { message: "Sukses", target: targetUrl, esp_response: response.data };
    } catch (error) {
        console.error("Gagal menghubungi ESP:", error.message);
        // Mengembalikan pesan error agar tidak crash
        return { message: "Gagal", error: error.message };
    }
}

// --- ENDPOINT API ---

app.post('/api/ruang_tamu/saklar1', async function (req, res) {
    const status = req.body.status;
    try {
        const result = await kirimPerintahKeEsp('servo1', status);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/ruang_tamu/saklar2', async function (req, res) {
    const status = req.body.status;
    try {
        const result = await kirimPerintahKeEsp('servo2', status);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// --- FRONTEND ---
app.get('/', function (req, res) {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Sapongku Control</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: sans-serif; text-align: center; padding: 20px; background: #f4f4f4; }
            .card { background: white; padding: 20px; margin: 10px auto; max-width: 400px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
            button { width: 45%; padding: 15px; margin: 5px; border: none; cursor: pointer; color: white; font-size: 16px; border-radius: 4px; }
            .btn-on { background: #28a745; }
            .btn-off { background: #dc3545; }
        </style>
    </head>
    <body>
        <h1>Sapongku API (Node 13)</h1>
        <div class="card">
            <h3>Saklar 1</h3>
            <button class="btn-on" onclick="kirim('saklar1', 'on')">NYALA</button>
            <button class="btn-off" onclick="kirim('saklar1', 'off')">MATI</button>
        </div>
        <div class="card">
            <h3>Saklar 2</h3>
            <button class="btn-on" onclick="kirim('saklar2', 'on')">NYALA</button>
            <button class="btn-off" onclick="kirim('saklar2', 'off')">MATI</button>
        </div>
        <p id="log" style="color: grey; font-size: 12px; margin-top: 20px;">Siap...</p>
        <script>
            function kirim(saklar, status) {
                document.getElementById('log').innerText = "Mengirim...";
                fetch('/api/ruang_tamu/' + saklar, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: status })
                })
                .then(res => res.json())
                .then(data => {
                    document.getElementById('log').innerText = data.error ? "Error: " + data.error : "Sukses: " + data.target;
                })
                .catch(err => {
                    document.getElementById('log').innerText = "Gagal koneksi ke server Termux";
                });
            }
        </script>
    </body>
    </html>
    `);
});

app.listen(port, '0.0.0.0', function () {
    console.log("Server berjalan di Node " + process.version);
    console.log("Akses di http://localhost:" + port);
});
