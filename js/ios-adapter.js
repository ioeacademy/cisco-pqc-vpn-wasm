/**
 * IOS WASM Adapter — maps WASM engine to globals the tutorial HTML expects.
 * This is the ONLY bridge needed. No ios-engine-base.js or ios-engine-extended.js.
 */
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
  window.handleCmd = (devId, raw) => Engine.handleCmd(devId, raw);
  window.handlePcCmd = (devId, raw) => Engine.handlePcCmd(devId, raw);
  window.getPrompt = (dev) => {
    if (typeof dev === 'string') return Engine.getPrompt(dev);
    return Engine.getPrompt(dev._devId || (dev._cellId || dev.cellId) + '_' + (dev._rKey || dev.rKey));
  };
  window.handleTabComplete = (devId, text) => Engine.handleTabComplete(devId, text);
  window.isVPNTunnelUp = (cellId, rA, rB) => Engine.isVPNTunnelUp(cellId, rA, rB);
  window.checkPPKStatus = (cellId, rA, rB) => Engine.checkPPKStatus(cellId, rA, rB);
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
