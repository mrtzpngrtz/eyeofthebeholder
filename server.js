const express = require('express');
const httpProxy = require('http-proxy');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { Server: OscServer } = require('node-osc');

const app = express();
const PORT = process.env.PORT || 3000;
const OSC_PORT = process.env.OSC_PORT || 3333;
const COMFY_API = process.env.COMFY_API || 'http://127.0.0.1:8188';
const TEMP_DIR = 'E:\\ComfyuiStandalone_2025\\ComfyUI\\temp';

async function cleanTempFolder() {
    try {
        if (!fs.existsSync(TEMP_DIR)) return;
        const files = await fs.promises.readdir(TEMP_DIR);
        const now = Date.now();
        // Delete files older than 30 seconds
        await Promise.all(files.map(async file => {
            try {
                const filePath = path.join(TEMP_DIR, file);
                const stats = await fs.promises.stat(filePath);
                if (now - stats.mtimeMs > 30000) {
                    await fs.promises.unlink(filePath);
                }
            } catch (e) {
                console.error(e);
            }
        }));
        // console.log('Cleaned temp folder'); 
    } catch (err) {
        console.error('Error cleaning temp folder:', err);
    }
}

// Run cleanup every 10 seconds
setInterval(cleanTempFolder, 10000);

// OSC Server
// Only start OSC server if not running in a cloud environment where UDP might be restricted,
// or if specifically configured. For now, we keep it as is but make port configurable.
const oscServer = new OscServer(OSC_PORT, '0.0.0.0', () => {
    console.log(`OSC Server listening on port ${OSC_PORT}`);
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Create Proxy Server
const proxy = httpProxy.createProxyServer({
    target: COMFY_API,
    changeOrigin: true,
    xfwd: false
});

// Proxy Event Handlers
proxy.on('proxyReq', (proxyReq, req, res, options) => {
    // Rewrite headers to look like a direct request
    proxyReq.setHeader('Origin', COMFY_API);
    proxyReq.setHeader('Referer', COMFY_API + '/');
    
    proxyReq.removeHeader('x-forwarded-host');
    proxyReq.removeHeader('x-forwarded-proto');
    proxyReq.removeHeader('x-forwarded-for');
    
    console.log(`HTTP Proxy: ${req.method} ${req.url}`);
});

proxy.on('proxyReqWs', (proxyReq, req, socket, options, head) => {
    proxyReq.setHeader('Origin', COMFY_API);
    proxyReq.setHeader('Referer', COMFY_API + '/');
    console.log('WS Proxy: Headers updated');
});

proxy.on('error', (err, req, res) => {
    console.error('Proxy Error:', err);
    if (res.writeHead) {
        res.writeHead(500, {
            'Content-Type': 'text/plain'
        });
    }
    res.end('Proxy Error: ' + err.message);
});

// Handle API routes
// We use a middleware at root level to check paths so that req.url is not modified
// (app.use('/path', ...) would strip '/path' from req.url)
app.use(async (req, res, next) => {
    const shouldProxy = req.path.startsWith('/upload') || 
                       req.path.startsWith('/prompt') || 
                       req.path.startsWith('/view') || 
                       req.path.startsWith('/ws');
    
    if (req.path.startsWith('/prompt') && req.method === 'POST') {
        proxy.web(req, res);
        return;
    }

    if (shouldProxy) {
        proxy.web(req, res);
    } else {
        next();
    }
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Proxying to ComfyUI at ${COMFY_API}`);
});

// Socket.io setup
const io = new Server(server);

io.on('connection', (socket) => {
    console.log('Client connected to Socket.io');
});

// Forward OSC messages to Socket.io
oscServer.on('message', (msg) => {
    console.log('OSC Message received:', msg);
    io.emit('osc_message', msg);
});

oscServer.on('bundle', (bundle) => {
    console.log('OSC Bundle received');
    bundle.elements.forEach((element) => {
        console.log('Bundle Element:', element);
        io.emit('osc_message', element);
    });
});

// Handle WebSocket upgrades for ComfyUI Proxy
server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/ws')) {
        console.log('Upgrading WebSocket connection...');
        proxy.ws(req, socket, head);
    } 
    // Note: Socket.io handles its own upgrades automatically on other paths
});
