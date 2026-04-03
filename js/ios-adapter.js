/**
 * IOS WASM Adapter — maps WASM engine to globals the tutorial HTML expects.
 * This is the ONLY bridge needed. No ios-engine-base.js or ios-engine-extended.js.
 */

/* ── Utility functions (previously in ios-engine-base.js) ── */
window.maskToBits = function(mask) {
  if (!mask) return 0;
  return mask.split('.').reduce((bits, octet) => bits + (parseInt(octet) >>> 0).toString(2).split('1').length - 1, 0);
};
window.cidrFromMask = window.maskToBits;
window.validIP = function(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => { const n = parseInt(p); return !isNaN(n) && n >= 0 && n <= 255 && String(n) === p; });
};
window.networkOf = function(ip, mask) {
  if (!ip || !mask) return '';
  const ipParts = ip.split('.').map(Number);
  const maskParts = mask.split('.').map(Number);
  return ipParts.map((p, i) => p & maskParts[i]).join('.');
};
window.getRenderedImageRect = function(img) {
  const cw = img.clientWidth, ch = img.clientHeight;
  const nw = img.naturalWidth, nh = img.naturalHeight;
  const ratio = Math.min(cw / nw, ch / nh);
  const w = nw * ratio, h = nh * ratio;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
};
window.fmtPwd = function(dev, pwd) { return pwd || ''; };

