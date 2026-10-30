// Theme chosen by the user, applied before the page is drawn (no flash of the wrong colours). Loaded as a file: the
// security policy allows no code inside the page itself.
try { document.documentElement.dataset.theme = localStorage.getItem('pk_theme') || 'dark'; } catch(e){}
