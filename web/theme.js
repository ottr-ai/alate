// alate theme bootstrap: a classic script in <head>, so it runs before first paint.
// Same-origin file (server CSP bans inline scripts). Reads the stored choice and
// resolves "system" against the OS preference; web/app.js owns the switch UI.
'use strict';
let theme = 'system';
try { theme = localStorage.getItem('alate.theme') || 'system'; } catch { /* fresh context */ }
if (theme !== 'light' && theme !== 'dark') theme = 'system';
document.documentElement.dataset.theme =
  theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
