// Runs before the page renders so the correct theme shows immediately.
(function () {
  var pref = "system";
  try { pref = localStorage.getItem("campuscash:theme") || "system"; } catch (e) {}
  var dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themePref = pref;
})();
