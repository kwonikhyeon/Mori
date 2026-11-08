// Placeholder page: shows server info and completes pairing from a
// /pair#code=XXXX-XXXX link until the real UI is built.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var code = (location.hash.match(/code=([0-9A-Za-z-]+)/) || [])[1];

  fetch("/api/hello", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (h) {
      $("host").textContent = h.host + " · " + h.version + (h.paired ? " · 이 기기는 페어링되어 있습니다" : "");
    })
    .catch(function () { $("host").textContent = "서버 정보를 가져오지 못했습니다."; });

  if (!code) return;
  var form = $("pair");
  form.hidden = false;
  $("name").value = guessName();
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    $("result").textContent = "페어링 중…";
    fetch("/api/pair", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code, name: $("name").value.trim() })
    }).then(function (r) {
      if (r.status === 204) {
        history.replaceState(null, "", "/");
        form.hidden = true;
        $("result").textContent = "페어링되었습니다.";
        return;
      }
      return r.json().then(function (body) {
        $("result").textContent = (body.error && body.error.message) || ("실패했습니다 (" + r.status + ")");
      });
    }).catch(function () { $("result").textContent = "서버에 연결하지 못했습니다."; });
  });

  function guessName() {
    var ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return "iPhone";
    if (/iPad/.test(ua)) return "iPad";
    if (/Android/.test(ua)) return "Android";
    if (/Windows/.test(ua)) return "Windows PC";
    if (/Macintosh/.test(ua)) return "Mac";
    return "기기";
  }
})();
