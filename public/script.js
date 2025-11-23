const COMFY_API = ''; // Relative path to use proxy
let clientId = crypto.randomUUID();
let ws;
let socket; // Socket.io
let isProcessing = false;
let needsUpdate = false;
let pollingInterval = 100; // Default to 100ms to be safe
let lastPromptTime = 0;
let inputMode = 'mouse'; // 'mouse' or 'osc'

// Store current normalized coordinates (0-1)
let oscX = 0.5;
let oscY = 0.5;

// Expression Editor Parameters Mapping
// Updated based on actual node definition
const EXPRESSION_PARAMS = [
    // Head
    { name: 'Rotate Pitch', category: 'Head', index: 0, min: -20, max: 20, step: 0.5, default: 0 },
    { name: 'Rotate Yaw', category: 'Head', index: 1, min: -20, max: 20, step: 0.5, default: 0 },
    { name: 'Rotate Roll', category: 'Head', index: 2, min: -20, max: 20, step: 0.5, default: 0 },
    // Face
    { name: 'Blink', category: 'Face', index: 3, min: -20, max: 5, step: 0.5, default: 0 },
    { name: 'Eyebrow', category: 'Face', index: 4, min: -10, max: 15, step: 0.5, default: 0 },
    { name: 'Wink', category: 'Face', index: 5, min: 0, max: 25, step: 0.5, default: 0 },
    { name: 'Pupil X', category: 'Face', index: 6, min: -15, max: 15, step: 0.5, default: 0 },
    { name: 'Pupil Y', category: 'Face', index: 7, min: -15, max: 15, step: 0.5, default: 0 },
    { name: 'AAA', category: 'Face', index: 8, min: -30, max: 120, step: 1, default: 0 },
    { name: 'EEE', category: 'Face', index: 9, min: -20, max: 15, step: 0.2, default: 0 },
    { name: 'WOO', category: 'Face', index: 10, min: -20, max: 15, step: 0.2, default: 0 },
    { name: 'Smile', category: 'Face', index: 11, min: -0.3, max: 1.3, step: 0.01, default: 0 },
    // Image
    { name: 'Src Ratio', category: 'Image', index: 12, min: 0, max: 1, step: 0.01, default: 1 },
    { name: 'Sample Ratio', category: 'Image', index: 13, min: 0, max: 1, step: 0.01, default: 1 },
    { name: 'Crop Factor', category: 'Image', index: 14, min: 1.5, max: 3, step: 0.1, default: 2 }
];

// Load the workflow template
let workflowTemplate = null;

document.addEventListener('DOMContentLoaded', async () => {
    await loadWorkflowTemplate();
    initSliders();
    setupWebSocket();
    setupSocketIO();
    setupEventListeners();
});

async function loadWorkflowTemplate() {
    try {
        // Add timestamp to prevent caching
        const response = await fetch(`workflow.json?t=${Date.now()}`);
        if (!response.ok) throw new Error('Failed to load workflow template');
        workflowTemplate = await response.json();
    } catch (error) {
        console.error('Error loading workflow:', error);
        updateStatus('Error loading workflow template', 'error');
    }
}

function initSliders() {
    const container = document.getElementById('slidersContainer');
    let currentCategory = null;
    let currentColumn = null;
    
    EXPRESSION_PARAMS.forEach(param => {
        if (param.category !== currentCategory) {
            currentCategory = param.category;
            
            // Create new column for category
            currentColumn = document.createElement('div');
            currentColumn.className = 'category-column';
            
            const header = document.createElement('div');
            header.className = 'category-header';
            header.textContent = currentCategory;
            currentColumn.appendChild(header);
            
            container.appendChild(currentColumn);
        }

        const group = document.createElement('div');
        group.className = 'slider-group';
        
        const label = document.createElement('label');
        label.innerHTML = `${param.name} <span id="val-${param.index}">${param.default}</span>`;
        
        const input = document.createElement('input');
        input.type = 'range';
        input.min = param.min;
        input.max = param.max;
        input.step = param.step;
        input.value = param.default;
        input.id = `param-${param.index}`;
        
        input.addEventListener('input', (e) => {
            document.getElementById(`val-${param.index}`).textContent = e.target.value;
            scheduleUpdate();
        });

        group.appendChild(label);
        group.appendChild(input);
        currentColumn.appendChild(group);
    });
}