(async function() {
  'use strict';

  const Engine = await IOSEngineModule({
    locateFile: function(path) { return 'dist/' + path + '?v=' + Date.now(); }
  });
  console.log('[WASM] IOS Engine loaded');

  // Initialize topology from tutorial constants
  Engine.initTopology(ROUTERS, PCS, TOPO_IFACES, TOPO_LINKS);

  // Create devices
  const cellId = typeof CELL_ID !== 'undefined' ? CELL_ID : 'lab1';
  for (const rKey of ROUTERS) Engine.createDevice(cellId, rKey);
  for (const pcKey of PCS) Engine.createPC(cellId, pcKey);

  // ── Global function mappings ──
  window.handleCmd = (devId, raw) => {
    const trimmed = raw.trim().toLowerCase();
    // Shim: accept 'set pfs' in ipsec-profile mode (not yet in WASM engine)
    if (trimmed === 'set pfs' || trimmed.startsWith('set pfs ')) {
      const mode = Engine.getDeviceMode(devId);
      if (mode === 'config-ipsec-profile') return [];
    }
    const result = Engine.handleCmd(devId, raw);
    // Shim: inject Profile + Uptime into 'show crypto session' output
    if (trimmed.match(/^show\s+crypto\s+session/)) {
      const crypto = Engine.getDeviceCryptoState(devId);
      const ifaces = Engine.getDeviceInterfaces(devId) || {};
      // Find profile name from ipsec profile → ikev2 profile chain
      let profileName = '';
      const t0 = ifaces['Tunnel0'];
      if (t0 && t0.tunnelConfig && t0.tunnelConfig.ipsecProfile) {
        const ipProf = crypto.ipsecProfiles?.[t0.tunnelConfig.ipsecProfile];
        if (ipProf && ipProf.ikev2Profile) profileName = ipProf.ikev2Profile;
      }
      // Find the "Interface:" line and inject Profile + Uptime after it
      for (let i = 0; i < result.length; i++) {
        const txt = typeof result[i] === 'object' ? result[i].text : result[i];
        if (txt && txt.startsWith('Interface:')) {
          const upSec = crypto.saEstablishedAt > 0 ? Math.floor((Date.now() - crypto.saEstablishedAt) / 1000) : 0;
          const hh = String(Math.floor(upSec / 3600)).padStart(2, '0');
          const mm = String(Math.floor((upSec % 3600) / 60)).padStart(2, '0');
          const ss = String(upSec % 60).padStart(2, '0');
          const extra = [];
          if (profileName) extra.push({text: 'Profile: ' + profileName, cls: ''});
          extra.push({text: 'Uptime: ' + hh + ':' + mm + ':' + ss, cls: ''});
          result.splice(i + 1, 0, ...extra);
          break;
        }
      }
    }
    return result;
  };
  window.handlePcCmd = (devId, raw) => Engine.handlePcCmd(devId, raw);
  window.getPrompt = (dev) => {
    if (typeof dev === 'string') return Engine.getPrompt(dev);
    return Engine.getPrompt(dev._devId || (dev._cellId || dev.cellId) + '_' + (dev._rKey || dev.rKey));
  };
  window.handleTabComplete = (devId, text) => Engine.handleTabComplete(devId, text);
  window.isVPNTunnelUp = (cellId, rA, rB) => Engine.isVPNTunnelUp(cellId, rA, rB);
  window.checkPPKStatus = (cellId, rA, rB) => Engine.checkPPKStatus(cellId, rA, rB);
  window.checkMLKEMStatus = (cellId, rA, rB) => {
    // JS shim: WASM engine doesn't export checkMLKEMStatus
    // Check if tunnel is up AND both routers have ML-KEM in their proposals
    const tunnel = Engine.isVPNTunnelUp(cellId, rA, rB);
    if (!tunnel) return null;
    const cA = Engine.getDeviceCryptoState(cellId + '_' + rA);
    const cB = Engine.getDeviceCryptoState(cellId + '_' + rB);
    if (!cA || !cB) return null;
    // Find any proposal with a pqc/keyExchange containing mlkem
    const propsA = cA.ikev2Proposals || {};
    const propsB = cB.ikev2Proposals || {};
    let algA = null, algB = null;
    for (const name in propsA) {
      const kx = propsA[name].keyExchange || propsA[name].pqc;
      if (kx && /mlkem/i.test(kx)) { algA = kx; break; }
    }
    for (const name in propsB) {
      const kx = propsB[name].keyExchange || propsB[name].pqc;
      if (kx && /mlkem/i.test(kx)) { algB = kx; break; }
    }
    if (algA && algB) {
      const alg = algA.toUpperCase().replace('MLKEM', 'ML-KEM-').replace('--', '-');
      return { algorithm: alg };
    }
    return null;
  };
  window.isReachable = (cellId, src, dst) => Engine.isReachable(cellId, src, dst);
  window.recalcOSPF = (cellId) => Engine.recalcOSPF(cellId);
  window.escHtml = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  window.createDevice = (cellId, rKey) => Engine.createDevice(cellId, rKey);
  window.createPC = (cellId, pcKey) => Engine.createPC(cellId, pcKey);
  window.genRunConfig = (dev) => Engine.genRunConfig(typeof dev === 'string' ? dev : dev._devId);
  window.resetDevice = (dev) => Engine.resetDevice(typeof dev === 'string' ? dev : dev._devId);
  window.restoreDevice = () => false; // No localStorage persistence in WASM

  // IOS namespace for tutorial compatibility
  window.IOS = {
    genCryptoConfig: (dev) => {
      const devId = typeof dev === 'string' ? dev : (dev._devId || dev.cellId + '_' + dev.rKey);
      const lines = Engine.genCryptoConfig(devId);
      return lines.map(t => ({text: t}));
    }
  };

  // ── History index state (persists across Proxy accesses) ──
  const _histIdx = {};

  // ── iosDevices proxy — backed by WASM state ──
  window.iosDevices = new Proxy({}, {
    get(target, devId) {
      if (typeof devId !== 'string') return undefined;
      // Cache-busting: always read fresh from WASM
      return {
        _devId: devId,
        _cellId: devId.split('_')[0],
        _rKey: devId.split('_').slice(1).join('_'),
        _type: PCS.includes(devId.split('_').slice(1).join('_')) ? 'pc' : 'router',
        get mode() { return Engine.getDeviceMode(devId); },
        get hostname() { return Engine.getHostname(devId); },
        get crypto() { return Engine.getDeviceCryptoState(devId); },
        get interfaces() { return Engine.getDeviceInterfaces(devId); },
        get ip() { return this._type === 'pc' ? '' : ''; },
        get history() {
          const size = Engine.getHistorySize(devId);
          const arr = [];
          for (let i = 0; i < size; i++) arr.push(Engine.getHistoryAt(devId, i));
          return arr;
        },
        get histIdx() { return _histIdx[devId] !== undefined ? _histIdx[devId] : -1; },
        set histIdx(v) { _histIdx[devId] = v; }
      };
    },
    has(target, devId) { return true; },
    set(target, devId, value) { return true; },
    // Allow property setting on returned objects (e.g., dev.histIdx = 5)
    // This is handled by the getter/setter on the returned object itself
  });

  window.iosActiveTab = {};

  // ── handleContextHelp — calls WASM for data, JS for DOM ──
  window.handleContextHelp = function(devId, rKey, text) {
    const entries = Engine.handleHelp(devId, text);
    displayHelp(devId, rKey, text, entries);
  };

  // ── displayHelp — DOM rendering (stays in JS) ──
  function displayHelp(devId, rKey, inputText, helpEntries) {
    const outEl = document.getElementById('ios-out-' + devId);
    if (!outEl) return;
    const prompt = Engine.getPrompt(devId);

    // Freeze current line
    const activeLine = document.getElementById('ios-active-' + devId);
    if (activeLine) {
      const staticLine = document.createElement('div');
      staticLine.className = 'ios-line';
      staticLine.innerHTML = '<span class="ios-prompt-echo">' + escHtml(prompt) + '</span> <span class="ios-cmd-echo">' + escHtml(inputText) + '?</span>';
      outEl.replaceChild(staticLine, activeLine);
    }

    if (helpEntries.length === 0) {
      const div = document.createElement('div');
      div.className = 'ios-line ios-err';
      div.textContent = '% Unrecognized command';
      outEl.appendChild(div);
    } else {
      helpEntries.forEach(([cmd, desc]) => {
        const div = document.createElement('div');
        div.className = 'ios-line';
        div.textContent = '  ' + cmd.padEnd(22) + desc;
        outEl.appendChild(div);
      });
    }

    // New active line
    const newActive = document.createElement('div');
    newActive.className = 'ios-active-line';
    newActive.id = 'ios-active-' + devId;
    const input = document.getElementById('ios-in-' + devId);
    newActive.innerHTML = '<span class="ios-prompt-echo">' + escHtml(prompt) + '</span><span class="ios-input-mirror" id="ios-mirror-' + devId + '">' + escHtml(input ? input.value : '') + '</span><span class="ios-cursor" id="ios-cursor-' + devId + '"></span>';
    outEl.appendChild(newActive);
    outEl.scrollTop = outEl.scrollHeight;
  }

  // Show WASM badge
  const hdr = document.querySelector('.ios-header span');
  if (hdr && !hdr.innerHTML.includes('WASM')) {
    hdr.innerHTML = hdr.innerHTML + ' <span style="background:#238636;color:#fff;padding:1px 6px;border-radius:8px;font-size:9px;margin-left:6px;">WASM</span>';
  }

  console.log('[WASM] Adapter ready. All globals mapped.');
  document.dispatchEvent(new Event('wasm-ready'));
})();
