const COMFY_API = ''; // Relative path to use proxy
const NODES = {
    EXPRESSION_EDITOR: "14",
    LOAD_IMAGE: "15",
    PREVIEW_IMAGE: "32"
};

let clientId = crypto.randomUUID();
let ws;
let socket; // Socket.io
let isProcessing = false;
let needsUpdate = false;
let pollingInterval = 100; // Default to 100ms to be safe
let lastPromptTime = 0;
let inputMode = 'mouse'; // 'mouse' (drag), 'hover', 'osc', or 'random'

// Store current normalized coordinates (0-1)
let oscX = 0.5;
let oscY = 0.5;

// Calibration State
let calibCenterX = 0.5;
let calibCenterY = 0.5;
let calibMoveX = 1.0;
let calibMoveY = 1.0;

// Random Mode State
let randomModeInterval;
let randomExpressionInterval;
let randomX = window.innerWidth / 2;
let randomY = window.innerHeight / 2;
let targetRandomX = window.innerWidth / 2;
let targetRandomY = window.innerHeight / 2;
let randomSpeed = 1.0;
let randomTimeAccumulator = 0;
let lastRandomFrameTime = 0;

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
    { name: 'Crop Factor', category: 'Image', index: 14, min: 1.5, max: 3, step: 0.1, default: 1.5 }
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
            if (message.data.node === NODES.PREVIEW_IMAGE) {
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

    // Apply Calibration
    // Formula: (Input - CenterOffset) * Scale + 0.5
    // This maps the user-defined center input to 0.5 (screen center)
    const calibratedX = (oscX - calibCenterX) * calibMoveX + 0.5;
    const calibratedY = (oscY - calibCenterY) * calibMoveY + 0.5;

    // Map normalized (0-1) to screen coordinates
    const screenX = calibratedX * window.innerWidth;
    const screenY = calibratedY * window.innerHeight;
    
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

    const randomSpeedInput = document.getElementById('randomSpeed');
    if (randomSpeedInput) {
        randomSpeedInput.addEventListener('input', (e) => {
            randomSpeed = parseFloat(e.target.value);
            document.getElementById('randomSpeedVal').textContent = randomSpeed.toFixed(1);
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
    
    // Helper to update UI based on mode
    function updateInputModeUI() {
        // Update cursor interactivity
        const cursor = document.getElementById('customCursor');
        if (cursor) {
            cursor.style.pointerEvents = inputMode === 'mouse' ? 'auto' : 'none';
        }

        // Random Speed Group
        const randomGroup = document.getElementById('randomSpeedGroup');
        if (randomGroup) {
            randomGroup.style.display = inputMode === 'random' ? 'block' : 'none';
        }

        // Calibration Group (Only for OSC)
        const calibGroup = document.querySelector('.calibration-group');
        if (calibGroup) {
            calibGroup.style.display = inputMode === 'osc' ? 'flex' : 'none';
        }

        if (inputMode === 'random') {
            startRandomMode();
        } else {
            stopRandomMode();
        }
    }

    // Initialize UI state
    updateInputModeUI();

    inputRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.checked) {
                inputMode = e.target.value;
                console.log('Input mode switched to:', inputMode);
                updateInputModeUI();
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

    // Disgust button listener
    const disgustBtn = document.getElementById('disgustBtn');
    if (disgustBtn) {
        disgustBtn.addEventListener('click', animateDisgust);
    }

    // Yes (Nod) button listener
    const yesBtn = document.getElementById('yesBtn');
    if (yesBtn) {
        yesBtn.addEventListener('click', animateYes);
    }

    // No (Shake) button listener
    const noBtn = document.getElementById('noBtn');
    if (noBtn) {
        noBtn.addEventListener('click', animateNo);
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

    // Calibration Listeners
    const cCX = document.getElementById('calibCenterX');
    const cCY = document.getElementById('calibCenterY');
    const cMX = document.getElementById('calibMoveX');
    const cMY = document.getElementById('calibMoveY');

    if (cCX) {
        cCX.addEventListener('input', (e) => {
            calibCenterX = parseFloat(e.target.value);
            document.getElementById('calibCenterXVal').textContent = calibCenterX.toFixed(2);
            updateFromOsc(); // Live update
        });
    }
    if (cCY) {
        cCY.addEventListener('input', (e) => {
            calibCenterY = parseFloat(e.target.value);
            document.getElementById('calibCenterYVal').textContent = calibCenterY.toFixed(2);
            updateFromOsc();
        });
    }
    if (cMX) {
        cMX.addEventListener('input', (e) => {
            calibMoveX = parseFloat(e.target.value);
            document.getElementById('calibMoveXVal').textContent = calibMoveX.toFixed(1);
            updateFromOsc();
        });
    }
    if (cMY) {
        cMY.addEventListener('input', (e) => {
            calibMoveY = parseFloat(e.target.value);
            document.getElementById('calibMoveYVal').textContent = calibMoveY.toFixed(1);
            updateFromOsc();
        });
    }

    // Keyboard Controls
    document.addEventListener('keydown', (e) => {
        // Prevent triggering when typing in inputs
        if (e.target.tagName === 'INPUT') return;

        switch(e.key) {
            case '1':
                animateWink();
                break;
            case '2':
                animateKiss();
                break;
            case '3':
                animateSmiley();
                break;
            case '4':
                animateWow();
                break;
            case '6':
                animateDisgust();
                break;
            case '7':
                animateYes();
                break;
            case '8':
                animateNo();
                break;
        }
    });
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
        if (inputMode === 'mouse' && !isDragging) return;
        if (inputMode !== 'mouse' && inputMode !== 'hover') return;
        
        // Update target position
        targetX = e.clientX;
        targetY = e.clientY;
        updateTargetPosition(targetX, targetY);
        
        // Update Parameters based on target position
        updateGazeParams(targetX, targetY);
    });
}

// Random offsets for noise generation to ensure X and Y are different
const xOffset1 = Math.random() * 1000;
const xOffset2 = Math.random() * 1000;
const yOffset1 = Math.random() * 1000;
const yOffset2 = Math.random() * 1000;

function startRandomMode() {
    // Stop any existing intervals first
    stopRandomMode();
    
    // Reset time tracking
    lastRandomFrameTime = performance.now();
    
    updateRandomMovement();
    scheduleNextExpression();
}

// Random Movement Loop
function updateRandomMovement() {
    if (inputMode !== 'random') return;

    const now = performance.now();
    const dt = now - lastRandomFrameTime;
    lastRandomFrameTime = now;

    // Vary the speed over time (slow/fast cycles)
    // Use a separate time base for the speed modulation
    // Speed up the variance cycle (from 0.0002 to 0.001) so changes are more noticeable (approx 6s cycle)
    const speedTime = now * 0.001;
    
    // Modulate speed between 0.2x and 1.8x of base speed for more dramatic effect
    const variance = 1.0 + Math.sin(speedTime) * 0.8;
    
    // Ensure we use the latest randomSpeed global variable
    const currentSpeed = randomSpeed * variance;
    
    // Accumulate time based on current speed
    // Increased base factor from 0.002 to 0.005 for even faster potential movement
    randomTimeAccumulator += dt * 0.005 * currentSpeed;
    
    const time = randomTimeAccumulator;
    
    // Debug log every ~1 second
    if (Math.random() < 0.01) {
        console.log('Random Speed:', randomSpeed, 'Variance:', variance.toFixed(2), 'Current:', currentSpeed.toFixed(3));
    }

    // Generate smooth noise using overlapping sine waves with prime number frequencies
    // This creates a non-repeating, organic wandering path
    
    // Normalized X (-1 to 1)
    const nX = Math.sin(time + xOffset1) * 0.5 + 
               Math.sin(time * 0.5 + xOffset2) * 0.3 + 
               Math.sin(time * 0.23) * 0.2;

    // Normalized Y (-1 to 1)
    const nY = Math.sin(time * 0.8 + yOffset1) * 0.5 + 
               Math.sin(time * 0.4 + yOffset2) * 0.3 + 
               Math.sin(time * 0.17) * 0.2;

    // Map to screen coordinates with some padding so it doesn't stick to edges
    // (0-1 range) -> Screen Range
    const w = window.innerWidth;
    const h = window.innerHeight;
    
    // Convert -1..1 to 0..1 then map to screen
    randomX = ((nX + 1) / 2) * w;
    randomY = ((nY + 1) / 2) * h;

    updateTargetPosition(randomX, randomY);
    updateGazeParams(randomX, randomY);
    
    randomModeInterval = requestAnimationFrame(updateRandomMovement);
}

// Random Expressions Loop (Every 5-15 seconds)
function scheduleNextExpression() {
    const delay = 5000 + Math.random() * 10000;
    randomExpressionInterval = setTimeout(() => {
        if (inputMode !== 'random') return;
        
        triggerRandomExpression();
        scheduleNextExpression();
    }, delay);
}

function stopRandomMode() {
    if (randomModeInterval) cancelAnimationFrame(randomModeInterval);
    if (randomExpressionInterval) clearTimeout(randomExpressionInterval);
}

function triggerRandomExpression() {
    const expressions = [
        animateWink, 
        animateKiss, 
        animateSmiley, 
        animateWow, 
        animateDisgust, 
        animateYes, 
        animateNo
    ];
    
    const randomIdx = Math.floor(Math.random() * expressions.length);
    const expressionFn = expressions[randomIdx];
    
    console.log('Triggering random expression:', expressionFn.name);
    expressionFn();
}

function startRandomMode() {
    // Stop any existing intervals first
    stopRandomMode();
    
    // Random offsets for noise generation to ensure X and Y are different
    const xOffset1 = Math.random() * 1000;
    const xOffset2 = Math.random() * 1000;
    const yOffset1 = Math.random() * 1000;
    const yOffset2 = Math.random() * 1000;

    // Random Movement Loop
    function updateRandomMovement() {
        if (inputMode !== 'random') return;

        const time = performance.now() * 0.0005; // Base speed scaling

        // Generate smooth noise using overlapping sine waves with prime number frequencies
        // This creates a non-repeating, organic wandering path
        
        // Normalized X (-1 to 1)
        const nX = Math.sin(time + xOffset1) * 0.5 + 
                   Math.sin(time * 0.5 + xOffset2) * 0.3 + 
                   Math.sin(time * 0.23) * 0.2;

        // Normalized Y (-1 to 1)
        const nY = Math.sin(time * 0.8 + yOffset1) * 0.5 + 
                   Math.sin(time * 0.4 + yOffset2) * 0.3 + 
                   Math.sin(time * 0.17) * 0.2;

        // Map to screen coordinates with some padding so it doesn't stick to edges
        // (0-1 range) -> Screen Range
        const w = window.innerWidth;
        const h = window.innerHeight;
        
        // Convert -1..1 to 0..1 then map to screen
        randomX = ((nX + 1) / 2) * w;
        randomY = ((nY + 1) / 2) * h;

        updateTargetPosition(randomX, randomY);
        updateGazeParams(randomX, randomY);
        
        randomModeInterval = requestAnimationFrame(updateRandomMovement);
    }
    
    updateRandomMovement();

    // Random Expressions Loop (Every 5-15 seconds)
    function scheduleNextExpression() {
        const delay = 5000 + Math.random() * 10000;
        randomExpressionInterval = setTimeout(() => {
            if (inputMode !== 'random') return;
            
            triggerRandomExpression();
            scheduleNextExpression();
        }, delay);
    }
    
    scheduleNextExpression();
}

function stopRandomMode() {
    if (randomModeInterval) cancelAnimationFrame(randomModeInterval);
    if (randomExpressionInterval) clearTimeout(randomExpressionInterval);
}

function triggerRandomExpression() {
    const expressions = [
        animateWink, 
        animateKiss, 
        animateSmiley, 
        animateWow, 
        animateDisgust, 
        animateYes, 
        animateNo
    ];
    
    const randomIdx = Math.floor(Math.random() * expressions.length);
    const expressionFn = expressions[randomIdx];
    
    console.log('Triggering random expression:', expressionFn.name);
    expressionFn();
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

// Helper to animate parameters
function runAnimation(duration, updateFn, onComplete) {
    if (!window.uploadedFilename) return;
    
    const startTime = performance.now();

    function loop(currentTime) {
        const elapsed = currentTime - startTime;
        if (elapsed >= duration) {
            if (onComplete) onComplete();
            scheduleUpdate();
            return;
        }
        
        updateFn(elapsed, duration);
        scheduleUpdate();
        requestAnimationFrame(loop);
    }
    
    requestAnimationFrame(loop);
}

// Helper to set param value
function setParamValue(paramName, value) {
    const param = EXPRESSION_PARAMS.find(p => p.name === paramName);
    if (!param) return;
    
    const input = document.getElementById(`param-${param.index}`);
    const valDisplay = document.getElementById(`val-${param.index}`);
    
    if (input && valDisplay) {
        input.value = value;
        valDisplay.textContent = value.toFixed(2);
    }
}

// Helper for simple linear back-and-forth animations
function animateLinear(paramName, targetValue, duration = 2000) {
    runAnimation(duration, (elapsed, d) => {
        let val;
        if (elapsed < d / 2) {
            val = (elapsed / (d / 2)) * targetValue;
        } else {
            val = targetValue - ((elapsed - d / 2) / (d / 2)) * targetValue;
        }
        setParamValue(paramName, val);
    }, () => {
        setParamValue(paramName, 0);
    });
}

function animateWink() {
    animateLinear('Wink', 20);
}

function animateKiss() {
    runAnimation(2000, (elapsed, duration) => {
        let woo, pitch;
        if (elapsed < duration / 2) {
            const t = elapsed / (duration / 2);
            woo = t * 15;
            pitch = t * -10;
        } else {
            const t = (elapsed - duration / 2) / (duration / 2);
            woo = 15 - t * 15;
            pitch = -10 - t * -10;
        }
        setParamValue('WOO', woo);
        setParamValue('Rotate Pitch', pitch);
    }, () => {
        setParamValue('WOO', 0);
        setParamValue('Rotate Pitch', 0);
    });
}

function animateSmiley() {
    runAnimation(2000, (elapsed, duration) => {
        let smile, eyebrow, blink;
        if (elapsed < duration / 2) {
            const t = elapsed / (duration / 2);
            smile = t * 1.0;
            eyebrow = t * 3;
            blink = t * 2;
        } else {
            const t = (elapsed - duration / 2) / (duration / 2);
            smile = 1.0 - t * 1.0;
            eyebrow = 3 - t * 3;
            blink = 2 - t * 2;
        }
        setParamValue('Smile', smile);
        setParamValue('Eyebrow', eyebrow);
        setParamValue('Blink', blink);
    }, () => {
        setParamValue('Smile', 0);
        setParamValue('Eyebrow', 0);
        setParamValue('Blink', 0);
    });
}

function animateWow() {
    runAnimation(2000, (elapsed, duration) => {
        let blink, eyebrow, aaa;
        if (elapsed < duration / 2) {
            const t = elapsed / (duration / 2);
            blink = t * 4;
            eyebrow = t * 13;
            aaa = t * 30;
        } else {
            const t = (elapsed - duration / 2) / (duration / 2);
            blink = 4 - t * 4;
            eyebrow = 13 - t * 13;
            aaa = 30 - t * 30;
        }
        setParamValue('Blink', blink);
        setParamValue('Eyebrow', eyebrow);
        setParamValue('AAA', aaa);
    }, () => {
        setParamValue('Blink', 0);
        setParamValue('Eyebrow', 0);
        setParamValue('AAA', 0);
    });
}

function animateDisgust() {
    runAnimation(2000, (elapsed, duration) => {
        let eee, eyebrow, blink;
        if (elapsed < duration / 2) {
            const t = elapsed / (duration / 2);
            eee = t * 15;
            eyebrow = t * -10;
            blink = t * 4;
        } else {
            const t = (elapsed - duration / 2) / (duration / 2);
            eee = 15 - t * 15;
            eyebrow = -10 - t * -10;
            blink = 4 - t * 4;
        }
        setParamValue('EEE', eee);
        setParamValue('Eyebrow', eyebrow);
        setParamValue('Blink', blink);
    }, () => {
        setParamValue('EEE', 0);
        setParamValue('Eyebrow', 0);
        setParamValue('Blink', 0);
    });
}

function animateYes() {
    runAnimation(2000, (elapsed, duration) => {
        const val = Math.sin((elapsed / duration) * Math.PI * 4) * 15;
        setParamValue('Rotate Pitch', val);
    }, () => {
        setParamValue('Rotate Pitch', 0);
    });
}

function animateNo() {
    runAnimation(2000, (elapsed, duration) => {
        const val = Math.sin((elapsed / duration) * Math.PI * 4) * 20;
        setParamValue('Rotate Yaw', val);
    }, () => {
        setParamValue('Rotate Yaw', 0);
    });
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

    // Update LoadImage node
    prompt[NODES.LOAD_IMAGE].inputs.image = window.uploadedFilename;

    // Update ExpressionEditor node
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
        prompt[NODES.EXPRESSION_EDITOR].inputs[key] = value;
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
