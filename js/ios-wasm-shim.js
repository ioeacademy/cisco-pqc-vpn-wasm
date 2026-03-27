/**
 * IOS WASM Engine Shim
 *
 * Loads the WASM engine and overrides handleCmd/handlePcCmd with WASM versions.
 * Help (?), Tab completion, and CMD_TREE stay in JavaScript.
 * Falls back to JS engine if WASM fails to load.
 */
(async function() {
  'use strict';

  // Save original JS functions
  const jsHandleCmd = window.handleCmd;
  const jsHandlePcCmd = window.handlePcCmd;
  const jsCreateDevice = window.createDevice;

  let engine = null;
  let wasmReady = false;

  try {
    engine = await IOSEngineModule();
    console.log('[WASM] IOS Engine loaded successfully');

    // Initialize topology from the global constants defined in tutorial HTML
    const topoIfaces = {};
    for (const rKey of ROUTERS) {
      topoIfaces[rKey] = TOPO_IFACES[rKey].map(ti => ({
        name: ti.name,
        ip: ti.ip || '',
        mask: ti.mask || ''
      }));
    }
    const topoLinks = TOPO_LINKS.map(l => ({
      r1: l.r1, iface1: l.iface1,
      r2: l.r2, iface2: l.iface2
    }));

    engine.initTopology(ROUTERS, PCS, topoIfaces, topoLinks);

    // Create devices in WASM engine
    const cellId = typeof CELL_ID !== 'undefined' ? CELL_ID : 'lab1';
    for (const rKey of ROUTERS) {
      engine.createDevice(cellId, rKey);
    }
    for (const pcKey of PCS) {
      engine.createPC(cellId, pcKey);
    }

    wasmReady = true;
    console.log('[WASM] Devices initialized. WASM engine active.');

    // Show WASM badge in header
    const hdr = document.querySelector('.ios-header span');
    if (hdr) {
      hdr.innerHTML = hdr.innerHTML.replace('Quantum-Resistant VPN',
        'Quantum-Resistant VPN <span style="background:#238636;color:#fff;padding:1px 6px;border-radius:8px;font-size:9px;margin-left:6px;">WASM</span>');
    }

  } catch(e) {
    console.warn('[WASM] Failed to load, falling back to JS engine:', e.message);
    return; // JS engine stays active
  }

  // Override handleCmd to use WASM
  // But keep ? help and Tab complete in JS (they need CMD_TREE + DOM)
  if (typeof window.handleCmd === 'function') {
    const origHandleCmd = window.handleCmd;

    window.handleCmd = function(devId, rawCmd) {
      if (!wasmReady) return origHandleCmd(devId, rawCmd);

      // Let ? help stay in JS
      if (rawCmd.trim().endsWith('?')) {
        return origHandleCmd(devId, rawCmd);
      }

      try {
        const result = engine.handleCmd(devId, rawCmd);
        const lines = [];
        for (let i = 0; i < result.size(); i++) {
          const line = result.get(i);
          lines.push({ text: line.text, cls: line.cls });
        }
        result.delete();

        // Sync mode changes back to JS device object for prompt/help
        syncWasmToJs(devId);

        return lines;
      } catch(e) {
        console.error('[WASM] handleCmd error, falling back to JS:', e);
        return origHandleCmd(devId, rawCmd);
      }
    };
  }

  // Sync WASM device state back to JS (for prompt, help tree, etc.)
  function syncWasmToJs(devId) {
    // The JS engine still maintains device state for ? help and tab complete
    // We need to sync the mode at minimum
    const prompt = engine.getPrompt(devId);
    const jsDev = typeof iosDevices !== 'undefined' ? iosDevices[devId] : null;
    if (!jsDev) return;

    // Parse prompt to determine mode
    if (prompt.endsWith('>')) jsDev.mode = 'user';
    else if (prompt.endsWith('#') && !prompt.includes('(')) jsDev.mode = 'privileged';
    else if (prompt.includes('(config)#')) jsDev.mode = 'global';
    else if (prompt.includes('(config-if)#')) jsDev.mode = 'interface';
    else if (prompt.includes('(config-line)#')) jsDev.mode = 'line';
    else if (prompt.includes('(config-router)#')) jsDev.mode = 'router';
    else if (prompt.includes('(config-isakmp)#')) jsDev.mode = 'config-isakmp';
    else if (prompt.includes('(cfg-crypto-trans)#')) jsDev.mode = 'config-crypto-trans';
    else if (prompt.includes('(config-crypto-map)#')) jsDev.mode = 'config-crypto-map';
    else if (prompt.includes('(config-ikev2-proposal)#')) jsDev.mode = 'config-ikev2-proposal';
    else if (prompt.includes('(config-ikev2-policy)#')) jsDev.mode = 'config-ikev2-policy';
    else if (prompt.includes('(config-ikev2-keyring)#') && !prompt.includes('peer')) jsDev.mode = 'config-ikev2-keyring';
    else if (prompt.includes('(config-ikev2-keyring-peer)#')) jsDev.mode = 'config-ikev2-keyring-peer';
    else if (prompt.includes('(config-ikev2-profile)#')) jsDev.mode = 'config-ikev2-profile';

    // Sync hostname from prompt
    const hostnameMatch = prompt.match(/^([^(>#]+)/);
    if (hostnameMatch) jsDev.hostname = hostnameMatch[1];
  }

})();