function setupWebSocket() {
    // Connect to the proxy server's WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws?clientId=${clientId}`);
    
    ws.onopen = () => {
        updateStatus('Connected to ComfyUI', 'success');
    };

    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        
        if (message.type === 'executing') {
            if (message.data.node === null) {
                updateStatus('Generation Complete');
                setLoading(false);
                isProcessing = false;
                // Add a small mandatory cooldown to prevent socket exhaustion
                setTimeout(processQueue, 50); 
            }
        } else if (message.type === 'executed') {
            if (message.data.node === '32') { // PreviewImage node ID
                const images = message.data.output.images;
                if (images && images.length > 0) {
                    const img = images[0];
                    // Add timestamp to force reload if filename is static
                    const imageUrl = `${COMFY_API}/view?filename=${img.filename}&type=${img.type}&subfolder=${img.subfolder}&t=${Date.now()}`;
                    document.getElementById('resultImage').src = imageUrl;
                }
            }
        }
    };

    ws.onclose = () => {
        updateStatus('Disconnected. Reconnecting...', 'error');
        setTimeout(setupWebSocket, 1000);
    };
}

function setupSocketIO() {
    socket = io();
    
    socket.on('connect', () => {
        console.log('Connected to Socket.io for OSC');
        const status = document.getElementById('oscConnection');
        if (status) {
            status.textContent = 'Connected';
            status.style.color = '#4caf50';
        }
    });

    socket.on('disconnect', () => {
        const status = document.getElementById('oscConnection');
        if (status) {
            status.textContent = 'Disconnected';
            status.style.color = '#ff6b6b';
        }
    });

    socket.on('osc_message', (msg) => {
        // Flash activity
        const indicator = document.getElementById('oscActivity');
        if (indicator) {
            indicator.style.background = '#00ff00';
            setTimeout(() => {
                indicator.style.background = '#333';
            }, 100);
        }

        // Handle TouchDesigner style: separate messages for /x and /y
        // msg format: [address, val]
        
        const address = msg[0];
        let value = msg.length > 1 ? msg[1] : null;

        // Update X
        if (address.endsWith('/x') || address === 'x') {
            if (typeof value === 'number') {
                oscX = value;
                updateFromOsc();
            }
        } 
        // Update Y
        else if (address.endsWith('/y') || address === 'y') {
            if (typeof value === 'number') {
                oscY = value;
                updateFromOsc();
            }
        }
        // Handle bundled format: ['/pos', x, y]
        else if (msg.length >= 3) {
            const x = msg[1];
            const y = msg[2];
            if (typeof x === 'number' && typeof y === 'number') {
                oscX = x;
                oscY = y;
                updateFromOsc();
            }
        }
    });
}

function updateFromOsc() {
    // Update Debug Display
    const debugVal = document.getElementById('oscValues');
    if (debugVal) {
        debugVal.textContent = `X: ${oscX.toFixed(3)} | Y: ${oscY.toFixed(3)}`;
    }

    if (inputMode !== 'osc') return;

    // Map normalized (0-1) to screen coordinates
    const screenX = oscX * window.innerWidth;
    const screenY = oscY * window.innerHeight;
    
    updateTargetPosition(screenX, screenY);
    updateGazeParams(screenX, screenY);
}

