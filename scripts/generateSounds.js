// scripts/generateSounds.js
const fs = require("fs");
const path = require("path");

const outDir = path.join(__dirname, "..", "media", "sounds");
fs.mkdirSync(outDir, { recursive: true });

function writeTone(filename, freq = 440, durMs = 120, volume = 0.5, type = "sine", sampleRate = 44100) {
  const n = Math.floor((sampleRate * durMs) / 1000);
  const buffer = Buffer.alloc(44 + n * 2); // 16-bit PCM mono

  function wstr(off, str) { buffer.write(str, off, "ascii"); }
  function w32(off, v) { buffer.writeUInt32LE(v, off); }
  function w16(off, v) { buffer.writeUInt16LE(v, off); }

  // --- WAV header ---
  wstr(0, "RIFF");
  w32(4, 36 + n * 2);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  w32(16, 16);
  w16(20, 1); // PCM
  w16(22, 1); // channels
  w32(24, sampleRate);
  w32(28, sampleRate * 2);
  w16(32, 2);
  w16(34, 16);
  wstr(36, "data");
  w32(40, n * 2);

  // --- Samples ---
  let phase = 0, dt = (2 * Math.PI * freq) / sampleRate;
  for (let i = 0; i < n; i++) {
    let sample;
    if (type === "square") sample = Math.sign(Math.sin(phase));
    else sample = Math.sin(phase);
    phase += dt;

    // envelope fade in/out
    const fade = Math.min(i / (0.02 * sampleRate), (n - i) / (0.02 * sampleRate), 1.0);
    const s = Math.max(-1, Math.min(1, sample * volume * fade));
    buffer.writeInt16LE(s * 32767, 44 + i * 2);
  }

  fs.writeFileSync(path.join(outDir, filename), buffer);
  console.log("Wrote", filename);
}

writeTone("tap.wav", 880, 100, 0.6, "sine");
writeTone("buzz.wav", 120, 220, 0.6, "square");
writeTone("knock.wav", 220, 120, 0.6, "sine");
writeTone("blip.wav", 1000, 90, 0.6, "sine");
writeTone("glitch.wav", 1600, 80, 0.6, "square");
writeTone("pop.wav", 300, 90, 0.6, "sine");
