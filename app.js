// Auto-detect API base: use config if set, otherwise fallback to localhost
const API_BASE = (window.REMOVEBG_API_BASE
    || (location.hostname === 'localhost' || location.hostname === '127.0.0.1'
        ? 'http://localhost:8000'
        : '')).replace(/\/+$/, '');
const API_KEY = window.REMOVEBG_API_KEY || '';

// Wrapper for fetch with auth header
function apiFetch(path, opts = {}) {
    if (API_KEY) {
        opts.headers = { ...opts.headers, 'X-API-Key': API_KEY };
    }
    return fetch(`${API_BASE}${path}`, opts);
}

const MASK_COLORS = [
    [74, 144, 226],   // blue
    [226, 74, 74],    // red
    [74, 226, 144],   // green
    [226, 180, 74],   // orange
    [180, 74, 226],   // purple
    [74, 226, 226],   // cyan
];

// ── State ──
const state = {
    sessionId: null,
    originalImage: null,
    originalFile: null,
    imageWidth: 0,
    imageHeight: 0,
    currentMasks: [],
    currentScores: [],
    selectedMasks: new Set(),
};

// ── DOM Elements ──
const $ = id => document.getElementById(id);
const landing = $('landing');
const workspace = $('workspace');
const footer = $('footer');
const uploadBox = $('uploadBox');
const uploadBtn = $('uploadBtn');
const fileInput = $('fileInput');
const canvas = $('canvas');
const maskCanvas = $('maskCanvas');
const loadingOverlay = $('loadingOverlay');
const promptForm = $('promptForm');
const promptInput = $('promptInput');
const segmentBtn = $('segmentBtn');
const resultsList = $('resultsList');
const statusMsg = $('statusMsg');
const downloadBtn = $('downloadBtn');
const resetBtn = $('resetBtn');
const backBtn = $('backBtn');
const fileName = $('fileName');
const logoLink = $('logoLink');

// ── Upload Handlers ──
uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });

uploadBox.addEventListener('dragover', e => { e.preventDefault(); uploadBox.classList.add('drag-over'); });
uploadBox.addEventListener('dragleave', () => uploadBox.classList.remove('drag-over'));
uploadBox.addEventListener('drop', e => {
    e.preventDefault();
    uploadBox.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) handleFile(file);
});

async function handleFile(file) {
    showLoading();
    state.originalFile = file;
    fileName.textContent = file.name;

    try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await apiFetch('/upload', { method: 'POST', body: formData });
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        const data = await res.json();

        state.sessionId = data.session_id;
        state.imageWidth = data.width;
        state.imageHeight = data.height;

        // Load image for canvas
        const url = URL.createObjectURL(file);
        state.originalImage = new Image();
        state.originalImage.onload = () => {
            URL.revokeObjectURL(url);
            switchToWorkspace();
            drawOriginal();
            hideLoading();
            setStatus(`Image loaded (${data.width}×${data.height}) — ${data.processing_time_ms.toFixed(0)}ms`);
        };
        state.originalImage.src = url;
    } catch (err) {
        hideLoading();
        setStatus(err.message, true);
    }
}

// ── View Switching ──
function switchToWorkspace() {
    landing.style.display = 'none';
    footer.style.display = 'none';
    workspace.classList.add('active');
    promptInput.focus();
}

function switchToLanding() {
    workspace.classList.remove('active');
    landing.style.display = '';
    footer.style.display = '';
    resetState();
}

backBtn.addEventListener('click', async () => {
    await cleanupSession();
    switchToLanding();
});

logoLink.addEventListener('click', async e => {
    e.preventDefault();
    if (state.sessionId) await cleanupSession();
    switchToLanding();
});

// ── Segmentation ──
promptForm.addEventListener('submit', async e => {
    e.preventDefault();
    const prompt = promptInput.value.trim();
    if (!prompt || !state.sessionId) return;

    showLoading();
    setStatus('Segmenting...');

    try {
        const res = await apiFetch('/segment/text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: state.sessionId, prompt }),
        });
        if (!res.ok) throw new Error(`Segmentation failed: ${res.status}`);
        const data = await res.json();
        const results = data.results;

        state.currentMasks = [];
        state.currentScores = results.scores || [];
        state.selectedMasks = new Set();

        for (const rle of (results.masks || [])) {
            const decoded = decodeRLE(rle);
            const resized = resizeMask(decoded.mask, decoded.width, decoded.height, results.original_width, results.original_height);
            state.currentMasks.push(resized);
        }

        // Select all masks by default
        state.currentMasks.forEach((_, i) => state.selectedMasks.add(i));

        renderResults();
        renderOverlay();
        downloadBtn.disabled = state.currentMasks.length === 0;

        const count = state.currentMasks.length;
        setStatus(count > 0
            ? `Found ${count} instance${count > 1 ? 's' : ''} — ${data.processing_time_ms.toFixed(0)}ms`
            : 'No objects found. Try a different prompt.');
    } catch (err) {
        setStatus(err.message, true);
    }
    hideLoading();
});

