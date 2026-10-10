browser.runtime.onMessage.addListener((m) => Promise.resolve({ from: "page", echo: m && m.v }));
