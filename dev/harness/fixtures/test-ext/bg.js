// Fixture for the integration tests: storage, messaging, console and network from an extension.
var bgMarker = 'background-realm';
browser.storage.local.get('greeting').then((r) => {
  if (!r.greeting) browser.storage.local.set({ greeting: 'hi', count: 1, nested: { a: [1, 2] } });
});
browser.storage.session?.set({ sess: 'only-in-memory' });
console.log('test-ext background started');
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.cmd === 'echo') return Promise.resolve({ echo: msg.value, from: sender.url || sender.id });
  if (msg && msg.cmd === 'throw') { setTimeout(() => { throw new Error('test-ext background boom'); }); return Promise.resolve('scheduled'); }
  if (msg && msg.cmd === 'log') { console.warn('test-ext bg says', msg.value); return Promise.resolve('logged'); }
  if (msg && msg.cmd === 'fetch') return fetch(msg.url).then((r) => r.text()).then((t) => ({ len: t.length }));
  if (msg && msg.cmd === 'get') return browser.storage.local.get(null);
});
browser.storage.onChanged.addListener((changes, area) => { console.log('test-ext storage changed', area, Object.keys(changes).join(',')); });
// a write of {fetchUrl} from outside (ext_storage_set) makes the background fetch it: extension-made traffic
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.fetchUrl?.newValue) fetch(changes.fetchUrl.newValue).then((r) => r.text()).then((t) => console.log('test-ext fetched', t.length));
});