function setupEventListeners() {
    const pollingRateInput = document.getElementById('pollingRate');
    if (pollingRateInput) {
        // Set initial value to match safe default
        pollingRateInput.value = Math.max(pollingInterval, parseInt(pollingRateInput.value));
        document.getElementById('pollingVal').textContent = pollingInterval;
        
        pollingRateInput.addEventListener('input', (e) => {
            // Enforce minimum limit to prevent port exhaustion
            let val = parseInt(e.target.value);
            if (val < 50) val = 50; 
            pollingInterval = val;
            document.getElementById('pollingVal').textContent = pollingInterval;
        });
    }

    const imageInput = document.getElementById('imageInput');
    const generateBtn = document.getElementById('generateBtn');
    const trackingToggle = document.getElementById('trackingToggle');

    if (trackingToggle) {
        trackingToggle.addEventListener('change', (e) => {
            const cursor = document.getElementById('customCursor');
            if (cursor) {
                cursor.style.display = e.target.checked ? 'block' : 'none';
            }
        });
    }

    // Input Source Switching
    const inputRadios = document.getElementsByName('inputSource');
    inputRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.checked) {
                inputMode = e.target.value;
                console.log('Input mode switched to:', inputMode);
            }
        });
    });

    imageInput.addEventListener('change', handleImageUpload);
    generateBtn.addEventListener('click', () => queuePrompt(false));
    
    // Wink button listener
    const winkBtn = document.getElementById('winkBtn');
    if (winkBtn) {
        winkBtn.addEventListener('click', animateWink);
    }

    // Kiss button listener
    const kissBtn = document.getElementById('kissBtn');
    if (kissBtn) {
        kissBtn.addEventListener('click', animateKiss);
    }

    // Smiley button listener
    const smileyBtn = document.getElementById('smileyBtn');
    if (smileyBtn) {
        smileyBtn.addEventListener('click', animateSmiley);
    }

    // Wow button listener
    const wowBtn = document.getElementById('wowBtn');
    if (wowBtn) {
        wowBtn.addEventListener('click', animateWow);
    }

    // Initialize Gaze Target Dragging
    initGazeTarget();

    // Reset button
    const resetBtn = document.getElementById('resetBtn');
    if (resetBtn) {
        resetBtn.addEventListener('click', resetExpression);
    }

    // Menu Toggle
    const menuBtn = document.getElementById('menuBtn');
    const sidebar = document.getElementById('controlsSidebar');
    if (menuBtn && sidebar) {
        menuBtn.addEventListener('click', () => {
            sidebar.classList.toggle('open');
        });
    }
}

function resetExpression() {
    EXPRESSION_PARAMS.forEach(param => {
        if (param.category !== 'Image') {
            const input = document.getElementById(`param-${param.index}`);
            const val = document.getElementById(`val-${param.index}`);
            if (input && val) {
                input.value = param.default;
                val.textContent = param.default;
            }
        }
    });
    scheduleUpdate();
}

function initGazeTarget() {
    const target = document.getElementById('customCursor');
    let isDragging = false;

    // Initial Position (Center)
    let targetX = window.innerWidth / 2;
    let targetY = window.innerHeight / 2;
    updateTargetPosition(targetX, targetY);

    target.addEventListener('mousedown', (e) => {
        isDragging = true;
        target.style.cursor = 'grabbing';
        e.preventDefault(); // Prevent selection
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
        target.style.cursor = 'grab';
    });

    document.addEventListener('mousemove', (e) => {
        if (inputMode !== 'mouse') return;
        if (!isDragging) return;
        
        // Update target position
        targetX = e.clientX;
        targetY = e.clientY;
        updateTargetPosition(targetX, targetY);
        
        // Update Parameters based on target position
        updateGazeParams(targetX, targetY);
    });
}

function updateTargetPosition(x, y) {
    const target = document.getElementById('customCursor');
    if (target) {
        target.style.left = x + 'px';
        target.style.top = y + 'px';
    }
}

