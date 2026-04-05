require('dotenv').config();

const express = require('express');
const axios = require('axios');
const app = express();
const port = 3000;

// --- MENGAMBIL KONFIGURASI DARI .ENV ---
const ESP_RUANG_TAMU_URL = process.env.ESP_RUANG_TAMU_URL; 
const ESP_DAPUR_URL = process.env.ESP_DAPUR_URL;  

// Middleware parsing body
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- HELPER FUNCTION ---
async function kirimPerintahKeEsp(targetBaseUrl, servoName, status) {
    // Validasi input
    if (status !== 'on' && status !== 'off') {
        throw new Error("Status harus 'on' atau 'off'");
    }

    const targetUrl = targetBaseUrl + "/" + servoName + "/" + status;
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

// --- ENDPOINT API RUANG TAMU ---

app.post('/api/ruang_tamu/saklar1', async function (req, res) {
    try {
        const result = await kirimPerintahKeEsp(ESP_RUANG_TAMU_URL, 'servo1', req.body.status);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/ruang_tamu/saklar2', async function (req, res) {
    try {
        const result = await kirimPerintahKeEsp(ESP_RUANG_TAMU_URL, 'servo2', req.body.status);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/ruang_tamu/saklar3', async function (req, res) {
    try {
        // Saklar 3 dikirim ke ESP_RUANG_TAMU_URL
        const result = await kirimPerintahKeEsp(ESP_RUANG_TAMU_URL, 'servo3', req.body.status);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// --- ENDPOINT API DAPUR ---

app.post('/api/dapur/saklar1', async function (req, res) {
    try {
        // Saklar Dapur dikirim ke ESP_DAPUR_URL
        const result = await kirimPerintahKeEsp(ESP_DAPUR_URL, 'servo1', req.body.status);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// --- FRONTEND ---
app.get('/', function (req, res) {
    res.send(`
   <!DOCTYPE html>
    <html lang="id">
    <head>
        <title>Sapongku Smart Control</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            :root {
                --bg-main: #0f172a;
                --bg-card: #1e293b;
                --text-main: #f8fafc;
                --text-muted: #94a3b8;
                --accent-on: #10b981;
                --accent-on-hover: #059669;
                --accent-off: #ef4444;
                --accent-off-hover: #dc2626;
                --border-color: #334155;
            }
            body { 
                font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; 
                text-align: center; 
                padding: 20px 15px; 
                background: var(--bg-main); 
                color: var(--text-main); 
                margin: 0; 
            }
            .header-title { margin-bottom: 35px; font-weight: 700; letter-spacing: 0.5px; font-size: 26px; }
            .header-subtitle { color: var(--text-muted); font-size: 14px; }
            
            .grid-container { 
                display: flex; 
                flex-wrap: wrap; 
                justify-content: center; 
                gap: 15px; 
                max-width: 800px;
                margin: 0 auto;
            }
            
            .card { 
                background: var(--bg-card); 
                padding: 20px; 
                width: 100%; 
                max-width: 260px; 
                border-radius: 16px; 
                box-shadow: 0 10px 25px rgba(0,0,0,0.2); 
                border: 1px solid var(--border-color);
                transition: transform 0.2s ease, box-shadow 0.2s ease;
            }
            .card:hover { transform: translateY(-3px); box-shadow: 0 12px 30px rgba(0,0,0,0.3); }
            .card h3 { 
                margin-top: 0; 
                font-size: 15px; 
                color: var(--text-main); 
                margin-bottom: 18px; 
                font-weight: 600; 
                display: flex; 
                justify-content: center; 
                align-items: center; 
                gap: 8px;
            }
            
            .btn-group { display: flex; gap: 10px; }
            button { 
                flex: 1; 
                padding: 12px; 
                border: none; 
                cursor: pointer; 
                color: white; 
                font-size: 14px; 
                font-weight: 600; 
                border-radius: 10px; 
                transition: all 0.2s ease; 
            }
            .btn-on { background: var(--accent-on); box-shadow: 0 4px 12px rgba(16, 185, 129, 0.15); }
            .btn-on:active { background: var(--accent-on-hover); transform: scale(0.95); }
            .btn-off { background: var(--accent-off); box-shadow: 0 4px 12px rgba(239, 68, 68, 0.15); }
            .btn-off:active { background: var(--accent-off-hover); transform: scale(0.95); }
            
            #log-container { 
                margin-top: 40px; 
                padding: 16px; 
                background: #020617; 
                border-radius: 12px; 
                font-size: 13px; 
                border: 1px solid var(--border-color);
                max-width: 500px; 
                margin-left: auto; 
                margin-right: auto;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
                text-align: left;
                position: relative;
            }
            .log-header { color: #64748b; margin-bottom: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
            #log { color: #38bdf8; font-weight: 500; word-break: break-all; line-height: 1.5; }
            .status-indicator { position: absolute; top: 16px; right: 16px; width: 8px; height: 8px; background: #10b981; border-radius: 50%; box-shadow: 0 0 8px #10b981; animation: pulse 2s infinite; }
            
            @keyframes pulse { 0% { opacity: 0.5; } 50% { opacity: 1; } 100% { opacity: 0.5; } }
        </style>
    </head>
    <body>
        <h1 class="header-title">
            ⚡ Sapongku Control Panel
            <span class="header-subtitle">v1.1</span>
        </h1>
        

        <div class="grid-container">
            <div class="card">
                <h3>🛋️ Ruang Tamu</h3>
                <div class="btn-group">
                    <button class="btn-on" onclick="kirim('ruang_tamu', 'saklar1', 'on')">ON</button>
                    <button class="btn-off" onclick="kirim('ruang_tamu', 'saklar1', 'off')">OFF</button>
                </div>
            </div>
            
            <div class="card">
                <h3>🪑 Teras</h3>
                <div class="btn-group">
                    <button class="btn-on" onclick="kirim('ruang_tamu', 'saklar2', 'on')">ON</button>
                    <button class="btn-off" onclick="kirim('ruang_tamu', 'saklar2', 'off')">OFF</button>
                </div>
            </div>
            
            <div class="card">
                <h3>🛏️ Kamar</h3>
                <div class="btn-group">
                    <button class="btn-on" onclick="kirim('ruang_tamu', 'saklar3', 'on')">ON</button>
                    <button class="btn-off" onclick="kirim('ruang_tamu', 'saklar3', 'off')">OFF</button>
                </div>
            </div>

            <div class="card">
                <h3>🍱 Dapur</h3>
                <div class="btn-group">
                    <button class="btn-on" onclick="kirim('dapur', 'saklar1', 'on')">ON</button>
                    <button class="btn-off" onclick="kirim('dapur', 'saklar1', 'off')">OFF</button>
                </div>
            </div>
        </div>

        <div id="log-container">
            <div class="status-indicator" id="indicator"></div>
            <div class="log-header">Terminal Status</div>
            <div id="log">Sistem berjalan. Menunggu perintah...</div>
        </div>

        <script>
            function kirim(ruangan, saklar, status) {
                const logEl = document.getElementById('log');
                const indicator = document.getElementById('indicator');
                
                logEl.innerText = "> Mengirim perintah " + status.toUpperCase() + " ke " + ruangan + " (" + saklar + ")...";
                logEl.style.color = "#fbbf24"; 
                indicator.style.background = "#fbbf24";
                indicator.style.boxShadow = "0 0 8px #fbbf24";

                fetch('/api/' + ruangan + '/' + saklar, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: status })
                })
                .then(res => res.json())
                .then(data => {
                    if(data.error) {
                        logEl.innerText = "> Error: " + data.error;
                        logEl.style.color = "#f87171"; 
                        indicator.style.background = "#ef4444";
                        indicator.style.boxShadow = "0 0 8px #ef4444";
                    } else {
                        logEl.innerText = "> Sukses terhubung: " + data.target;
                        logEl.style.color = "#34d399"; 
                        indicator.style.background = "#10b981";
                        indicator.style.boxShadow = "0 0 8px #10b981";
                    }
                })
                .catch(err => {
                    logEl.innerText = "> Gagal: Tidak ada koneksi ke server Termux";
                    logEl.style.color = "#f87171";
                    indicator.style.background = "#ef4444";
                    indicator.style.boxShadow = "0 0 8px #ef4444";
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
