// A second of a quiet tone as a WAV, for the stand-in players to play.
function tone() {
  const rate = 8000;
  const samples = rate;
  const data = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (at, s) => [...s].forEach((c, i) => data.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  data.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVEfmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, rate, true);
  data.setUint32(28, rate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  text(36, "data");
  data.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) data.setInt16(44 + i * 2, Math.sin(i / 8) * 200, true);
  return URL.createObjectURL(new Blob([data], { type: "audio/wav" }));
}
