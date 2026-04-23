// Native Wi-Fi scan bridge. The /api/* fetch hook + simMode flag are
// installed inline from user.html head (see bundle-data.mjs), so this
// module only handles loading the Capacitor wifi plugin on demand.

async function loadWifiPlugin() {
  try {
    const mod = await import('@capgo/capacitor-wifi');
    return mod.Wifi;
  } catch (err) {
    console.warn('[native-bridge] wifi plugin unavailable:', err?.message);
    return null;
  }
}

window.nativeScan = async function nativeScan({ timeoutMs = 8000 } = {}) {
  if (window.__DRI_SIM_MODE) throw new Error('sim-mode');
  const Wifi = await loadWifiPlugin();
  if (!Wifi) throw new Error('wifi-plugin-missing');

  try {
    const perm = await Wifi.requestPermissions({ permissions: ['location'] });
    if (perm?.location && perm.location !== 'granted') {
      throw new Error('location permission denied');
    }
  } catch (err) {
    console.warn('[native-bridge] requestPermissions:', err);
  }

  const waitForResults = new Promise((resolve, reject) => {
    let handle;
    const timer = setTimeout(async () => {
      try { (await handle)?.remove?.(); } catch {}
      try {
        const res = await Wifi.getAvailableNetworks();
        resolve(res?.networks || []);
      } catch {
        reject(new Error('scan-timeout'));
      }
    }, timeoutMs);
    handle = Wifi.addListener('networksScanned', (ev) => {
      clearTimeout(timer);
      (async () => { try { (await handle)?.remove?.(); } catch {} })();
      resolve(ev?.networks || []);
    });
  });

  await Wifi.startScan();
  const networks = await waitForResults;

  return networks
    .filter((n) => n.bssid)
    .map((n) => ({
      bssid: String(n.bssid).toLowerCase(),
      rssi: Number.isFinite(n.rssi) ? n.rssi : (Number.isFinite(n.level) ? n.level : -100),
    }));
};

console.log('[native-bridge] wifi module ready');