// ── RLE Decode ──
function decodeRLE(rle) {
    const [h, w] = rle.size;
    const mask = new Uint8Array(h * w);
    let offset = 0;
    for (let i = 0; i < rle.counts.length; i++) {
        const runLen = rle.counts[i];
        if (i % 2 === 1) mask.fill(1, offset, offset + runLen);
        offset += runLen;
    }
    return { mask, width: w, height: h };
}

function resizeMask(mask, srcW, srcH, dstW, dstH) {
    if (srcW === dstW && srcH === dstH) return mask;
    const resized = new Uint8Array(dstW * dstH);
    const xR = srcW / dstW, yR = srcH / dstH;
    for (let y = 0; y < dstH; y++) {
        const srcY = Math.floor(y * yR);
        for (let x = 0; x < dstW; x++) {
            resized[y * dstW + x] = mask[srcY * srcW + Math.floor(x * xR)];
        }
    }
    return resized;
}

// ── Canvas Rendering ──
function drawOriginal() {
    canvas.width = state.imageWidth;
    canvas.height = state.imageHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(state.originalImage, 0, 0);
}

function renderOverlay() {
    drawOriginal();
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = imageData.data;
    const alpha = 0.4;

    for (const idx of state.selectedMasks) {
        const mask = state.currentMasks[idx];
        const color = MASK_COLORS[idx % MASK_COLORS.length];
        for (let i = 0; i < mask.length; i++) {
            if (mask[i] === 1) {
                const p = i * 4;
                px[p]     = px[p]     * (1 - alpha) + color[0] * alpha;
                px[p + 1] = px[p + 1] * (1 - alpha) + color[1] * alpha;
                px[p + 2] = px[p + 2] * (1 - alpha) + color[2] * alpha;
            }
        }
    }
    ctx.putImageData(imageData, 0, 0);
}

// ── Results List ──
function renderResults() {
    resultsList.innerHTML = '';
    state.currentScores.forEach((score, i) => {
        const li = document.createElement('li');
        li.className = state.selectedMasks.has(i) ? 'selected' : '';
        const color = MASK_COLORS[i % MASK_COLORS.length];
        li.innerHTML = `
            <span class="mask-color" style="background:rgb(${color.join(',')})"></span>
            <span class="mask-label">Instance ${i + 1}</span>
            <span class="mask-score">${(score * 100).toFixed(1)}%</span>
        `;
        li.addEventListener('click', () => {
            if (state.selectedMasks.has(i)) state.selectedMasks.delete(i);
            else state.selectedMasks.add(i);
            renderResults();
            renderOverlay();
        });
        resultsList.appendChild(li);
    });
}

// ── Download Transparent PNG ──
downloadBtn.addEventListener('click', () => {
    if (state.currentMasks.length === 0) return;

    maskCanvas.width = state.imageWidth;
    maskCanvas.height = state.imageHeight;
    const ctx = maskCanvas.getContext('2d');
    ctx.drawImage(state.originalImage, 0, 0);

    const imageData = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    const px = imageData.data;

    // Union of selected masks
    const combined = new Uint8Array(state.imageWidth * state.imageHeight);
    for (const idx of state.selectedMasks) {
        const mask = state.currentMasks[idx];
        for (let i = 0; i < mask.length; i++) {
            if (mask[i] === 1) combined[i] = 1;
        }
    }

    // Set alpha channel
    for (let i = 0; i < combined.length; i++) {
        px[i * 4 + 3] = combined[i] === 1 ? 255 : 0;
    }

    ctx.putImageData(imageData, 0, 0);

    maskCanvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const baseName = state.originalFile?.name?.replace(/\.[^.]+$/, '') || 'image';
        a.download = `${baseName}_nobg.png`;
        a.click();
        URL.revokeObjectURL(url);
    }, 'image/png');
});

// ── Reset ──
resetBtn.addEventListener('click', async () => {
    if (!state.sessionId) return;
    showLoading();
    try {
        await apiFetch('/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: state.sessionId }),
        });
        state.currentMasks = [];
        state.currentScores = [];
        state.selectedMasks.clear();
        resultsList.innerHTML = '';
        downloadBtn.disabled = true;
        drawOriginal();
        setStatus('Prompts reset. Enter a new prompt.');
    } catch (err) {
        setStatus(err.message, true);
    }
    hideLoading();
});

// ── Session Cleanup ──
async function cleanupSession() {
    if (!state.sessionId) return;
    try {
        await apiFetch(`/session/${state.sessionId}`, { method: 'DELETE' });
    } catch { /* ignore */ }
}

function resetState() {
    state.sessionId = null;
    state.originalImage = null;
    state.originalFile = null;
    state.imageWidth = 0;
    state.imageHeight = 0;
    state.currentMasks = [];
    state.currentScores = [];
    state.selectedMasks.clear();
    resultsList.innerHTML = '';
    downloadBtn.disabled = true;
    fileInput.value = '';
    promptInput.value = '';
    setStatus('Upload an image and enter a prompt to start');
}

window.addEventListener('beforeunload', () => cleanupSession());

// ── Helpers ──
function showLoading() { loadingOverlay.classList.add('active'); }
function hideLoading() { loadingOverlay.classList.remove('active'); }
function setStatus(msg, isError = false) {
    statusMsg.textContent = msg;
    statusMsg.className = 'status-msg' + (isError ? ' error' : '');
}
