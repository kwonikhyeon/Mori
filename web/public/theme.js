// Applies the saved theme before the first paint (spec §3 #118). It lives
// in its own file because the CSP allows no inline scripts.
(function () {
  try {
    var t = localStorage.getItem('mori.theme')
    if (t === '"light"' || t === '"dark"') document.documentElement.dataset.theme = JSON.parse(t)
  } catch (e) {}
})()