function updateGazeParams(x, y) {
    if (!window.uploadedFilename) return;

    const width = window.innerWidth;
    const height = window.innerHeight;
    
    // Map X to -15 to 15 (Pupils) and -10 to 10 (Yaw)
    const pupilX = ((x / width) * 30) - 15;
    const rotateYaw = ((x / width) * 20) - 10;
    
    // Map Y to 15 to -15 (Pupils) and -10 to 10 (Pitch)
    const pupilY = 15 - ((y / height) * 30);
    const rotatePitch = ((y / height) * 20) - 10;

    // Update Sliders
    const pX = EXPRESSION_PARAMS.find(p => p.name === 'Pupil X');
    const pY = EXPRESSION_PARAMS.find(p => p.name === 'Pupil Y');
    const rYaw = EXPRESSION_PARAMS.find(p => p.name === 'Rotate Yaw');
    const rPitch = EXPRESSION_PARAMS.find(p => p.name === 'Rotate Pitch');
    
    if (pX) {
        const input = document.getElementById(`param-${pX.index}`);
        input.value = pupilX;
        document.getElementById(`val-${pX.index}`).textContent = pupilX.toFixed(1);
    }
    if (pY) {
        const input = document.getElementById(`param-${pY.index}`);
        input.value = pupilY;
        document.getElementById(`val-${pY.index}`).textContent = pupilY.toFixed(1);
    }
    if (rYaw) {
        const input = document.getElementById(`param-${rYaw.index}`);
        input.value = rotateYaw;
        document.getElementById(`val-${rYaw.index}`).textContent = rotateYaw.toFixed(1);
    }
    if (rPitch) {
        const input = document.getElementById(`param-${rPitch.index}`);
        input.value = rotatePitch;
        document.getElementById(`val-${rPitch.index}`).textContent = rotatePitch.toFixed(1);
    }

    scheduleUpdate();
}

function animateWink() {
    if (!window.uploadedFilename) return;

    const winkParam = EXPRESSION_PARAMS.find(p => p.name === 'Wink');
    if (!winkParam) return;

    const input = document.getElementById(`param-${winkParam.index}`);
    const valDisplay = document.getElementById(`val-${winkParam.index}`);
    const startTime = performance.now();
    const duration = 2000; // 2 seconds

    function update(currentTime) {
        const elapsed = currentTime - startTime;
        
        if (elapsed >= duration) {
            input.value = 0;
            valDisplay.textContent = "0";
            scheduleUpdate();
            return;
        }
        
        let value;
        if (elapsed < duration / 2) {
            // 0 to 20
            value = (elapsed / (duration / 2)) * 20;
        } else {
            // 20 to 0
            value = 20 - ((elapsed - duration / 2) / (duration / 2)) * 20;
        }
        
        input.value = value;
        valDisplay.textContent = value.toFixed(1);
        scheduleUpdate();
        
        requestAnimationFrame(update);
    }
    
    requestAnimationFrame(update);
}

function animateKiss() {
    if (!window.uploadedFilename) return;

    const eeeParam = EXPRESSION_PARAMS.find(p => p.name === 'EEE');
    const wooParam = EXPRESSION_PARAMS.find(p => p.name === 'WOO');
    
    if (!eeeParam || !wooParam) return;

    const eeeInput = document.getElementById(`param-${eeeParam.index}`);
    const eeeVal = document.getElementById(`val-${eeeParam.index}`);
    const wooInput = document.getElementById(`param-${wooParam.index}`);
    const wooVal = document.getElementById(`val-${wooParam.index}`);

    const startTime = performance.now();
    const duration = 2000; // 2 seconds

    function update(currentTime) {
        const elapsed = currentTime - startTime;
        
        if (elapsed >= duration) {
            // Reset to 0
            eeeInput.value = 0;
            eeeVal.textContent = "0";
            wooInput.value = 0;
            wooVal.textContent = "0";
            scheduleUpdate();
            return;
        }
        
        let eeeValue, wooValue;
        
        if (elapsed < duration / 2) {
            // First half: Go to target
            // EEE: 0 to -8
            eeeValue = (elapsed / (duration / 2)) * -8;
            // WOO: 0 to 7
            wooValue = (elapsed / (duration / 2)) * 7;
        } else {
            // Second half: Return to 0
            // EEE: -8 to 0
            eeeValue = -8 - ((elapsed - duration / 2) / (duration / 2)) * -8;
            // WOO: 7 to 0
            wooValue = 7 - ((elapsed - duration / 2) / (duration / 2)) * 7;
        }
        
        eeeInput.value = eeeValue;
        eeeVal.textContent = eeeValue.toFixed(1);
        
        wooInput.value = wooValue;
        wooVal.textContent = wooValue.toFixed(1);
        
        scheduleUpdate();
        
        requestAnimationFrame(update);
    }
    
    requestAnimationFrame(update);
}

