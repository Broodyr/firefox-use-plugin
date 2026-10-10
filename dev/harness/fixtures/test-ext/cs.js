var csMarker = 'content-realm';
console.log('test-ext content script on', location.pathname);
if (location.search.includes('cserror')) setTimeout(() => { throw new Error('test-ext content boom'); });
