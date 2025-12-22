"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
// src/extension.ts
const vscode = __importStar(require("vscode"));
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const http = __importStar(require("http"));
const state = {
    panel: undefined,
    lastSpoken: '',
    pending: new Map(),
    lastSig: undefined,
    scopeCache: new Map(),
    decorations: [],
    voiceServerClose: undefined,
    voiceServerUrl: undefined,
};
const DEFAULT_SETTINGS = {
    rate: 1.0,
    pitch: 1.0,
    lang: 'en-US',
    quiet: false,
    earconMappings: { error: 'buzz.wav', success: 'blip.wav' },
    announceKeystrokes: false,
};
let runtimeSettings = { ...DEFAULT_SETTINGS };
async function loadSettings(context) {
    try {
        const cfg = vscode.workspace.getConfiguration();
        const rate = cfg.get('blindCoder.voice.rate', DEFAULT_SETTINGS.rate);
        const pitch = cfg.get('blindCoder.voice.pitch', DEFAULT_SETTINGS.pitch);
        const lang = cfg.get('blindCoder.voice.lang', DEFAULT_SETTINGS.lang);
        const quiet = cfg.get('blindCoder.quietMode', DEFAULT_SETTINGS.quiet);
        const earconMappings = cfg.get('blindCoder.earconMappings', DEFAULT_SETTINGS.earconMappings);
        const announceKeystrokes = cfg.get('blindCoder.announceKeystrokes', DEFAULT_SETTINGS.announceKeystrokes);
        runtimeSettings = {
            rate: rate,
            pitch: pitch,
            lang: lang,
            quiet: quiet,
            earconMappings: Object.assign({}, DEFAULT_SETTINGS.earconMappings, earconMappings),
            announceKeystrokes: announceKeystrokes,
        };
        const stored = context.globalState.get('blindCoder.settings');
        if (stored) {
            runtimeSettings = { ...runtimeSettings, ...stored };
        }
    }
    catch (e) {
        runtimeSettings = { ...DEFAULT_SETTINGS };
        console.error('BlindCoder: failed to load settings', e);
    }
}
async function saveSettings(context, partial) {
    runtimeSettings = { ...runtimeSettings, ...partial };
    try {
        const cfg = vscode.workspace.getConfiguration();
        await cfg.update('blindCoder.voice.rate', runtimeSettings.rate, vscode.ConfigurationTarget.Global);
        await cfg.update('blindCoder.voice.pitch', runtimeSettings.pitch, vscode.ConfigurationTarget.Global);
        await cfg.update('blindCoder.voice.lang', runtimeSettings.lang, vscode.ConfigurationTarget.Global);
        await cfg.update('blindCoder.quietMode', runtimeSettings.quiet, vscode.ConfigurationTarget.Global);
        await cfg.update('blindCoder.earconMappings', runtimeSettings.earconMappings, vscode.ConfigurationTarget.Global);
        await cfg.update('blindCoder.announceKeystrokes', runtimeSettings.announceKeystrokes, vscode.ConfigurationTarget.Global);
    }
    catch (e) {
        console.warn('BlindCoder: unable to write workspace settings, falling back to globalState', e);
    }
    try {
        await context.globalState.update('blindCoder.settings', runtimeSettings);
    }
    catch (e) {
        console.warn('BlindCoder: failed to update globalState', e);
    }
}
function sendInitToPanel(webview) {
    const payload = {
        type: 'init',
        state: {
            quiet: runtimeSettings.quiet,
            rate: runtimeSettings.rate,
            pitch: runtimeSettings.pitch,
            lang: runtimeSettings.lang,
            earcons: runtimeSettings.earconMappings,
            announceKeystrokes: runtimeSettings.announceKeystrokes,
            currentFile: vscode.window.activeTextEditor?.document.fileName || '-',
            lastAction: 'Ready',
        },
    };
    webview.postMessage(payload);
}
// minimal undo implementation using workspaceState
async function pushUndoEntry(entry) {
    const ctx = global.__blindCoderCtx;
    if (!ctx)
        return;
    const stack = (ctx.workspaceState.get('blindCoder.undoStack') || []);
    stack.push(entry);
    await ctx.workspaceState.update('blindCoder.undoStack', stack);
}
async function tryUndoLastVoiceChange(context) {
    const stack = context.workspaceState.get('blindCoder.undoStack') || [];
    if (!stack.length)
        return false;
    const entry = stack.pop();
    if (!entry)
        return false;
    try {
        const doc = await vscode.workspace.openTextDocument(entry.file);
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        const start = new vscode.Position(entry.range.start.line, entry.range.start.character);
        const end = new vscode.Position(entry.range.end.line, entry.range.end.character);
        await editor.edit((editBuilder) => {
            editBuilder.replace(new vscode.Range(start, end), entry.oldText || '');
        });
        await context.workspaceState.update('blindCoder.undoStack', stack);
        return true;
    }
    catch (e) {
        console.warn('BlindCoder: failed to apply undo entry', e);
        return false;
    }
}
// -------------------- End settings / persistence --------------------
// Helper: minimal safe postToPanel
function postToPanel(payload) {
    if (!state.panel)
        return;
    try {
        state.panel.webview.postMessage(payload);
    }
    catch (e) {
        console.warn('Failed to post to panel', e);
    }
}
// Respect quiet mode: skip speaking if quiet is enabled
function speak(text, _kind = 'navigation', earcon) {
    if (runtimeSettings.quiet)
        return;
    state.lastSpoken = Array.isArray(text) ? text.join(' ') : text;
    const payload = { type: 'speak', text: Array.isArray(text) ? text : text };
    if (earcon)
        payload.earcon = earcon;
    postToPanel(payload);
}
function speakSeq(lines) {
    if (runtimeSettings.quiet)
        return;
    postToPanel({ type: 'speak-seq', seq: lines });
}
function playEarcon(name) {
    if (!state.panel)
        return;
    try {
        postToPanel({ type: 'playSound', name });
    }
    catch (e) {
        console.warn('BlindCoder: failed to play earcon', e);
    }
}
// computeScopeStack and scopeLabel
function computeScopeStack(doc, line) {
    const IND = (s) => {
        const m = s.match(/^(\s*)/);
        return m ? m[1].length : 0;
    };
    const rows = Math.min(line, doc.lineCount - 1);
    const frame = [];
    for (let i = 0; i <= rows; i++) {
        const t = doc.lineAt(i).text;
        if (!t.trim())
            continue;
        const indent = IND(t);
        while (frame.length && frame[frame.length - 1].indent >= indent)
            frame.pop();
        const label = scopeLabel(t);
        if (label)
            frame.push({ indent, label });
    }
    return frame.map((f) => f.label);
}
function scopeLabel(t) {
    const s = t.trim();
    if (s.startsWith('def '))
        return 'function';
    if (s.startsWith('class '))
        return 'class';
    if (s.startsWith('for '))
        return 'for loop';
    if (s.startsWith('while '))
        return 'while loop';
    if (s.startsWith('if '))
        return 'if block';
    if (s.startsWith('elif '))
        return 'elif block';
    if (s.startsWith('else:') || s === 'else')
        return 'else block';
    return undefined;
}
// ---------- Robust voice server (tries preferred port, small range, persists last port) ----------
async function startLocalVoiceServer(ctx) {
    const PREF_PORT_KEY = 'blindCoder.lastVoicePort';
    const preferredPortFromEnv = Number(process.env.BLINDCODER_VOICE_PORT || 0);
    const storedPort = ctx.globalState.get(PREF_PORT_KEY);
    const preferredPort = preferredPortFromEnv || storedPort || 8765;
    const portRange = 20; // try preferredPort .. preferredPort + portRange - 1
    const host = '127.0.0.1';
    function createServer() {
        return http.createServer(async (req, res) => {
            try {
                if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
                    const filePath = path.join(ctx.extensionPath, 'media', 'voice.html');
                    if (!fs.existsSync(filePath)) {
                        res.writeHead(404, { 'Content-Type': 'text/plain' });
                        res.end('voice.html not found');
                        return;
                    }
                    let html = fs.readFileSync(filePath, 'utf8');
                    html = html.replace(/__ASSET_BASE__/g, `/media`);
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(html);
                    return;
                }
                if (req.method === 'POST' && req.url === '/transcript') {
                    let body = '';
                    req.on('data', (chunk) => (body += chunk));
                    req.on('end', async () => {
                        try {
                            const json = JSON.parse(body || '{}');
                            // deliver transcript to dialog if waiting
                            try {
                                if (global.__blindCoderDialogInstance && typeof global.__blindCoderDialogInstance.handleTranscript === 'function') {
                                    const payloadForDialog = {
                                        transcript: (json.transcript || json.text || json.transcriptText || '').toString(),
                                        isFinal: (typeof json.isFinal === 'boolean' ? json.isFinal : true),
                                    };
                                    try {
                                        global.__blindCoderDialogInstance.handleTranscript(payloadForDialog);
                                    }
                                    catch (_) { }
                                }
                            }
                            catch (_) { }
                            const text = (json.text || json.transcript || '').toString().trim();
                            if (text) {
                                // if running in server mode, we prefer to notify the extension process via a simple global callback
                                try {
                                    // If the extension started server and attached a handler, call it:
                                    if (global.__blindCoderServerTranscriptHandler && typeof global.__blindCoderServerTranscriptHandler === 'function') {
                                        global.__blindCoderServerTranscriptHandler(text);
                                    }
                                }
                                catch (e) { }
                                // Also attempt to insert using available context (best-effort)
                                try {
                                    const parsed = textToCode(text);
                                    if (parsed) {
                                        await insertCode(parsed.code, parsed.selectionOffsetLines);
                                        speak(parsed.feedback || 'Inserted code.', 'confirmation', 'tap');
                                    }
                                    else {
                                        await insertCode(`# (voice) ${text}\n`);
                                        speak(`Inserted comment: ${text}`, 'confirmation', 'tap');
                                    }
                                }
                                catch (e) {
                                    console.warn('Failed to insert code from server transcript', e);
                                }
                            }
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ ok: true }));
                        }
                        catch (err) {
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: String(err) }));
                        }
                    });
                    return;
                }
                if (req.method === 'GET' && req.url && req.url.startsWith('/media/')) {
                    const rel = req.url.replace(/^\/media\//, '');
                    const filePath = path.join(ctx.extensionPath, 'media', rel);
                    if (fs.existsSync(filePath)) {
                        const content = fs.readFileSync(filePath);
                        res.writeHead(200);
                        res.end(content);
                        return;
                    }
                    else {
                        res.writeHead(404, { 'Content-Type': 'text/plain' });
                        res.end('Not found');
                        return;
                    }
                }
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not found');
            }
            catch (e) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Server error');
            }
        });
    }
    for (let attempt = 0; attempt < portRange; attempt++) {
        const portToTry = preferredPort + attempt;
        const server = createServer();
        const listenPromise = new Promise((resolve, reject) => {
            server.once('error', (err) => {
                server.removeAllListeners();
                try {
                    server.close();
                }
                catch (e) { }
                reject(err);
            });
            server.listen(portToTry, host, () => {
                resolve({ port: portToTry, server });
            });
        });
        try {
            const { port, server: runningServer } = await listenPromise;
            try {
                await ctx.globalState.update(PREF_PORT_KEY, port);
            }
            catch (e) { }
            const url = `http://${host}:${port}/`;
            console.log(`Voice server running at ${url}`);
            return { url, close: () => { try {
                    runningServer.close();
                }
                catch (e) { } } };
        }
        catch (err) {
            if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
                console.warn(`Port ${portToTry} unavailable (${err.code}). Trying next port...`);
            }
            else {
                console.warn(`Failed to start server on ${host}:${portToTry}:`, err && err.code ? err.code : err);
            }
            await new Promise((r) => setTimeout(r, 20));
        }
    }
    // fallback to ephemeral port
    try {
        const fallbackServer = createServer();
        await new Promise((resolve, reject) => {
            fallbackServer.once('error', (e) => reject(e));
            fallbackServer.listen(0, host, () => resolve());
        });
        const addr = fallbackServer.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        const url = `http://${host}:${port}/`;
        console.log(`Voice server running at ${url} (ephemeral fallback)`);
        return { url, close: () => { try {
                fallbackServer.close();
            }
            catch (e) { } } };
    }
    catch (e) {
        console.error('Failed to start voice server on any port', e);
        throw e;
    }
}
// ========== VOICE DIALOG (class must exist before registerCommand uses it) ==========
class VoiceDialog {
    constructor() {
        this.waiting = false;
        this.resolveWait = null;
        this.timeoutHandle = null;
        this.timeoutMs = 18000;
    }
    async startAndAsk(prompt = 'What do you want me to do?') {
        if (this.waiting) {
            speak('A voice command is already in progress.', 'confirmation', 'tap');
            return null;
        }
        this.waiting = true;
        speak(prompt, 'confirmation', 'tap');
        if (!state.voiceServerUrl) {
            try {
                const ctx = global.__blindCoderCtx;
                if (!ctx)
                    throw new Error('No context to start voice server');
                const s = await startLocalVoiceServer(ctx);
                state.voiceServerClose = s.close;
                state.voiceServerUrl = s.url;
            }
            catch (e) {
                speak('Could not open voice UI', 'error', 'glitch');
                this.waiting = false;
                return null;
            }
        }
        try {
            await vscode.env.openExternal(vscode.Uri.parse(state.voiceServerUrl || 'http://127.0.0.1:8765/'));
        }
        catch (e) {
            // ignore
        }
        const transcript = await this.waitForTranscript(this.timeoutMs);
        this.waiting = false;
        return transcript;
    }
    handleTranscript(payload) {
        if (!this.waiting)
            return;
        const t = payload && payload.transcript ? payload.transcript.toString().trim() : '';
        const isFinal = payload.isFinal !== undefined ? payload.isFinal : true;
        if (!isFinal)
            return;
        if (this.resolveWait)
            this.resolveWait(t || null);
    }
    waitForTranscript(timeoutMs) {
        return new Promise((resolve) => {
            this.resolveWait = (t) => {
                if (this.timeoutHandle)
                    clearTimeout(this.timeoutHandle);
                this.resolveWait = null;
                resolve(t);
            };
            this.timeoutHandle = setTimeout(() => {
                if (this.resolveWait)
                    this.resolveWait(null);
            }, timeoutMs);
        });
    }
    // confirmation helper
    async askForConfirmation(prompt = 'Proceed? Say yes to confirm, or no to cancel.', timeoutMs = 10000) {
        if (this.waiting) {
            return null;
        }
        this.waiting = true;
        speak(prompt, 'confirmation', 'tap');
        try {
            if (!state.voiceServerUrl) {
                const ctx = global.__blindCoderCtx;
                if (!ctx)
                    throw new Error('No context to start voice server');
                const s = await startLocalVoiceServer(ctx);
                state.voiceServerClose = s.close;
                state.voiceServerUrl = s.url;
            }
            try {
                await vscode.env.openExternal(vscode.Uri.parse(state.voiceServerUrl || 'http://127.0.0.1:8765/'));
            }
            catch { }
        }
        catch (e) {
            this.waiting = false;
            speak('Unable to open voice UI for confirmation.', 'error', 'glitch');
            return null;
        }
        const reply = await this.waitForTranscript(timeoutMs);
        this.waiting = false;
        if (!reply)
            return null;
        const r = reply.toLowerCase().trim();
        const yes = ['yes', 'yep', 'yeah', 'sure', 'do it', 'confirm', 'affirmative', 'please do', 'go ahead', 'ok', 'okay'];
        const no = ['no', 'nope', 'cancel', 'stop', "don't", 'do not', 'abort', 'negative'];
        if (yes.some((v) => r === v || r.startsWith(v + ' ') || r.includes(' ' + v)))
            return true;
        if (no.some((v) => r === v || r.startsWith(v + ' ') || r.includes(' ' + v)))
            return false;
        if (r.startsWith('y'))
            return true;
        if (r.startsWith('n'))
            return false;
        return null;
    }
}
const dialogInstance = new VoiceDialog();
global.__blindCoderDialogInstance = dialogInstance;
// ---------- textToCode (same logic, typed) ----------
function textToCode(spoken) {
    const s = spoken.toLowerCase().trim();
    let m;
    m = s.match(/^(?:set|assign)?\s*([a-zA-Z_][\w]*)\s*(?:is equal to|equals|=|is|to|:=)\s*(.+)$/i);
    if (m) {
        const varName = m[1];
        let value = m[2];
        return { code: `${varName} = ${value}\n`, feedback: `Assigned ${varName}.` };
    }
    m = s.match(/(?:define|create|make|make a|def)\s*(?:function\s*)?(?:named\s*)?([a-zA-Z_][\w\-]*)?(?:\s*(?:with|taking|that takes)\s*args?\s*(.*))?/i);
    if (m) {
        const name = m[1] || 'func';
        const args = (m[2] || '').split(/\s+/).map((a) => a).filter(Boolean);
        const argStr = args.length ? args.join(', ') : '';
        const code = `def ${name}(${argStr}):\n\tpass\n`;
        return { code, selectionOffsetLines: 1, feedback: `Created function ${name}` };
    }
    m = s.match(/for\s+(?:each\s+)?([a-zA-Z_][\w]*)\s+(?:in\s+range\s*(\d+)|in\s+([a-zA-Z_][\w]*))/i);
    if (m) {
        const varName = m[1];
        if (m[2]) {
            const n = m[2];
            const code = `for ${varName} in range(${n}):\n\tpass\n`;
            return { code, selectionOffsetLines: 1, feedback: `Created for-loop over range ${n}.` };
        }
        else if (m[3]) {
            const coll = m[3];
            const code = `for ${varName} in ${coll}:\n\tpass\n`;
            return { code, selectionOffsetLines: 1, feedback: `Created for-loop over ${coll}.` };
        }
    }
    m = s.match(/^while\s+(.+)$/i);
    if (m) {
        const cond = m[1];
        const code = `while ${cond}:\n\tpass\n`;
        return { code, selectionOffsetLines: 1, feedback: 'Created while loop.' };
    }
    m = s.match(/^(if)\s+(.+)$/i);
    if (m) {
        const cond = m[2];
        const code = `if ${cond}:\n\tpass\n`;
        return { code, selectionOffsetLines: 1, feedback: 'Created if statement.' };
    }
    m = s.match(/^(else if|elif)\s+(.+)$/i);
    if (m) {
        const cond = m[2];
        const code = `elif ${cond}:\n\tpass\n`;
        return { code, selectionOffsetLines: 1, feedback: 'Created elif statement.' };
    }
    if (/^else$/i.test(s)) {
        return { code: `else:\n\tpass\n`, selectionOffsetLines: 1, feedback: 'Created else branch.' };
    }
    m = s.match(/(?:create|make|define)?\s*(?:a\s*)?class\s+(?:named\s*)?([A-Z]?[a-zA-Z_][\w]*)/i);
    if (m) {
        const name = m[1] || 'MyClass';
        const code = `class ${name}:\n\tdef __init__(self):\n\t\tpass\n`;
        return { code, selectionOffsetLines: 2, feedback: `Created class ${name}.` };
    }
    m = s.match(/^(?:import)\s+(.+)$/i);
    if (m) {
        const rest = m[1];
        return { code: `import ${rest}\n`, feedback: `Imported ${rest}.` };
    }
    m = s.match(/^(?:print|say)\s+(.+)$/i);
    if (m) {
        const expr = m[1];
        return { code: `print(${wrapExprIfNeeded(expr)})\n`, feedback: 'Inserted print statement.' };
    }
    m = s.match(/^(?:comment|note|add comment)\s+(.+)$/i);
    if (m) {
        const c = m[1];
        return { code: `# ${c}\n`, feedback: 'Inserted comment.' };
    }
    m = s.match(/^([a-zA-Z_][\w]*)\s*(?:is equal to|equals|is)\s*(.+)$/i);
    if (m) {
        return { code: `${m[1]} = ${m[2]}\n`, feedback: `Assigned ${m[1]}.` };
    }
    return null;
}
function wrapExprIfNeeded(expr) {
    expr = expr.trim();
    if (/^["'].*["']$/.test(expr) || /^[0-9]+$/.test(expr) || /^[a-zA-Z_][\w]*$/.test(expr) || expr.includes('(')) {
        return expr;
    }
    return '`' + expr.replace(/`/g, '\\`') + '`';
}
async function insertCode(code, selectionOffsetLines) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor to insert code.');
        return;
    }
    const doc = editor.document;
    const sel = editor.selection;
    const insertPosition = sel.active;
    // push undo entry (capture old text of insertion range -> empty)
    try {
        const start = insertPosition;
        const lineCount = Math.max(1, code.split('\n').length);
        const endLine = Math.min(start.line + lineCount, doc.lineCount - 1);
        const end = doc.lineAt(endLine).range.end;
        const undoEntry = {
            id: Date.now().toString(),
            timestamp: Date.now(),
            file: doc.uri.fsPath,
            range: { start: { line: start.line, character: start.character }, end: { line: end.line, character: end.character } },
            oldText: '',
            newText: code,
        };
        await pushUndoEntry(undoEntry);
    }
    catch (e) {
        // ignore pushing undo entry failure
    }
    await editor.edit((editBuilder) => {
        editBuilder.insert(insertPosition, code);
    });
    const startLine = insertPosition.line;
    let targetLine = startLine;
    if (selectionOffsetLines && selectionOffsetLines > 0) {
        targetLine = startLine + selectionOffsetLines;
    }
    else {
        targetLine = startLine + code.split('\n').length - 1;
    }
    const safeTargetLine = Math.min(targetLine, Math.max(0, doc.lineCount - 1));
    const targetChar = doc.lineAt(safeTargetLine).firstNonWhitespaceCharacterIndex;
    const newPos = new vscode.Position(safeTargetLine, targetChar);
    editor.selection = new vscode.Selection(newPos, newPos);
    const lineCount = Math.max(1, code.split('\n').length);
    const start = new vscode.Position(startLine, 0);
    const endLine = Math.min(startLine + lineCount, doc.lineCount - 1);
    const end = editor.document.lineAt(endLine).range.end;
    const range = new vscode.Range(start, end);
    const decoType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(100,150,240,0.15)',
    });
    editor.setDecorations(decoType, [range]);
    setTimeout(() => decoType.dispose(), 1800);
}
// Parse fixer's JSON summary if included on stderr
function parseFixerJson(stderr) {
    if (!stderr)
        return null;
    try {
        const m = stderr.match(/FIXER_JSON\s*:(\{[\s\S]*\})/m);
        if (m && m[1]) {
            return JSON.parse(m[1]);
        }
    }
    catch (e) { }
    return null;
}
function announceFixerSummary(parsed) {
    const parts = [];
    if (parsed.summary)
        parts.push(parsed.summary);
    if (Array.isArray(parsed.changes) && parsed.changes.length) {
        for (const c of parsed.changes) {
            if (c.type === 'insert')
                parts.push(`Inserted ${c.detail || 'text'} at line ${c.line}`);
            else if (c.type === 'delete')
                parts.push(`Removed ${c.detail || 'text'} at line ${c.line}`);
            else if (c.type === 'replace')
                parts.push(`Replaced at line ${c.line}`);
            else
                parts.push(`${c.type || 'Change'} at line ${c.line || '?'}`);
        }
    }
    if (parts.length)
        speak(parts, 'confirmation', 'tap');
    else if (parsed.summary)
        speak(parsed.summary, 'confirmation', 'tap');
    else
        speak('Fix applied.', 'confirmation', 'tap');
}
function compressLineIndicesToRanges(indices) {
    if (!indices.length)
        return [];
    indices.sort((a, b) => a - b);
    const out = [];
    let a = indices[0], b = indices[0];
    for (let i = 1; i < indices.length; i++) {
        const v = indices[i];
        if (v === b + 1)
            b = v;
        else {
            out.push([a, b]);
            a = v;
            b = v;
        }
    }
    out.push([a, b]);
    return out;
}
// Basic diagnostic classification
function classifyDiagnostic(d) {
    const msg = (d.message || '').toLowerCase();
    if (msg.includes('expected') && (msg.includes(':') || msg.includes('colon')))
        return 'missingColon';
    if (msg.includes('indentation'))
        return 'indentation';
    if (msg.includes('unexpected') || msg.includes('invalid syntax'))
        return 'unexpectedToken';
    if (msg.includes('unmatched') || msg.includes('never closed') || msg.includes('parenthesis') || msg.includes('quote'))
        return 'unmatchedParen';
    if ((msg.includes('name') && msg.includes('not defined')) || msg.includes('undefined'))
        return 'undefinedName';
    return 'syntaxError';
}
function earconFor(k) {
    const map = runtimeSettings.earconMappings || DEFAULT_SETTINGS.earconMappings;
    switch (k) {
        case 'missingColon':
            return (map['missingColon'] || map['error'] || DEFAULT_SETTINGS.earconMappings['error']).replace('.wav', '');
        case 'indentation':
            return (map['indentation'] || map['error'] || DEFAULT_SETTINGS.earconMappings['error']).replace('.wav', '');
        case 'unmatchedParen':
            return (map['unmatchedParen'] || map['error'] || DEFAULT_SETTINGS.earconMappings['error']).replace('.wav', '');
        case 'unexpectedToken':
            return (map['unexpectedToken'] || map['error'] || DEFAULT_SETTINGS.earconMappings['error']).replace('.wav', '');
        case 'undefinedName':
            return (map['undefinedName'] || map['error'] || DEFAULT_SETTINGS.earconMappings['error']).replace('.wav', '');
        default:
            return (map['default'] || DEFAULT_SETTINGS.earconMappings['error']).replace('.wav', '');
    }
}
function toAnnouncement(d, kind) {
    const pos = d.range.start;
    const line = pos.line + 1, col = pos.character + 1;
    switch (kind) {
        case 'missingColon':
            return `Colon missing at line ${line}, column ${col}`;
        case 'indentation':
            return `Indentation issue at line ${line}, column ${col}`;
        case 'unmatchedParen':
            return `Unmatched bracket or quote at line ${line}, column ${col}`;
        case 'unexpectedToken':
            return `Unexpected token at line ${line}, column ${col}`;
        case 'undefinedName':
            return `Name not defined at line ${line}, column ${col}`;
        default:
            return `Syntax error at line ${line}, column ${col}`;
    }
}
function getWordAt(doc, pos) {
    const range = doc.getWordRangeAtPosition(pos, /[A-Za-z_][A-Za-z0-9_]*/);
    return range ? doc.getText(range) : '';
}
// Handlers for editor events
function handleDiagnostics() {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return;
    const uri = editor.document.uri;
    const diags = vscode.languages
        .getDiagnostics(uri)
        .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    if (!diags.length) {
        state.pending.forEach((p) => clearTimeout(p.timer));
        state.pending.clear();
        return;
    }
    const d = diags[0];
    const sig = `${uri.toString()}:${d.range.start.line}:${d.range.start.character}:${d.message}`;
    if (state.lastSig && state.lastSig.sig === sig && Date.now() - state.lastSig.at < 6000)
        return;
    const timer = setTimeout(() => {
        const kind = classifyDiagnostic(d);
        const token = getWordAt(editor.document, d.range.start);
        if (kind === 'undefinedName' && token && token.length < 3)
            return;
        const announcement = toAnnouncement(d, kind);
        speak(announcement, 'error', earconFor(kind));
        state.lastSig = { sig, at: Date.now() };
    }, 1100);
    state.pending.forEach((p) => clearTimeout(p.timer));
    state.pending.clear();
    state.pending.set(sig, { timer, at: Date.now() });
}
function handleSelectionChange(e) {
    const ed = e.textEditor;
    if (!ed)
        return;
    const stack = computeScopeStack(ed.document, e.selections[0].active.line);
    const key = ed.document.uri.toString();
    const last = state.scopeCache.get(key) || [];
    const entered = stack.filter((s) => !last.includes(s));
    const left = last.filter((s) => !stack.includes(s));
    if (entered.length)
        speak(`Under ${entered[entered.length - 1]}`, 'navigation');
    if (left.length)
        speak(`Out of ${left[left.length - 1]}`, 'navigation');
    state.scopeCache.set(key, stack);
}
function handleTyping(e) {
    if (!e.contentChanges.length)
        return;
    const doc = e.document;
    if (runtimeSettings.announceKeystrokes) {
        for (const change of e.contentChanges) {
            const textInserted = change.text ?? '';
            if (!textInserted) {
                continue;
            }
            if (textInserted.length === 1) {
                const ch = textInserted;
                let spoken = null;
                if (ch === ' ')
                    spoken = 'Space';
                else if (ch === '\n' || ch === '\r')
                    spoken = 'Enter';
                else if (ch === '\t')
                    spoken = 'Tab';
                else
                    spoken = ch;
                if (spoken)
                    speak(`Typed ${spoken}`, 'confirmation');
                continue;
            }
            if (textInserted.length <= 40) {
                const sanitized = textInserted.replace(/\r?\n/g, ' newline ');
                speak(`Inserted ${sanitized}`, 'confirmation');
                continue;
            }
            speak('Inserted text', 'confirmation');
        }
    }
    const change = e.contentChanges[0];
    if (change.text === undefined)
        return;
    const lineNo = change.range.start.line;
    const boundedLine = Math.min(lineNo, Math.max(0, doc.lineCount - 1));
    const lineText = doc.lineAt(boundedLine).text;
    if (/\s/.test(change.text)) {
        const words = lineText.trim().split(/\s+/);
        const lastWord = words[words.length - 1];
        if (lastWord)
            speak(lastWord, 'confirmation');
    }
}
// The main activate
function activate(context) {
    // expose context to global so startLocalVoiceServer / VoiceDialog can reuse it if necessary
    global.__blindCoderCtx = context;
    // load settings early
    loadSettings(context).catch((e) => console.warn('BlindCoder: loadSettings failed', e));
    const decorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255,215,0,0.10)',
        border: '1px solid rgba(255,215,0,0.18)',
        isWholeLine: true,
    });
    context.subscriptions.push(decorationType);
    state.decorations.push(decorationType);
    function ensurePanel() {
        if (state.panel) {
            state.panel.reveal(vscode.ViewColumn.Beside);
            return state.panel;
        }
        const panel = vscode.window.createWebviewPanel('blindCoderAudio', 'BlindCoder — Audio', vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
        });
        // Load audioPanel.html (fall back to inline page on error)
        try {
            const htmlPath = path.join(context.extensionPath, 'media', 'audioPanel.html');
            let html = fs.readFileSync(htmlPath, 'utf8');
            const base = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media')).toString();
            html = html.replace(/__ASSET_BASE__/g, base);
            panel.webview.html = html;
        }
        catch (err) {
            panel.webview.html = `<html><body><h3 style="color:#ddd">BlindCoder audio — failed to load audioPanel.html</h3><pre style="color:#aaa">${String(err)}</pre></body></html>`;
            console.error('Failed to load media/audioPanel.html', err);
        }
        // Attach a transcript handler global for server-mode to call when it receives POST /transcript
        global.__blindCoderServerTranscriptHandler = async (text) => {
            try {
                if (!text)
                    return;
                const parsed = textToCode(text);
                if (parsed) {
                    await insertCode(parsed.code, parsed.selectionOffsetLines);
                    speak(parsed.feedback || 'Inserted code.', 'confirmation', 'tap');
                }
                else {
                    await insertCode(`# (voice) ${text}\n`);
                    speak(`Inserted comment: ${text}`, 'confirmation', 'tap');
                }
            }
            catch (e) {
                console.warn('Server transcript handler error', e);
            }
        };
        panel.webview.onDidReceiveMessage(async (msg) => {
            try {
                if (!msg)
                    return;
                const cmd = (msg.command || msg.type || '').toString();
                // new: handle transcript messages coming from voice.html running as a webview page
                if (msg.type === 'transcript' || cmd === 'transcript') {
                    const raw = (msg.text || '').toString().trim();
                    if (!raw) {
                        speak('Transcript received but empty', 'confirmation', 'tap');
                        return;
                    }
                    console.log('Voice transcript received (webview):', raw);
                    const parsed = textToCode(raw);
                    if (parsed) {
                        await insertCode(parsed.code, parsed.selectionOffsetLines);
                        speak(parsed.feedback || 'Inserted code.', 'confirmation', 'tap');
                    }
                    else {
                        await insertCode(`# (voice) ${raw}\n`);
                        speak(`Inserted comment: ${raw}`, 'confirmation', 'tap');
                    }
                    return;
                }
                switch (cmd) {
                    case 'ready':
                    case 'panelReady':
                        panel.webview.postMessage({ type: 'status', text: 'Panel ready' });
                        panel.webview.postMessage({ type: 'update', shortcuts: getDefaultShortcutsForUi() });
                        sendInitToPanel(panel.webview);
                        break;
                    case 'playEarcon':
                    case 'playSound':
                    case 'play':
                        if (typeof msg.sound === 'string') {
                            const soundName = msg.sound;
                            try {
                                const soundPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'sounds', `${soundName}.wav`);
                                const soundUri = panel.webview.asWebviewUri(soundPath).toString();
                                panel.webview.postMessage({ type: 'playSound', url: soundUri, volume: msg.volume ?? 1.0 });
                            }
                            catch (e) {
                                console.warn('BlindCoder: failed to resolve earcon', e);
                            }
                        }
                        break;
                    case 'shortcutTrigger':
                        if (msg.cmd) {
                            Promise.resolve(vscode.commands.executeCommand(msg.cmd)).catch((e) => {
                                console.error('Failed to execute command from audio panel:', msg.cmd, e);
                            });
                        }
                        break;
                    case 'openSettings':
                        vscode.commands.executeCommand('workbench.action.openSettings');
                        break;
                    case 'setQuiet':
                        (async () => {
                            await saveSettings(context, { quiet: !!msg.value });
                            panel.webview.postMessage({ type: 'status', text: `Quiet mode ${runtimeSettings.quiet ? 'enabled' : 'disabled'}` });
                        })();
                        break;
                    case 'setRate':
                        (async () => {
                            if (typeof msg.value === 'number') {
                                await saveSettings(context, { rate: Number(msg.value) });
                                panel.webview.postMessage({ type: 'status', text: `Speech rate set to ${runtimeSettings.rate}` });
                            }
                        })();
                        break;
                    case 'setEarcon':
                        (async () => {
                            if (msg.event && msg.file) {
                                const earcons = { ...runtimeSettings.earconMappings, [msg.event]: msg.file };
                                await saveSettings(context, { earconMappings: earcons });
                                panel.webview.postMessage({ type: 'status', text: `Earcon for ${msg.event} set to ${msg.file}` });
                            }
                        })();
                        break;
                    case 'setAnnounceKeystrokes':
                        (async () => {
                            await saveSettings(context, { announceKeystrokes: !!msg.value });
                            panel.webview.postMessage({ type: 'status', text: `Keystroke announce ${runtimeSettings.announceKeystrokes ? 'enabled' : 'disabled'}` });
                        })();
                        break;
                    case 'insertSnippet':
                        (async () => {
                            if (typeof msg.snippet === 'string') {
                                const editor = vscode.window.activeTextEditor;
                                if (!editor) {
                                    panel.webview.postMessage({ type: 'status', text: 'No active editor to insert snippet into.' });
                                    return;
                                }
                                const posBefore = editor.selection.active;
                                await editor.edit((editBuilder) => {
                                    editBuilder.insert(posBefore, msg.snippet);
                                });
                                try {
                                    const start = posBefore;
                                    const endLine = Math.min(start.line + (msg.snippet.split('\n').length - 1), editor.document.lineCount - 1);
                                    const end = editor.document.lineAt(endLine).range.end;
                                    const undoStack = context.workspaceState.get('blindCoder.undoStack') || [];
                                    undoStack.push({
                                        id: Date.now().toString(),
                                        timestamp: Date.now(),
                                        file: editor.document.uri.fsPath,
                                        range: { start: { line: start.line, character: start.character }, end: { line: end.line, character: end.character } },
                                        oldText: '',
                                        newText: msg.snippet,
                                    });
                                    await context.workspaceState.update('blindCoder.undoStack', undoStack);
                                }
                                catch (e) {
                                    console.warn('BlindCoder: failed to push undo entry', e);
                                }
                                panel.webview.postMessage({ type: 'log', text: 'Snippet inserted' });
                                panel.webview.postMessage({ type: 'speak', text: 'Snippet inserted' });
                            }
                        })();
                        break;
                    case 'undoLastVoiceCommand':
                        (async () => {
                            const ok = await tryUndoLastVoiceChange(context);
                            panel.webview.postMessage({ type: 'status', text: ok ? 'Undo applied' : 'Nothing to undo' });
                        })();
                        break;
                    default:
                        if (msg.ready) {
                            panel.webview.postMessage({ type: 'status', text: 'Panel ready' });
                            panel.webview.postMessage({ type: 'update', shortcuts: getDefaultShortcutsForUi() });
                            sendInitToPanel(panel.webview);
                        }
                }
            }
            catch (e) {
                console.error('Error handling message from audio panel', e);
            }
        }, undefined, context.subscriptions);
        panel.onDidDispose(() => {
            state.panel = undefined;
        }, undefined, context.subscriptions);
        state.panel = panel;
        speak('Audio panel ready', 'confirmation');
        sendInitToPanel(panel.webview);
        return panel;
    }
    function getDefaultShortcutsForUi() {
        return [
            { id: 'voiceCode', label: 'Start Voice-to-Code', desc: 'Open microphone UI for dictation', shortcut: 'Ctrl+M', cmd: 'blindCoder.voiceCode' },
            { id: 'toggleAudio', label: 'Toggle Audio Panel', desc: 'Open/close the audio panel', shortcut: 'Ctrl+Alt+V', cmd: 'blindCoder.openAudioPanel' },
            { id: 'fixCode', label: 'Fix Python Syntax', desc: 'Run auto-fix script', shortcut: 'Ctrl+Alt+F', cmd: 'blindCoder.fixCodeSyntax' },
            { id: 'runAndSpeak', label: 'Run File & Speak', desc: 'Execute current Python file and narrate output', shortcut: 'Ctrl+Alt+X', cmd: 'blindCoder.runAndSpeak' },
            { id: 'readLine', label: 'Read Current Line', desc: 'Speak the current editor line', shortcut: 'Ctrl+Alt+L', cmd: 'blindCoder.readCurrentLine' },
            { id: 'readContext', label: 'Read Context', desc: 'Speak surrounding function/class scope', shortcut: 'Ctrl+Alt+C', cmd: 'blindCoder.readContext' },
            { id: 'nextError', label: 'Next Error', desc: 'Jump to next diagnostic', shortcut: 'Ctrl+Alt+N', cmd: 'blindCoder.nextError' },
            { id: 'prevError', label: 'Previous Error', desc: 'Jump to previous diagnostic', shortcut: 'Ctrl+Alt+P', cmd: 'blindCoder.prevError' },
            { id: 'summarize', label: 'Summarize Errors', desc: 'Speak a summary of current diagnostics', shortcut: 'Ctrl+Alt+S', cmd: 'blindCoder.summarizeErrors' },
            { id: 'repeatLast', label: 'Repeat Last', desc: 'Repeat the last spoken message', shortcut: 'Ctrl+Alt+R', cmd: 'blindCoder.repeatLast' },
            { id: 'toggleQuiet', label: 'Toggle Quiet Mode', desc: 'Suppress non-essential sounds', shortcut: 'Ctrl+Alt+Q', cmd: 'blindCoder.toggleQuiet' },
            { id: 'whereAmI', label: 'Where Am I', desc: 'Announce the current code scope', shortcut: 'Ctrl+Alt+I', cmd: 'blindCoder.whereAmI' },
            { id: 'aiDialog', label: 'AI Dialog', desc: 'Insert AI-suggested code snippets', shortcut: 'Ctrl+Alt+A', cmd: 'blindCoder.aiDialog' },
            { id: 'testBeep', label: 'Test Beep', desc: 'Play a test beep', shortcut: 'Ctrl+Alt+B', cmd: 'blindCoder.testBeep' },
        ];
    }
    // register status bar item
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    status.text = '$(unmute) Audio → Command';
    status.command = 'blindCoder.voiceDialog';
    status.tooltip = 'Start audio command (speak instructions)';
    status.show();
    context.subscriptions.push(status);
    // register commands (these reference dialogInstance/handleVoiceIntent which exist above)
    context.subscriptions.push(vscode.commands.registerCommand('blindCoder.openAudioPanel', () => ensurePanel()), vscode.commands.registerCommand('blindCoder.readCurrentLine', readCurrentLine), vscode.commands.registerCommand('blindCoder.readContext', readContext), vscode.commands.registerCommand('blindCoder.nextError', () => jumpDiagnostic(+1)), vscode.commands.registerCommand('blindCoder.prevError', () => jumpDiagnostic(-1)), vscode.commands.registerCommand('blindCoder.summarizeErrors', summarizeErrors), vscode.commands.registerCommand('blindCoder.repeatLast', () => speak(state.lastSpoken || '')), vscode.commands.registerCommand('blindCoder.whereAmI', whereAmI), vscode.commands.registerCommand('blindCoder.voiceDebugHelp', voiceDebugHelp), vscode.commands.registerCommand('blindCoder.aiDialog', aiDialog), vscode.commands.registerCommand('blindCoder.testBeep', () => playEarcon('tap')), vscode.commands.registerCommand('blindCoder.runAndSpeak', readTerminalOutput), vscode.commands.registerCommand('blindCoder.fixCodeSyntax', () => fixCodeSyntax(context)), 
    // open voice UI: use the dialog instance or direct server + webview
    vscode.commands.registerCommand('blindCoder.voiceCode', async () => {
        // prefer single-turn dialog that will open the voice UI and wait for a reply
        const t = await dialogInstance.startAndAsk('Speak your instruction (e.g., "fix code", "insert for loop 1 to 10")');
        if (!t) {
            speak('No response detected. Please try again.', 'confirmation', 'tap');
            return;
        }
        await handleVoiceIntent(t);
    }), 
    // alias lowercase command
    vscode.commands.registerCommand('blindcoder.voiceCode', async () => {
        const t = await dialogInstance.startAndAsk('Speak your instruction (e.g., "fix code", "insert for loop 1 to 10")');
        if (!t) {
            speak('No response detected. Please try again.', 'confirmation', 'tap');
            return;
        }
        await handleVoiceIntent(t);
    }), vscode.commands.registerCommand('blindCoder.voiceCode.toggle', () => vscode.commands.executeCommand('blindCoder.voiceCode')), vscode.commands.registerCommand('blindCoder.toggleQuiet', async () => {
        await saveSettings(context, { quiet: !runtimeSettings.quiet });
        vscode.window.showInformationMessage(`BlindCoder quiet mode ${runtimeSettings.quiet ? 'enabled' : 'disabled'}`);
    }), vscode.commands.registerCommand('blindCoder.toggleKeystrokeAnnounce', async () => {
        await saveSettings(context, { announceKeystrokes: !runtimeSettings.announceKeystrokes });
        const stateText = runtimeSettings.announceKeystrokes ? 'enabled' : 'disabled';
        vscode.window.showInformationMessage(`BlindCoder keystroke announcements ${stateText}`);
        state.panel?.webview.postMessage({ type: 'status', text: `Keystroke announce ${stateText}` });
    }), 
    // voiceDialog command that triggers the single-turn dialog (explicit)
    vscode.commands.registerCommand('blindCoder.voiceDialog', async () => {
        const t = await dialogInstance.startAndAsk('What do you want me to do? You can say "fix code", "diagnose error", or "insert a loop from 1 to 100".');
        if (!t) {
            speak('No response detected. Please try again.', 'confirmation', 'tap');
            return;
        }
        await handleVoiceIntent(t);
    }));
    context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(handleDiagnostics), vscode.window.onDidChangeTextEditorSelection(handleSelectionChange), vscode.workspace.onDidChangeTextDocument(handleTyping));
    ensurePanel();
    handleDiagnostics();
}
// ---------- rest of helpers & commands that were previously defined below ----------
async function fixCodeSyntax(ctx) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python') {
        speak('Not a Python file', 'confirmation');
        return;
    }
    if (editor.document.isDirty) {
        const saved = await editor.document.save();
        if (!saved) {
            speak('Please save the file first', 'confirmation');
            return;
        }
    }
    const file = editor.document.uri.fsPath;
    const fixerPath = path.join(ctx.extensionPath, 'scripts', 'fix_code.py');
    speak('Running auto-fix on current file. Please wait.', 'confirmation', 'blip');
    const dot = loadDotEnvForContext(ctx);
    const childEnv = Object.assign({}, process.env);
    for (const k of Object.keys(dot)) {
        childEnv[k] = dot[k];
    }
    (0, child_process_1.exec)(`python "${fixerPath}" "${file}"`, { env: childEnv, maxBuffer: 50 * 1024 * 1024 }, async (err, stdout, stderr) => {
        if (err && !stdout?.trim()) {
            speak('Failed to fix code.', 'error', 'glitch');
            if (stderr && stderr.trim())
                speak(stderr.trim(), 'error');
            console.error('fixer err:', err, stderr);
            return;
        }
        const oldText = editor.document.getText();
        const newText = (stdout ?? '').replace(/\r\n/g, '\n');
        if (!newText || newText.trim() === oldText.trim()) {
            if (stderr && stderr.trim()) {
                const parsedSummary = parseFixerJson(stderr);
                if (parsedSummary)
                    announceFixerSummary(parsedSummary);
                else
                    speak(stderr.trim(), 'confirmation', 'tap');
            }
            else {
                speak('No changes detected.', 'confirmation', 'tap');
            }
            return;
        }
        const oldLines = oldText.split(/\r?\n/);
        const newLines = newText.split(/\r?\n/);
        const changedLines = [];
        const max = Math.max(oldLines.length, newLines.length);
        for (let i = 0; i < max; i++) {
            const o = oldLines[i] ?? '';
            const n = newLines[i] ?? '';
            if (o !== n)
                changedLines.push(i);
        }
        const start = new vscode.Position(0, 0);
        const lastLineIndex = Math.max(0, editor.document.lineCount - 1);
        const end = editor.document.lineAt(lastLineIndex).range.end;
        const fullRange = new vscode.Range(start, end);
        await editor.edit((editBuilder) => {
            editBuilder.replace(fullRange, newText);
        });
        await editor.document.save();
        if (changedLines.length) {
            const ranges = compressLineIndicesToRanges(changedLines).map(([s, e]) => {
                const sPos = new vscode.Position(s, 0);
                const eLine = Math.min(e, editor.document.lineCount - 1);
                const ePos = editor.document.lineAt(eLine).range.end;
                return new vscode.Range(sPos, ePos);
            });
            editor.setDecorations(vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(255,215,0,0.10)' }), ranges);
            setTimeout(() => {
                try {
                    // attempt to clear decorations
                }
                catch (e) { }
            }, 6000);
        }
        const parsed = parseFixerJson(stderr);
        if (parsed) {
            announceFixerSummary(parsed);
        }
        else {
            if (!changedLines.length) {
                speak('Fix applied, but no line changes detected.', 'confirmation', 'tap');
            }
            else {
                const groups = compressLineIndicesToRanges(changedLines);
                const parts = groups.map(([s, e]) => (s === e ? `line ${s + 1}` : `lines ${s + 1} to ${e + 1}`));
                speak(['Code has been fixed from errors.', `Fixed ${parts.join(', ')}.`], 'confirmation', 'tap');
                if (stderr && stderr.trim())
                    speak(stderr.trim(), 'confirmation', 'blip');
            }
        }
    });
}
function loadDotEnvForContext(ctx) {
    const tryPaths = [
        vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length
            ? path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.env')
            : null,
        path.join(ctx.extensionPath, '.env'),
    ].filter(Boolean);
    const out = {};
    for (const p of tryPaths) {
        try {
            if (!fs.existsSync(p))
                continue;
            const raw = fs.readFileSync(p, { encoding: 'utf8' });
            for (const line of raw.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#'))
                    continue;
                const eq = trimmed.indexOf('=');
                if (eq <= 0)
                    continue;
                const k = trimmed.slice(0, eq).trim();
                let v = trimmed.slice(eq + 1).trim();
                if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
                    v = v.slice(1, -1);
                }
                out[k] = v;
            }
            if (Object.keys(out).length)
                break;
        }
        catch (e) { }
    }
    return out;
}
function readTerminalOutput() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python') {
        speak('Not a Python file', 'output');
        return;
    }
    editor.document.save().then(() => {
        const filePath = editor.document.uri.fsPath;
        (0, child_process_1.exec)(`python "${filePath}"`, (err, stdout, stderr) => {
            if (err) {
                speakSeq(['Your code executed with errors.', 'Error output follows.']);
                if (stderr && stderr.trim())
                    speak(stderr, 'output');
                else
                    speak('Process returned an error.', 'output');
            }
            else {
                speakSeq(['Your code ran successfully.', 'The output is as follows.']);
                if (stdout && stdout.trim())
                    speak(stdout, 'output');
                else
                    speak('No output produced.', 'output');
            }
        });
    });
}
async function readCurrentLine() {
    const ed = vscode.window.activeTextEditor;
    if (!ed)
        return;
    const { line } = ed.selection.active;
    const text = ed.document.lineAt(line).text.trim();
    speak(text || `Line ${line + 1} is empty`);
}
async function readContext() {
    const ed = vscode.window.activeTextEditor;
    if (!ed)
        return;
    const { line } = ed.selection.active;
    const start = Math.max(0, line - 1);
    const end = Math.min(ed.document.lineCount - 1, line + 1);
    const text = Array.from({ length: end - start + 1 }, (_, i) => ed.document.lineAt(start + i).text.trim()).join('. ');
    speak(text || 'No context available');
}
async function summarizeErrors() {
    const ed = vscode.window.activeTextEditor;
    if (!ed)
        return;
    const diags = vscode.languages.getDiagnostics(ed.document.uri).filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    if (!diags.length)
        return speak('No errors in this file', 'confirmation');
    const lines = diags.slice(0, 10).map((d) => {
        const p = d.range.start;
        const k = classifyDiagnostic(d);
        return `${k} at L${p.line + 1}:C${p.character + 1}`;
    }).join('; ');
    speak(lines, 'navigation');
}
async function jumpDiagnostic(dir) {
    const ed = vscode.window.activeTextEditor;
    if (!ed)
        return;
    const pos = ed.selection.active;
    const diags = vscode.languages.getDiagnostics(ed.document.uri).filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
        .sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
    if (!diags.length)
        return speak('No errors', 'confirmation');
    let idx = diags.findIndex((d) => d.range.start.line > pos.line || (d.range.start.line === pos.line && d.range.start.character > pos.character));
    if (dir < 0)
        idx = idx <= 0 ? diags.length - 1 : idx - 1;
    else
        idx = idx < 0 ? 0 : idx;
    const target = diags[idx];
    const p = target.range.start;
    const sel = new vscode.Selection(p, p);
    ed.selection = sel;
    ed.revealRange(new vscode.Range(p, p));
    const kind = classifyDiagnostic(target);
    speak(toAnnouncement(target, kind), 'error', earconFor(kind));
}
async function whereAmI() {
    const ed = vscode.window.activeTextEditor;
    if (!ed)
        return;
    const stack = computeScopeStack(ed.document, ed.selection.active.line);
    if (!stack.length)
        return speak('Top level', 'navigation');
    speak(`Inside ${stack.join(', ')}`, 'navigation');
}
async function voiceDebugHelp() {
    const ed = vscode.window.activeTextEditor;
    if (!ed)
        return;
    const d = vscode.languages.getDiagnostics(ed.document.uri).find((dd) => dd.severity === vscode.DiagnosticSeverity.Error);
    if (!d)
        return speak('No errors to fix', 'confirmation');
    const p = d.range.start;
    speak(`Go to line ${p.line + 1}. Add missing element.`, 'navigation', earconFor(classifyDiagnostic(d)));
}
async function aiDialog() {
    const input = await vscode.window.showInputBox({ prompt: 'Describe the code you want (e.g., "function add two numbers")' });
    if (!input)
        return;
    const snippet = new vscode.SnippetString(`def add(a, b):\n\treturn a + b\n`);
    vscode.window.activeTextEditor?.insertSnippet(snippet);
    speak('Code inserted', 'confirmation', 'tap');
}
// The high-level intent handler (must exist before registration)
async function handleVoiceIntent(transcript) {
    if (!transcript) {
        speak('I did not hear anything.', 'confirmation', 'tap');
        return;
    }
    const s = transcript.toLowerCase();
    // fix code -> CONFIRM
    if (/\bfix\b.*\bcode\b|\bauto-?fix\b|\bformat\b/.test(s)) {
        const want = await dialogInstance.askForConfirmation('I will run auto-fix on the current file. Proceed? Say yes to continue, or no to cancel.', 12000);
        if (want === true) {
            speak('Running auto-fix now.', 'confirmation', 'blip');
            await vscode.commands.executeCommand('blindCoder.fixCodeSyntax');
        }
        else if (want === false) {
            speak('Auto-fix cancelled.', 'confirmation', 'tap');
        }
        else {
            speak('No confirmation received. Cancelling auto-fix.', 'confirmation', 'tap');
        }
        return;
    }
    // diagnose / what is the error (no confirmation, read-only)
    if (/\b(error|what is the error|diagnos|diagnose|why does this fail)\b/.test(s)) {
        speak('I will try to check for Python syntax errors.', 'confirmation', 'tap');
        const ed = vscode.window.activeTextEditor;
        if (!ed) {
            speak('No active editor found.', 'confirmation', 'tap');
            return;
        }
        const filePath = ed.document.uri.fsPath;
        (0, child_process_1.exec)(`python -m py_compile "${filePath}"`, (err, _stdout, stderr) => {
            if (!err) {
                speak('No syntax errors found. If you still see runtime errors, try running the file.', 'confirmation', 'tap');
            }
            else {
                const msg = (stderr || '').split(/\r?\n/).slice(-4).join(' ').trim();
                speak(`I found an error: ${msg}`, 'error', 'buzz');
            }
        });
        return;
    }
    // Insert while loop -> CONFIRM (insertion modifies file)
    if (/\bwhile\b.*\b1\b.*\b100\b|\bloop from 1 to 100\b|\btype a while loop from 1 to 100\b/.test(s) || (/from 1 to 100/.test(s) && /while|loop/.test(s))) {
        const want = await dialogInstance.askForConfirmation('I will insert a while loop from 1 to 100 at the cursor. Proceed?', 10000);
        if (want === true) {
            const snippet = ['i = 1', 'while i <= 100:', '    print(i)', '    i += 1', ''].join('\n');
            await insertCode(snippet, 0);
            speak('Inserted a while loop from 1 to 100.', 'confirmation', 'tap');
        }
        else if (want === false) {
            speak('Insertion cancelled.', 'confirmation', 'tap');
        }
        else {
            speak('No confirmation received. Cancelled insertion.', 'confirmation', 'tap');
        }
        return;
    }
    // generic small snippet via textToCode (confirm if it looks large)
    const parsed = textToCode(transcript);
    if (parsed) {
        const lines = (parsed.code || '').split(/\r?\n/).filter(Boolean);
        if (lines.length > 3) {
            const want = await dialogInstance.askForConfirmation(`I will insert ${lines.length} lines of code. Proceed?`, 10000);
            if (want !== true) {
                speak('Cancelled insertion.', 'confirmation', 'tap');
                return;
            }
        }
        await insertCode(parsed.code, parsed.selectionOffsetLines);
        speak(parsed.feedback || 'Inserted code.', 'confirmation', 'tap');
        return;
    }
    // fallback
    speak('Sorry, I did not understand. Try "fix code", "diagnose error", or "insert a loop from 1 to 100".', 'confirmation', 'tap');
}
// deactivate
function deactivate() {
    try {
        if (state.panel)
            state.panel.dispose();
    }
    catch { }
    try {
        if (state.voiceServerClose)
            state.voiceServerClose();
    }
    catch { }
    try {
        for (const d of state.decorations)
            d.dispose();
    }
    catch { }
}
//# sourceMappingURL=extension.js.map