function animateSmiley() {
    if (!window.uploadedFilename) return;

    const smileParam = EXPRESSION_PARAMS.find(p => p.name === 'Smile');
    if (!smileParam) return;

    const input = document.getElementById(`param-${smileParam.index}`);
    const valDisplay = document.getElementById(`val-${smileParam.index}`);
    const startTime = performance.now();
    const duration = 1000; // 1 second (faster)

    function update(currentTime) {
        const elapsed = currentTime - startTime;
        
        if (elapsed >= duration) {
            input.value = 0;
            valDisplay.textContent = "0";
            scheduleUpdate();
            return;
        }
        
        let value;
        if (elapsed < duration / 2) {
            // 0 to 0.65
            value = (elapsed / (duration / 2)) * 0.65;
        } else {
            // 0.65 to 0
            value = 0.65 - ((elapsed - duration / 2) / (duration / 2)) * 0.65;
        }
        
        input.value = value;
        valDisplay.textContent = value.toFixed(2);
        scheduleUpdate();
        
        requestAnimationFrame(update);
    }
    
    requestAnimationFrame(update);
}

function animateWow() {
    if (!window.uploadedFilename) return;

    const blinkParam = EXPRESSION_PARAMS.find(p => p.name === 'Blink');
    const eyebrowParam = EXPRESSION_PARAMS.find(p => p.name === 'Eyebrow');
    const aaaParam = EXPRESSION_PARAMS.find(p => p.name === 'AAA');

    if (!blinkParam || !eyebrowParam || !aaaParam) return;

    const blinkInput = document.getElementById(`param-${blinkParam.index}`);
    const blinkVal = document.getElementById(`val-${blinkParam.index}`);
    const eyebrowInput = document.getElementById(`param-${eyebrowParam.index}`);
    const eyebrowVal = document.getElementById(`val-${eyebrowParam.index}`);
    const aaaInput = document.getElementById(`param-${aaaParam.index}`);
    const aaaVal = document.getElementById(`val-${aaaParam.index}`);

    const startTime = performance.now();
    const duration = 2000; // 2 seconds

    function update(currentTime) {
        const elapsed = currentTime - startTime;
        
        if (elapsed >= duration) {
            // Reset to 0
            blinkInput.value = 0;
            blinkVal.textContent = "0";
            eyebrowInput.value = 0;
            eyebrowVal.textContent = "0";
            aaaInput.value = 0;
            aaaVal.textContent = "0";
            scheduleUpdate();
            return;
        }
        
        let blinkValue, eyebrowValue, aaaValue;
        
        if (elapsed < duration / 2) {
            // First half: Go to target
            // Blink: 0 to 4
            blinkValue = (elapsed / (duration / 2)) * 4;
            // Eyebrow: 0 to 13
            eyebrowValue = (elapsed / (duration / 2)) * 13;
            // AAA: 0 to 30
            aaaValue = (elapsed / (duration / 2)) * 30;
        } else {
            // Second half: Return to 0
            // Blink: 4 to 0
            blinkValue = 4 - ((elapsed - duration / 2) / (duration / 2)) * 4;
            // Eyebrow: 13 to 0
            eyebrowValue = 13 - ((elapsed - duration / 2) / (duration / 2)) * 13;
            // AAA: 30 to 0
            aaaValue = 30 - ((elapsed - duration / 2) / (duration / 2)) * 30;
        }
        
        blinkInput.value = blinkValue;
        blinkVal.textContent = blinkValue.toFixed(1);
        
        eyebrowInput.value = eyebrowValue;
        eyebrowVal.textContent = eyebrowValue.toFixed(1);
        
        aaaInput.value = aaaValue;
        aaaVal.textContent = aaaValue.toFixed(1);
        
        scheduleUpdate();
        
        requestAnimationFrame(update);
    }
    
    requestAnimationFrame(update);
}

