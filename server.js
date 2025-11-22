const express = require('express');
const httpProxy = require('http-proxy');
const path = require('path');

const app = express();
const PORT = 3000;
const COMFY_API = 'http://127.0.0.1:8188';

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
app.use((req, res, next) => {
    const shouldProxy = req.path.startsWith('/upload') || 
                       req.path.startsWith('/prompt') || 
                       req.path.startsWith('/view') || 
                       req.path.startsWith('/ws');
    
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

// Handle WebSocket upgrades
server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/ws')) {
        console.log('Upgrading WebSocket connection...');
        proxy.ws(req, socket, head);
    } else {
        socket.destroy();
    }
});
