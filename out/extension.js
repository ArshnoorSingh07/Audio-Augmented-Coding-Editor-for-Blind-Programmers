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
const vscode = __importStar(require("vscode"));
// Optional OS TTS (fallback to webview TTS if unavailable)
let say;
try {
    say = require('say');
}
catch { }
let panel;
// ---------------- Speech helpers: de-dup, debounce, throttle, cancel ----------------
let lastContext;
let lastSpeakAt = 0;
let speakTimer;
function earcon(kind) {
    panel?.webview.postMessage({ type: 'earcon', kind });
}
function cancelPendingSpeak() {
    if (speakTimer)
        clearTimeout(speakTimer);
    speakTimer = undefined;
    try {
        say?.stop && say.stop();
    }
    catch { }
    panel?.webview.postMessage({ type: 'tts-cancel' });
}
function speakImmediate(text) {
    cancelPendingSpeak();
    const useSystem = vscode.workspace.getConfiguration().get('audioCoding.useSystemTTS', true);
    if (useSystem && say) {
        try {
            say.speak(text);
            lastSpeakAt = Date.now();
            return;
        }
        catch { }
    }
    panel?.webview.postMessage({ type: 'tts', text, interrupt: true });
    lastSpeakAt = Date.now();
}
function speakDebouncedUnique(text) {
    const debounceMs = vscode.workspace.getConfiguration().get('audioCoding.speechDebounceMs', 350);
    const throttleMs = vscode.workspace.getConfiguration().get('audioCoding.speechThrottleMs', 700);
    if (text === lastContext)
        return;
    lastContext = text;
    const since = Date.now() - lastSpeakAt;
    const delay = Math.max(debounceMs, since < throttleMs ? throttleMs - since : 0);
    cancelPendingSpeak();
    speakTimer = setTimeout(() => speakImmediate(text), delay);
}
// ---------------- Activation ----------------
function activate(context) {
    initAudioPanel();
    // Commands
    context.subscriptions.push(vscode.commands.registerCommand('audioCoding.toggleFollow', () => {
        followOn = !followOn;
        speakImmediate(`Follow cursor ${followOn ? 'on' : 'off'}.`);
    }), vscode.commands.registerCommand('audioCoding.summarizeHere', summarizeHere), vscode.commands.registerCommand('audioCoding.skimNext', () => skim(+1)), vscode.commands.registerCommand('audioCoding.skimPrev', () => skim(-1)), vscode.commands.registerCommand('audioCoding.errorNext', () => gotoDiagnostic(+1)), vscode.commands.registerCommand('audioCoding.errorPrev', () => gotoDiagnostic(-1)), vscode.commands.registerCommand('audioCoding.errorHere', () => announceDiagnosticAtCursor()), vscode.commands.registerCommand('audioCoding.applyQuickFix', () => applyQuickFixAtCursor()), vscode.commands.registerCommand('audioCoding.toggleSyntaxCoach', () => toggleSyntaxCoach()), vscode.commands.registerCommand('audioCoding.enableContinuousErrorSpeech', () => {
        setContinuous(true);
        speakImmediate('Continuous error speech on.');
    }), vscode.commands.registerCommand('audioCoding.disableContinuousErrorSpeech', () => {
        setContinuous(false);
        speakImmediate('Continuous error speech off.');
    }));
    // Follow cursor (debounced & calm)
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(async (e) => {
        if (!followOn)
            return;
        const editor = e.textEditor;
        if (!editor)
            return;
        if (isTypingRecently()) {
            earcon('info');
            return;
        }
        const pos = editor.selection.active;
        const summary = await contextSummary(editor.document, pos);
        if (summary) {
            earcon('info');
            speakDebouncedUnique(summary);
        }
        updatePresenceForActiveEditor(); // keep presence tone aligned with nearest error
        // React immediately for continuous error speech
        if (continuousOn)
            tickContinuous();
    }));
    // Presence tone only when there is at least one ERROR.
    context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(() => {
        updatePresenceForActiveEditor();
        if (continuousOn)
            tickContinuous();
    }));
    // Syntax coach + presence while typing
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
        lastTypeAt = Date.now();
        syntaxCoach(e);
        updatePresenceForActiveEditor();
        panel?.webview.postMessage({ type: 'typingPulse' }); // sustain presence tone while typing
        maybeSpeakAutoErrorHint(); // short one-shot hint at current line
        if (continuousOn)
            tickContinuous();
    }));
    // React to settings changes (period, enable, includeMessage)
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('audioCoding.continuousErrorSpeech.enabled') ||
            e.affectsConfiguration('audioCoding.continuousErrorSpeech.periodMs') ||
            e.affectsConfiguration('audioCoding.continuousErrorSpeech.includeMessage')) {
            refreshContinuousFromConfig();
        }
    }));
    // Start modes based on config
    refreshContinuousFromConfig();
    updatePresenceForActiveEditor();
}
function deactivate() {
    stopContinuous();
    cancelPendingSpeak();
}
// ---------------- Presence tone controller ----------------
let currentPresenceCat = 'none';
function updatePresenceForActiveEditor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        setPresence('none');
        return;
    }
    const diags = vscode.languages.getDiagnostics(editor.document.uri);
    const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
    if (!errors.length) {
        setPresence('none');
        return;
    }
    const nearest = nearestDiagnosticToCursor(editor, errors);
    const cat = categorizeError(nearest, editor.document.languageId);
    setPresence(cat);
}
function nearestDiagnosticToCursor(editor, list) {
    const pos = editor.selection.active;
    const byDist = (a, b) => distanceTo(pos, a.range) - distanceTo(pos, b.range);
    return list.slice().sort(byDist)[0];
}
function distanceTo(pos, r) {
    if (r.contains(pos))
        return 0;
    if (pos.isBefore(r.start))
        return r.start.line - pos.line;
    return pos.line - r.end.line;
}
function setPresence(cat) {
    if (currentPresenceCat === cat)
        return;
    currentPresenceCat = cat;
    panel?.webview.postMessage({ type: 'presence', on: cat !== 'none', cat });
}
// ---------------- Context summary ----------------
let followOn = true;
async function summarizeHere() {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return;
    const summary = await contextSummary(editor.document, editor.selection.active);
    speakImmediate(summary || 'No structure here.');
}
async function contextSummary(doc, pos) {
    const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri);
    if (!symbols || !symbols.length) {
        const line = doc.lineAt(pos.line).text.trim();
        if (!line)
            return undefined;
        return `line ${pos.line + 1}: ${line.slice(0, 80)}`;
    }
    const hit = findInnermostSymbol(symbols, pos);
    if (!hit)
        return undefined;
    const kind = vscode.SymbolKind[hit.kind].toLowerCase();
    const name = hit.name;
    const loc = hit.selectionRange.start.line + 1;
    const verbosity = vscode.workspace.getConfiguration().get('audioCoding.verbosity', 'concise');
    if (verbosity === 'minimal')
        return `${kind} ${name}`;
    if (verbosity === 'verbose')
        return `${kind} ${name}, starts at line ${loc}`;
    return `${kind} ${name}, line ${loc}`;
}
function findInnermostSymbol(symbols, pos) {
    let best;
    const visit = (s) => {
        if (s.range.contains(pos)) {
            best = s;
            s.children.forEach(visit);
        }
    };
    symbols.forEach(visit);
    return best;
}
// ---------------- Skimming by structure ----------------
async function skim(dir) {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return;
    const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', editor.document.uri);
    if (!symbols)
        return;
    const flat = [];
    const walk = (s) => { flat.push(s); s.children.forEach(walk); };
    symbols.forEach(walk);
    const list = flat
        .filter(s => [vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Class].includes(s.kind))
        .sort((a, b) => a.selectionRange.start.compareTo(b.selectionRange.start));
    const pos = editor.selection.active;
    let idx = list.findIndex(s => s.selectionRange.start.isAfter(pos));
    if (dir === -1)
        idx = (idx <= 0 ? list.length - 1 : idx - 1);
    if (dir === 1 && idx === -1)
        idx = 0;
    const target = list[Math.max(0, idx)];
    if (!target)
        return;
    const newPos = target.selectionRange.start;
    editor.selection = new vscode.Selection(newPos, newPos);
    editor.revealRange(target.selectionRange, vscode.TextEditorRevealType.InCenter);
    earcon('jump');
    speakImmediate(`${vscode.SymbolKind[target.kind].toLowerCase()} ${target.name}`);
}
// ---------------- Error-first workflow ----------------
function severityCounts(diags) {
    return {
        errors: diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length,
        warnings: diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length,
        infos: diags.filter(d => d.severity === vscode.DiagnosticSeverity.Information).length
    };
}
function sortedDiagnostics(doc) {
    return vscode.languages.getDiagnostics(doc.uri).slice()
        .sort((a, b) => a.range.start.compareTo(b.range.start));
}
let lastDiagIndex = -1;
async function gotoDiagnostic(dir) {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return;
    const list = sortedDiagnostics(editor.document);
    if (!list.length) {
        speakImmediate('No diagnostics in this file.');
        return;
    }
    const pos = editor.selection.active;
    // next index that is at or after cursor
    let idx = list.findIndex(d => !d.range.start.isBefore(pos));
    if (dir === -1)
        idx = (idx <= 0 ? list.length - 1 : idx - 1);
    if (dir === 1 && idx === -1)
        idx = 0;
    lastDiagIndex = idx;
    const d = list[idx];
    focusRange(editor, d.range);
    const cat = categorizeError(d, editor.document.languageId);
    earcon(cat);
    const msg = shortErrorText(d);
    speakImmediate(`Line ${d.range.start.line + 1}: ${msg}`);
}
async function announceDiagnosticAtCursor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return;
    const here = vscode.languages.getDiagnostics(editor.document.uri)
        .filter(d => d.range.contains(editor.selection.active));
    if (!here.length) {
        speakImmediate('No diagnostic at cursor.');
        return;
    }
    const d = here[0];
    const cat = categorizeError(d, editor.document.languageId);
    earcon(cat);
    const msg = shortErrorText(d);
    speakImmediate(`Line ${d.range.start.line + 1}: ${msg}`);
    const actions = await codeActionsFor(editor.document, d.range);
    const count = actions.length;
    if (count)
        speakImmediate(`${count} quick fix${count > 1 ? 'es' : ''} available. Press Control Alt Period to apply first.`);
}
async function applyQuickFixAtCursor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return;
    const here = vscode.languages.getDiagnostics(editor.document.uri)
        .filter(d => d.range.contains(editor.selection.active));
    if (!here.length) {
        speakImmediate('No diagnostic at cursor.');
        return;
    }
    const actions = await codeActionsFor(editor.document, here[0].range);
    if (!actions.length) {
        speakImmediate('No quick fix available.');
        return;
    }
    // Prefer isPreferred CodeAction; else first item (which may be a Command)
    const preferred = actions.find((a) => a.isPreferred === true);
    const first = preferred ?? actions[0];
    if (first.edit) {
        await vscode.workspace.applyEdit(first.edit);
        speakImmediate('Applied quick fix.');
    }
    else if (first.command) {
        await vscode.commands.executeCommand(first.command, ...(first.arguments ?? []));
        speakImmediate('Ran quick fix command.');
    }
    else {
        speakImmediate('Unable to apply quick fix.');
    }
}
function shortErrorText(d) {
    const kw = keywordFor(d);
    const clean = (d.message || '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/['"`].{20,}['"`]/g, '…')
        .slice(0, 120);
    return kw ? `${kw}. ${clean}` : clean;
}
function keywordFor(d) {
    const m = (d.message || '').toLowerCase();
    if (/expected ':'|missing ':'|colon/.test(m))
        return 'loop/if colon';
    if (/unexpected token|expected.*\)|missing\)|unterminated/.test(m))
        return 'paren';
    if (/unexpected token|expected.*\}|missing\}/.test(m))
        return 'brace';
    if (/cannot find name|not defined|undefined/.test(m))
        return 'undefined name';
    if (/cannot find module|module not found|importerror|no module named/.test(m))
        return 'import';
    if (/assignable|type.*mismatch|incompatible/.test(m))
        return 'type';
    if (/indentation/.test(m))
        return 'indent';
    if (/syntax/.test(m))
        return 'syntax';
    return '';
}
function focusRange(editor, range) {
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}
async function codeActionsFor(doc, range) {
    const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, range);
    return (actions || []);
}
// ---------------- Error categorization ----------------
function diagCodeString(d) {
    const c = d.code;
    if (c == null)
        return '';
    if (typeof c === 'string' || typeof c === 'number')
        return String(c);
    if (typeof c === 'object' && typeof c.value !== 'undefined')
        return String(c.value);
    return '';
}
function categorizeError(d, languageId) {
    const code = diagCodeString(d).toLowerCase();
    const msg = (d.message || '').toLowerCase();
    // Python
    if (languageId === 'python') {
        if (code.includes('reportsyntaxerror') || /syntaxerror|expected|invalid syntax/.test(msg))
            return 'errSyntax';
        if (code.includes('reportundefinedvariable') || /name .* is not defined|undefined variable/.test(msg))
            return 'errUndefined';
        if (code.includes('reportmissingimports') || /no module named|cannot import name|importerror/.test(msg))
            return 'errImport';
        if (code.includes('reportgeneraltypeissues') || /type|not assignable|incompatible/.test(msg))
            return 'errType';
    }
    // JS/TS
    if (languageId === 'javascript' || languageId === 'typescript') {
        if (/expected/.test(msg) || /(1005|1002|1109|1128|1160)/.test(code))
            return 'errSyntax';
        if (/cannot find name|not defined/.test(msg))
            return 'errUndefined';
        if (/cannot find module|module not found|import.*not found/.test(msg))
            return 'errImport';
        if (/not assignable to type|type .* is not assignable/.test(msg))
            return 'errType';
    }
    if (/syntax|expected|unexpected token/.test(msg))
        return 'errSyntax';
    if (/not defined|undefined name|cannot find name/.test(msg))
        return 'errUndefined';
    if (/cannot find module|module not found|importerror/.test(msg))
        return 'errImport';
    if (/type.*assignable|incompatible type|mismatch/.test(msg))
        return 'errType';
    return 'errGeneral';
}
// ---------------- Syntax coach (Python/JS gentle prompts) ----------------
let lastTypeAt = 0;
function isTypingRecently() { return Date.now() - lastTypeAt < 400; }
function toggleSyntaxCoach() {
    const cfg = vscode.workspace.getConfiguration();
    const current = cfg.get('audioCoding.syntaxCoach.enabled', true);
    cfg.update('audioCoding.syntaxCoach.enabled', !current, vscode.ConfigurationTarget.Global);
    speakImmediate(`Syntax coach ${!current ? 'enabled' : 'disabled'}.`);
}
let lastSpokenDiagKey = '';
function maybeSpeakAutoErrorHint() {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return;
    const line = editor.selection.active.line;
    const here = vscode.languages.getDiagnostics(editor.document.uri)
        .filter(d => d.severity === vscode.DiagnosticSeverity.Error)
        .filter(d => d.range.start.line <= line && d.range.end.line >= line);
    if (!here.length)
        return;
    const d = here[0];
    const key = `${d.range.start.line}:${d.range.start.character}:${d.message.slice(0, 40)}`;
    if (key === lastSpokenDiagKey)
        return;
    lastSpokenDiagKey = key;
    const kw = keywordFor(d) || 'error';
    speakImmediate(`${kw}. line ${d.range.start.line + 1}.`);
    earcon(categorizeError(d, editor.document.languageId));
}
function syntaxCoach(e) {
    const enabled = vscode.workspace.getConfiguration().get('audioCoding.syntaxCoach.enabled', true);
    if (!enabled)
        return;
    const doc = e.document;
    const lang = doc.languageId;
    // only act on newline insertions
    const change = e.contentChanges[e.contentChanges.length - 1];
    if (!change || !change.text.includes('\n'))
        return;
    try {
        // For newline insert, the "previous" line is the line where the newline was inserted
        const prevLineIdx = Math.max(0, change.range.start.line);
        const lineText = doc.lineAt(prevLineIdx).text.trim();
        if (lang === 'python') {
            const header = /^(def\s|class\s|if\s|elif\s|else\s*:|for\s|while\s|try\s*:|except\s|with\s)/.test(lineText.replace(/\s+/g, ' '));
            const hasColon = lineText.endsWith(':');
            if (header && !hasColon) {
                earcon('errSyntax');
                speakImmediate('loop or if needs colon. line ' + (prevLineIdx + 1));
            }
        }
        else if (lang === 'javascript' || lang === 'typescript') {
            if (/^function\s+[A-Za-z_$][\w$]*\s*\($/.test(lineText)) {
                earcon('errSyntax');
                speakImmediate('function needs brace. line ' + (prevLineIdx + 1));
            }
        }
    }
    catch { }
}
// ---------------- Continuous Error Speech ----------------
let continuousOn = false;
let cesTimer;
let lastContinuousKey = '';
function getCESCfg() {
    const cfg = vscode.workspace.getConfiguration();
    return {
        enabled: cfg.get('audioCoding.continuousErrorSpeech.enabled', true),
        periodMs: Math.max(200, cfg.get('audioCoding.continuousErrorSpeech.periodMs', 2000)),
        includeMessage: cfg.get('audioCoding.continuousErrorSpeech.includeMessage', true)
    };
}
function refreshContinuousFromConfig() {
    const { enabled } = getCESCfg();
    setContinuous(enabled);
}
function setContinuous(on) {
    if (on === continuousOn)
        return;
    continuousOn = on;
    if (on)
        startContinuous();
    else
        stopContinuous();
}
function startContinuous() {
    if (cesTimer)
        return;
    const { periodMs } = getCESCfg();
    cesTimer = setInterval(() => tickContinuous(), periodMs);
    tickContinuous(); // immediate
}
function stopContinuous() {
    if (cesTimer)
        clearInterval(cesTimer);
    cesTimer = undefined;
    lastContinuousKey = '';
}
function getErrorAtCursor(editor) {
    if (!editor)
        return null;
    const uri = editor.document.uri;
    const diags = vscode.languages.getDiagnostics(uri);
    const line = editor.selection.active.line;
    const errs = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error &&
        d.range.start.line <= line && d.range.end.line >= line);
    if (!errs.length)
        return null;
    // Prefer the shortest-range error (most specific)
    errs.sort((a, b) => (a.range.end.line - a.range.start.line) - (b.range.end.line - b.range.start.line));
    const chosen = errs[0];
    return { line, message: condenseDiagnosticMessage(chosen.message ?? ''), diag: chosen };
}
function tickContinuous() {
    if (!continuousOn)
        return;
    const editor = vscode.window.activeTextEditor;
    const hit = getErrorAtCursor(editor);
    if (!editor || !hit) {
        lastContinuousKey = '';
        return;
    }
    const { includeMessage, periodMs } = getCESCfg();
    // build text
    const cat = categorizeError(hit.diag, editor.document.languageId);
    const lineText = `Error at line ${hit.line + 1}`;
    const msgText = includeMessage ? `: ${hit.message.slice(0, 160)}` : '';
    const sayText = `${lineText}${msgText}`;
    // stable key so we keep repeating while same error persists
    const key = `${editor.document.uri.toString()}#${hit.line}#${hit.message}`;
    // Always re-speak each interval, but if the error changed, earcon it
    if (key !== lastContinuousKey) {
        earcon(cat);
    }
    lastContinuousKey = key;
    // hard interrupt & speak (ensures continuous)
    cancelPendingSpeak();
    speakImmediate(sayText);
    // if the period changed at runtime, reschedule
    if (cesTimer) {
        const realPeriod = cesTimer._repeat; // platform-specific; safer to refresh on config change
        void periodMs;
        void realPeriod;
    }
}
// ---------------- Webview & TTS plumbing ----------------
function initAudioPanel() {
    if (panel)
        return;
    panel = vscode.window.createWebviewPanel('audioCoding', 'Audio-Augmented Coding', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
    panel.webview.html = getWebviewHtml();
}
function getWebviewHtml() {
    return `<!doctype html>
<html><body style="margin:0;background:#111;color:#ddd;font:12px system-ui">
<script>
const ctx = new (window.AudioContext||window.webkitAudioContext)();

function ensureAudio() {
  if (ctx.state !== 'running') { ctx.resume().catch(()=>{}); }
}

function blip(freq, dur, gain){
  ensureAudio();
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type='sine'; o.frequency.value=freq;
  g.gain.value=gain; o.connect(g); g.connect(ctx.destination);
  o.start(); setTimeout(()=>{ try{o.stop()}catch(e){} }, dur*1000);
}
function chord(fs, dur, gain=0.08){ fs.forEach(f=>blip(f,dur,gain)); }

// Continuous presence tone (ON only when any error exists)
let presenceOsc = null;
let presenceGain = null;
let presenceOn = false;
let typingTimer = null;

const freqMap = { errSyntax:240, errUndefined:520, errImport:360, errType:680, errGeneral:420 };

function startPresence(cat){
  ensureAudio();
  const freq = freqMap[cat] || 420;
  if (presenceOn && presenceOsc) { presenceOsc.frequency.value = freq; return; }
  presenceOsc = ctx.createOscillator();
  presenceGain = ctx.createGain();
  presenceOsc.type = 'sine';
  presenceOsc.frequency.value = freq;
  presenceGain.gain.value = 0.0;
  presenceOsc.connect(presenceGain);
  presenceGain.connect(ctx.destination);
  presenceOsc.start();
  presenceOn = true;
}

function stopPresence(){
  presenceOn = false;
  try { if (presenceOsc) presenceOsc.stop(); } catch(e){}
  presenceOsc = null; presenceGain = null;
}

function sustainWhileTyping(){
  if (!presenceOn || !presenceGain) return;
  presenceGain.gain.cancelScheduledValues(ctx.currentTime);
  presenceGain.gain.setTargetAtTime(0.05, ctx.currentTime, 0.02);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(()=>presenceGain.gain.setTargetAtTime(0.0, ctx.currentTime, 0.05), 600);
}

function playEarcon(kind){
  ensureAudio();
  if(kind==='move'){ blip(1200,0.03,0.06); return; }
  if(kind==='jump'){ chord([600,900],0.07); return; }
  if(kind==='info'){ chord([880,1200],0.07); return; }
  if(kind==='errSyntax'){ chord([280,180],0.10); return; }
  if(kind==='errUndefined'){ blip(700,0.07,0.10); setTimeout(()=>blip(700,0.07,0.10),120); setTimeout(()=>blip(700,0.07,0.10),240); return; }
  if(kind==='errImport'){ blip(450,0.08,0.10); setTimeout(()=>blip(650,0.08,0.10),110); return; }
  if(kind==='errType'){ chord([500,750,1000],0.07); return; }
  if(kind==='errGeneral'){ blip(500,0.10,0.10); return; }
}

window.addEventListener('message', ev=>{
  const m = ev.data||{};
  if(m.type==='earcon') playEarcon(m.kind);
  if(m.type==='tts-cancel'){ try { speechSynthesis.cancel(); } catch(e){} }
  if(m.type==='tts'){
    try {
      ensureAudio();+
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(m.text);
      u.rate = 1.0; u.pitch = 1.0;
      speechSynthesis.speak(u);
    } catch(e){}
  }
  if(m.type==='presence'){ if(m.on){ startPresence(m.cat); } else { stopPresence(); } }
  if(m.type==='typingPulse'){ sustainWhileTyping(); }
});
</script>
</body></html>`;
}
// ---------------- Small utilities ----------------
function condenseDiagnosticMessage(m) {
    return m.replace(/\s+/g, ' ').trim().slice(0, 160);
}
//# sourceMappingURL=extension.js.map