async function handleImageUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Show preview
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = document.getElementById('sourcePreview');
        const placeholder = document.querySelector('.placeholder-text');
        if (img) {
            img.src = e.target.result;
            img.style.display = 'block';
        }
        if (placeholder) {
            placeholder.style.display = 'none';
        }
    };
    reader.readAsDataURL(file);

    // Upload to ComfyUI
    const formData = new FormData();
    formData.append('image', file);
    formData.append('overwrite', 'true');

    try {
        updateStatus('Uploading image...');
        const response = await fetch(`${COMFY_API}/upload/image`, {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        
        // Update workflow with new filename
        // In API format, LoadImage uses widget values directly or mapped inputs
        // We'll store the filename to inject into the prompt
        window.uploadedFilename = data.name;
        updateStatus('Image uploaded successfully');
    } catch (error) {
        console.error('Upload failed:', error);
        updateStatus('Upload failed', 'error');
    }
}

function scheduleUpdate() {
    needsUpdate = true;
    processQueue();
}

function processQueue() {
    if (isProcessing) return;
    if (!needsUpdate) return;
    if (!window.uploadedFilename) return;
    
    const now = Date.now();
    // Double check we aren't going too fast (redundant safety)
    if (now - lastPromptTime < pollingInterval) {
        setTimeout(processQueue, Math.max(50, pollingInterval - (now - lastPromptTime)));
        return;
    }

    needsUpdate = false;
    isProcessing = true;
    lastPromptTime = now;
    queuePrompt(true);
}

async function queuePrompt(isAuto = false) {
    if (!workflowTemplate) {
        updateStatus('Workflow template not loaded', 'error');
        return;
    }

    if (!window.uploadedFilename) {
        if (!isAuto) alert('Please upload an image first');
        return;
    }

    setLoading(true);
    updateStatus(isAuto ? 'Updating...' : 'Queueing prompt...');

    // Construct the prompt based on current slider values
    const prompt = JSON.parse(JSON.stringify(workflowTemplate)); // Deep copy

    // Update LoadImage node (15)
    prompt["15"].inputs.image = window.uploadedFilename;

    // Update ExpressionEditor node (14)
    // Note: The keys in the 'inputs' object must match what the node expects
    // We map our array index to the specific parameter names
    const paramKeys = [
        "rotate_pitch", "rotate_yaw", "rotate_roll", "blink", "eyebrow", 
        "wink", "pupil_x", "pupil_y", "aaa", "eee", "woo", "smile", 
        "src_ratio", "sample_ratio", "crop_factor"
    ];

    EXPRESSION_PARAMS.forEach((param, i) => {
        const value = parseFloat(document.getElementById(`param-${param.index}`).value);
        const key = paramKeys[i];
        prompt["14"].inputs[key] = value;
    });

    try {
        const response = await fetch(`${COMFY_API}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: clientId,
                prompt: prompt
            })
        });
        
        if (!response.ok) throw new Error('Failed to queue prompt');
        // Status update handled by WS or subsequent steps
    } catch (error) {
        console.error('Error:', error);
        updateStatus('Error generating image. Retrying...', 'error');
        setLoading(false);
        isProcessing = false; 
        
        // Backoff on error to prevent request flooding
        setTimeout(() => {
            needsUpdate = true; // Ensure we try again
            processQueue();
        }, 1000);
    }
}

function updateStatus(text, type = 'info') {
    const statusEl = document.getElementById('status');
    statusEl.textContent = text;
    statusEl.style.color = type === 'error' ? '#ff6b6b' : '#aaa';
}

function setLoading(isLoading) {
    const loadingEl = document.getElementById('loading');
    const generateBtn = document.getElementById('generateBtn');
    
    if (isLoading) {
        loadingEl.classList.remove('hidden');
        generateBtn.disabled = true;
    } else {
        loadingEl.classList.add('hidden');
        generateBtn.disabled = false;
    }
}
